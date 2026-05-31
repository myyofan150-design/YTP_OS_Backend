// src/controllers/todo-lists.controller.ts

import { Request, Response } from "express";
import { q, run, pool, RowDataPacket } from "../lib/db";
import { logActivity } from "../lib/logger";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function attachMembersToTasks(tasks: RowDataPacket[]): Promise<RowDataPacket[]> {
  if (tasks.length === 0) return tasks;
  const ids = tasks.map(t => Number(t["id"]));
  const ph  = ids.map(() => "?").join(",");
  const rows = await q<RowDataPacket>(
    `SELECT tm.task_id AS taskId, u.id, u.name,
            COALESCE(u.avatar_url, e.photo_url) AS avatarUrl
     FROM todo_task_members tm
     JOIN users u ON u.id = tm.user_id
     LEFT JOIN employees e ON e.user_id = u.id
     WHERE tm.task_id IN (${ph})
     ORDER BY tm.created_at ASC`,
    ids
  );
  const byTask: Record<number, Array<{id:number;name:string;avatarUrl?:string|null}>> = {};
  for (const r of rows) {
    const tid = Number(r["taskId"]);
    if (!byTask[tid]) byTask[tid] = [];
    byTask[tid].push({ id: Number(r["id"]), name: String(r["name"]), avatarUrl: r["avatarUrl"] ?? null });
  }
  return tasks.map(t => ({ ...t, members: byTask[Number(t["id"])] ?? [] }));
}

async function fetchListMembers(listId: number) {
  return q<RowDataPacket>(
    `SELECT u.id, u.uuid AS userUuid, u.name, u.email,
            COALESCE(u.avatar_url, e.photo_url) AS avatarUrl,
            lm.added_by AS addedBy, lm.created_at AS addedAt
     FROM todo_list_members lm
     JOIN users u ON u.id = lm.user_id
     LEFT JOIN employees e ON e.user_id = u.id
     WHERE lm.list_id = ?
     ORDER BY lm.created_at ASC`,
    [listId]
  );
}

async function syncListMembers(listId: number, addedBy: number, userIds: number[]) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute("DELETE FROM todo_list_members WHERE list_id = ?", [listId]);
    for (const uid of userIds) {
      await conn.execute(
        "INSERT IGNORE INTO todo_list_members (list_id, user_id, added_by) VALUES (?, ?, ?)",
        [listId, uid, addedBy]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Correlated-subquery SELECTs for list rows — avoids GROUP BY + ONLY_FULL_GROUP_BY issues
const LIST_SEL = `
  l.id, l.uuid, l.group_id AS groupId, l.name, l.color,
  l.is_favorite AS isFavorite, l.assigned_to AS assignedTo,
  l.sort_order AS sortOrder, l.created_by AS createdBy, l.created_at AS createdAt,
  g.name AS groupName, g.uuid AS groupUuid, g.color AS groupColor,
  (SELECT COUNT(*) FROM todo_tasks t WHERE t.list_id = l.id) AS taskCount,
  (SELECT COUNT(*) FROM todo_tasks t WHERE t.list_id = l.id AND t.status = 'pending') AS pendingCount,
  (SELECT COUNT(*) FROM todo_list_members lm WHERE lm.list_id = l.id) AS memberCount
`;

// ─── listLists ────────────────────────────────────────────────────────────────

export async function listLists(req: Request, res: Response): Promise<void> {
  try {
    const userId  = req.user!.id;
    const isAdmin = ["SUPER_ADMIN", "ADMIN"].includes(req.user!.role);
    const showAll = isAdmin && req.query["all"] === "true";

    const conditions: string[] = [];
    const params: unknown[]    = [];

    if (!showAll) {
      // Own lists OR single-assigned OR shared via todo_list_members
      conditions.push(
        "(l.created_by = ? OR l.assigned_to = ? OR EXISTS (SELECT 1 FROM todo_list_members lm WHERE lm.list_id = l.id AND lm.user_id = ?))"
      );
      params.push(userId, userId, userId);
    }

    if (req.query["groupId"]) {
      const gRows = await q<RowDataPacket>(
        "SELECT id FROM todo_groups WHERE uuid = ?",
        [String(req.query["groupId"])]
      );
      conditions.push("l.group_id = ?");
      params.push(gRows[0] ? gRows[0]["id"] : 0);
    }

    if (req.query["isFavorite"] === "true") {
      conditions.push("l.is_favorite = 1");
    }

    // Optionally show only lists shared with the user (not owned)
    if (req.query["sharedWithMe"] === "true") {
      conditions.push(
        "l.created_by != ? AND EXISTS (SELECT 1 FROM todo_list_members lm WHERE lm.list_id = l.id AND lm.user_id = ?)"
      );
      params.push(userId, userId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const lists = await q<RowDataPacket>(
      `SELECT ${LIST_SEL}
       FROM todo_lists l
       LEFT JOIN todo_groups g ON g.id = l.group_id
       ${where}
       ORDER BY l.sort_order ASC`,
      params
    );

    res.json({ success: true, message: "OK", data: lists });
  } catch (err) {
    console.error("[todo-lists/list]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── createList ───────────────────────────────────────────────────────────────

export async function createList(req: Request, res: Response): Promise<void> {
  try {
    const { name, groupId, color, assignedTo, memberUserIds } = req.body as Record<string, unknown>;
    if (!name) {
      res.status(400).json({ success: false, message: "name is required" }); return;
    }

    const userId = req.user!.id;
    let groupDbId: number | null = null;

    if (groupId) {
      const gRows = await q<RowDataPacket>(
        "SELECT id FROM todo_groups WHERE uuid = ? AND created_by = ?",
        [String(groupId), userId]
      );
      if (!gRows[0]) {
        res.status(404).json({ success: false, message: "Group not found" }); return;
      }
      groupDbId = Number(gRows[0]["id"]);
    }

    const result = await run(
      "INSERT INTO todo_lists (name, group_id, color, assigned_to, created_by) VALUES (?, ?, ?, ?, ?)",
      [
        String(name),
        groupDbId,
        color      ? String(color)       : "#6366F1",
        assignedTo ? Number(assignedTo)  : null,
        userId,
      ]
    );

    const listId = result.insertId;

    // Insert optional multi-employee members
    const ids = Array.isArray(memberUserIds)
      ? (memberUserIds as unknown[]).map(Number).filter(n => !isNaN(n) && n > 0)
      : [];
    if (ids.length > 0) {
      await syncListMembers(listId, userId, ids);
    }

    const rows = await q<RowDataPacket>(
      `SELECT ${LIST_SEL}
       FROM todo_lists l
       LEFT JOIN todo_groups g ON g.id = l.group_id
       WHERE l.id = ?`,
      [listId]
    );

    const members = await fetchListMembers(listId);
    await logActivity(userId, "todo.list_created", "todo_list", listId, undefined, { name }, req.ip);
    res.status(201).json({ success: true, message: "List created", data: { ...rows[0], members } });
  } catch (err) {
    console.error("[todo-lists/create]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── getList ──────────────────────────────────────────────────────────────────

export async function getList(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;
    const isAdmin  = ["SUPER_ADMIN", "ADMIN"].includes(req.user!.role);

    const listRows = await q<RowDataPacket>(
      `SELECT l.id, l.uuid, l.group_id AS groupId, l.name, l.color,
              l.is_favorite AS isFavorite, l.assigned_to AS assignedTo,
              l.sort_order AS sortOrder, l.created_by AS createdBy, l.created_at AS createdAt,
              g.name AS groupName, g.uuid AS groupUuid
       FROM todo_lists l
       LEFT JOIN todo_groups g ON g.id = l.group_id
       WHERE l.uuid = ?`,
      [uuid]
    );
    if (!listRows[0]) { res.status(404).json({ success: false, message: "List not found" }); return; }

    const list = listRows[0];
    const listId = Number(list["id"]);

    // Check membership
    const isMember = await q<RowDataPacket>(
      "SELECT 1 FROM todo_list_members WHERE list_id = ? AND user_id = ?",
      [listId, userId]
    );

    if (
      !isAdmin &&
      Number(list["createdBy"]) !== userId &&
      Number(list["assignedTo"]) !== userId &&
      isMember.length === 0
    ) {
      res.status(403).json({ success: false, message: "Forbidden" }); return;
    }

    const tasks = await q<RowDataPacket>(
      `SELECT
         t.id, t.uuid, t.title, t.status, t.priority,
         t.due_date AS dueDate, t.bg_color AS bgColor, t.is_favorite AS isFavorite,
         t.sort_order AS sortOrder, t.assigned_to AS assignedTo, t.completed_at AS completedAt,
         COUNT(s.id) AS subtaskTotal,
         COALESCE(SUM(s.status = 'completed'), 0) AS subtaskDone
       FROM todo_tasks t
       LEFT JOIN todo_subtasks s ON s.task_id = t.id
       WHERE t.list_id = ?
       GROUP BY t.id
       ORDER BY
         CASE t.status WHEN 'completed' THEN 1 ELSE 0 END ASC,
         t.sort_order ASC,
         CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END ASC`,
      [listId]
    );

    const tasksWithMeta    = tasks.map(t => ({ ...t, listUuid: list["uuid"] }));
    const tasksWithMembers = await attachMembersToTasks(tasksWithMeta);
    const members          = await fetchListMembers(listId);

    res.json({ success: true, message: "OK", data: { ...list, members, tasks: tasksWithMembers } });
  } catch (err) {
    console.error("[todo-lists/get]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── updateList ───────────────────────────────────────────────────────────────

export async function updateList(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;

    const rows = await q<RowDataPacket>(
      "SELECT id FROM todo_lists WHERE uuid = ? AND created_by = ?",
      [uuid, userId]
    );
    if (!rows[0]) { res.status(404).json({ success: false, message: "List not found" }); return; }

    const listId = Number(rows[0]["id"]);
    const { name, color, groupId, assignedTo, isFavorite, sortOrder, memberUserIds } = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const p: unknown[]   = [];

    if (name       != null)      { sets.push("name = ?");        p.push(String(name)); }
    if (color      != null)      { sets.push("color = ?");       p.push(String(color)); }
    if (isFavorite != null)      { sets.push("is_favorite = ?"); p.push(isFavorite ? 1 : 0); }
    if (sortOrder  != null)      { sets.push("sort_order = ?");  p.push(Number(sortOrder)); }
    if (assignedTo !== undefined) { sets.push("assigned_to = ?"); p.push(assignedTo ? Number(assignedTo) : null); }

    if (groupId !== undefined) {
      if (groupId === null) {
        sets.push("group_id = ?"); p.push(null);
      } else {
        const gRows = await q<RowDataPacket>("SELECT id FROM todo_groups WHERE uuid = ?", [String(groupId)]);
        if (!gRows[0]) { res.status(404).json({ success: false, message: "Group not found" }); return; }
        sets.push("group_id = ?"); p.push(gRows[0]["id"]);
      }
    }

    if (sets.length > 0) {
      p.push(listId);
      await run(`UPDATE todo_lists SET ${sets.join(", ")} WHERE id = ?`, p);
    }

    // Replace members if provided
    if (memberUserIds !== undefined) {
      const ids = Array.isArray(memberUserIds)
        ? (memberUserIds as unknown[]).map(Number).filter(n => !isNaN(n) && n > 0)
        : [];
      await syncListMembers(listId, userId, ids);
    }

    const updated = await q<RowDataPacket>(
      `SELECT ${LIST_SEL}
       FROM todo_lists l
       LEFT JOIN todo_groups g ON g.id = l.group_id
       WHERE l.id = ?`,
      [listId]
    );

    const members = await fetchListMembers(listId);
    await logActivity(userId, "todo.list_updated", "todo_list", listId, undefined, { name, color }, req.ip);
    res.json({ success: true, message: "List updated", data: { ...updated[0], members } });
  } catch (err) {
    console.error("[todo-lists/update]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── deleteList ───────────────────────────────────────────────────────────────

export async function deleteList(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;

    const rows = await q<RowDataPacket>(
      "SELECT id, name FROM todo_lists WHERE uuid = ? AND created_by = ?",
      [uuid, userId]
    );
    if (!rows[0]) { res.status(404).json({ success: false, message: "List not found" }); return; }

    await run("DELETE FROM todo_lists WHERE id = ?", [rows[0]["id"]]);
    await logActivity(userId, "todo.list_deleted", "todo_list", Number(rows[0]["id"]), { name: rows[0]["name"] }, undefined, req.ip);
    res.json({ success: true, message: "List deleted", data: null });
  } catch (err) {
    console.error("[todo-lists/delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── toggleListFavorite ───────────────────────────────────────────────────────

export async function toggleListFavorite(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;

    const rows = await q<RowDataPacket>(
      "SELECT id, is_favorite AS isFavorite FROM todo_lists WHERE uuid = ? AND created_by = ?",
      [uuid, userId]
    );
    if (!rows[0]) { res.status(404).json({ success: false, message: "List not found" }); return; }

    const newFav = rows[0]["isFavorite"] ? 0 : 1;
    await run("UPDATE todo_lists SET is_favorite = ? WHERE id = ?", [newFav, rows[0]["id"]]);
    res.json({ success: true, message: "Favorite toggled", data: { isFavorite: newFav === 1 } });
  } catch (err) {
    console.error("[todo-lists/favorite]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── reorderLists ─────────────────────────────────────────────────────────────

export async function reorderLists(req: Request, res: Response): Promise<void> {
  try {
    const { lists } = req.body as { lists: Array<{ uuid: string; sortOrder: number; groupId?: string | null }> };
    if (!Array.isArray(lists) || lists.length === 0) {
      res.status(400).json({ success: false, message: "lists array is required" }); return;
    }

    const userId = req.user!.id;

    const groupUuids = [...new Set(lists.filter(i => i.groupId).map(i => i.groupId as string))];
    const groupIdMap: Record<string, number> = {};
    if (groupUuids.length > 0) {
      const ph    = groupUuids.map(() => "?").join(",");
      const gRows = await q<RowDataPacket>(`SELECT id, uuid FROM todo_groups WHERE uuid IN (${ph})`, groupUuids);
      gRows.forEach(g => { groupIdMap[String(g["uuid"])] = Number(g["id"]); });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const item of lists) {
        if (item.groupId !== undefined) {
          const newGroupId = item.groupId ? (groupIdMap[item.groupId] ?? null) : null;
          await conn.execute(
            "UPDATE todo_lists SET sort_order = ?, group_id = ? WHERE uuid = ? AND created_by = ?",
            [Number(item.sortOrder), newGroupId, item.uuid, userId]
          );
        } else {
          await conn.execute(
            "UPDATE todo_lists SET sort_order = ? WHERE uuid = ? AND created_by = ?",
            [Number(item.sortOrder), item.uuid, userId]
          );
        }
      }
      await conn.commit();
    } catch (txErr) {
      await conn.rollback();
      throw txErr;
    } finally {
      conn.release();
    }

    res.json({ success: true, message: "Lists reordered", data: null });
  } catch (err) {
    console.error("[todo-lists/reorder]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── getListMembers ───────────────────────────────────────────────────────────

export async function getListMembers(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;
    const isAdmin  = ["SUPER_ADMIN", "ADMIN"].includes(req.user!.role);

    const listRows = await q<RowDataPacket>("SELECT id, created_by AS createdBy FROM todo_lists WHERE uuid = ?", [uuid]);
    if (!listRows[0]) { res.status(404).json({ success: false, message: "List not found" }); return; }

    const listId = Number(listRows[0]["id"]);
    const isMember = await q<RowDataPacket>(
      "SELECT 1 FROM todo_list_members WHERE list_id = ? AND user_id = ?",
      [listId, userId]
    );

    if (!isAdmin && Number(listRows[0]["createdBy"]) !== userId && isMember.length === 0) {
      res.status(403).json({ success: false, message: "Forbidden" }); return;
    }

    const members = await fetchListMembers(listId);
    res.json({ success: true, message: "OK", data: members });
  } catch (err) {
    console.error("[todo-lists/members/get]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── addListMembers ───────────────────────────────────────────────────────────
// Body: { userIds: number[] }

export async function addListMembers(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;

    const listRows = await q<RowDataPacket>(
      "SELECT id FROM todo_lists WHERE uuid = ? AND created_by = ?",
      [uuid, userId]
    );
    if (!listRows[0]) { res.status(404).json({ success: false, message: "List not found" }); return; }

    const listId = Number(listRows[0]["id"]);
    const { userIds } = req.body as { userIds: unknown[] };
    if (!Array.isArray(userIds) || userIds.length === 0) {
      res.status(400).json({ success: false, message: "userIds array is required" }); return;
    }

    const ids = userIds.map(Number).filter(n => !isNaN(n) && n > 0);
    for (const uid of ids) {
      await run(
        "INSERT IGNORE INTO todo_list_members (list_id, user_id, added_by) VALUES (?, ?, ?)",
        [listId, uid, userId]
      );
    }

    const members = await fetchListMembers(listId);
    res.json({ success: true, message: "Members added", data: members });
  } catch (err) {
    console.error("[todo-lists/members/add]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── removeListMember ─────────────────────────────────────────────────────────
// DELETE /api/todo/lists/:uuid/members/:memberId  (memberId = users.id)

export async function removeListMember(req: Request, res: Response): Promise<void> {
  try {
    const { uuid, memberId } = req.params as Record<string, string>;
    const userId             = req.user!.id;

    const listRows = await q<RowDataPacket>(
      "SELECT id FROM todo_lists WHERE uuid = ? AND created_by = ?",
      [uuid, userId]
    );
    if (!listRows[0]) { res.status(404).json({ success: false, message: "List not found" }); return; }

    const listId = Number(listRows[0]["id"]);
    await run(
      "DELETE FROM todo_list_members WHERE list_id = ? AND user_id = ?",
      [listId, Number(memberId)]
    );

    const members = await fetchListMembers(listId);
    res.json({ success: true, message: "Member removed", data: members });
  } catch (err) {
    console.error("[todo-lists/members/remove]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
