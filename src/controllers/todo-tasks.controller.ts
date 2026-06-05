// src/controllers/todo-tasks.controller.ts

import { Request, Response } from "express";
import path from "path";
import { q, run, pool, RowDataPacket } from "../lib/db";
import { logActivity } from "../lib/logger";
import { uploadFile, deleteFile } from "../lib/storage";

// ─── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_ATTACHMENT_EXTS = [".pdf", ".docx", ".xlsx", ".png", ".jpg", ".jpeg", ".zip"];
const VALID_REPEAT_TYPES = ["none", "daily", "weekdays", "weekly", "monthly", "yearly", "custom"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function logTodo(taskId: number, userId: number, action: string, detail: string): Promise<void> {
  try {
    await run(
      "INSERT INTO todo_activity (task_id, user_id, action, detail) VALUES (?, ?, ?, ?)",
      [taskId, userId, action, detail]
    );
  } catch (err) {
    console.error("[todo_activity]", err);
  }
}

// Resolve task UUID → row; returns null if not found
async function resolveTask(uuid: string): Promise<RowDataPacket | null> {
  const rows = await q<RowDataPacket>(
    `SELECT t.id, t.uuid, t.title, t.description, t.status, t.priority, t.stage,
            t.due_date AS dueDate, t.due_time AS dueTime, t.reminder_at AS reminderAt,
            t.repeat_type AS repeatType, t.repeat_config AS repeatConfig,
            t.bg_color AS bgColor, t.is_favorite AS isFavorite,
            t.assigned_to AS assignedTo, t.sort_order AS sortOrder,
            t.completed_at AS completedAt, t.created_by AS createdBy,
            t.created_at AS createdAt, t.updated_at AS updatedAt, t.list_id AS listId,
            l.uuid AS listUuid, l.name AS listName, l.color AS listColor
     FROM todo_tasks t
     JOIN todo_lists l ON l.id = t.list_id
     WHERE t.uuid = ?`,
    [uuid]
  );
  return rows[0] ?? null;
}

async function attachTodoMembers(tasks: RowDataPacket[]): Promise<RowDataPacket[]> {
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
  return tasks.map(t => {
    const members = byTask[Number(t["id"])] ?? [];
    if (members.length === 0 && t["assignedTo"]) {
      return { ...t, members: [] };
    }
    return { ...t, members };
  });
}

async function setTodoTaskMembers(taskId: number, memberIds: number[], addedById: number): Promise<void> {
  await run("DELETE FROM todo_task_members WHERE task_id = ?", [taskId]);
  for (const uid of memberIds) {
    await run(
      "INSERT IGNORE INTO todo_task_members (task_id, user_id, added_by) VALUES (?, ?, ?)",
      [taskId, uid, addedById]
    );
  }
  if (memberIds.length > 0) {
    await run("UPDATE todo_tasks SET assigned_to = ? WHERE id = ?", [memberIds[0], taskId]);
  } else {
    await run("UPDATE todo_tasks SET assigned_to = NULL WHERE id = ?", [taskId]);
  }
}

function calcQuickReminderAt(option: string): Date {
  const now = new Date();
  if (option === "later_today") {
    const later = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const cap   = new Date(now); cap.setHours(18, 0, 0, 0);
    return later > cap ? cap : later;
  }
  if (option === "tomorrow") {
    const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d;
  }
  if (option === "next_week") {
    const d   = new Date(now);
    const day = d.getDay(); // 0=Sun
    d.setDate(d.getDate() + (day === 0 ? 1 : 8 - day));
    d.setHours(9, 0, 0, 0);
    return d;
  }
  throw new Error(`Unknown quickOption: ${option}`);
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

export async function listTasks(req: Request, res: Response): Promise<void> {
  try {
    const userId  = req.user!.id;
    const isAdmin = ["SUPER_ADMIN", "ADMIN"].includes(req.user!.role);
    const showAll = isAdmin && req.query["all"] === "true";

    const conditions: string[] = [];
    const params: unknown[]    = [];

    // Path param (/lists/:listUuid/tasks) takes priority over ?listId= query param
    const listUuid = (req.params["listUuid"] as string | undefined)
      ?? (req.query["listId"] as string | undefined);

    if (listUuid) {
      const lRows = await q<RowDataPacket>("SELECT id FROM todo_lists WHERE uuid = ?", [listUuid]);
      if (!lRows[0]) { res.status(404).json({ success: false, message: "List not found" }); return; }
      conditions.push("t.list_id = ?");
      params.push(lRows[0]["id"]);
    }

    if (!showAll) {
      // Employee sees tasks they own, are assigned to directly, are a task-member of,
      // are a list-member of, or whose list is assigned to them.
      conditions.push(
        `(t.created_by = ?
          OR t.assigned_to = ?
          OR EXISTS (SELECT 1 FROM todo_task_members tm WHERE tm.task_id = t.id AND tm.user_id = ?)
          OR EXISTS (SELECT 1 FROM todo_list_members lm WHERE lm.list_id = t.list_id AND lm.user_id = ?)
          OR EXISTS (SELECT 1 FROM todo_lists tl WHERE tl.id = t.list_id AND tl.assigned_to = ?))`
      );
      params.push(userId, userId, userId, userId, userId);
    }

    const { search, status, priority, dueDate } = req.query as Record<string, string | undefined>;
    if (search)   { conditions.push("t.title LIKE ?"); params.push(`%${search}%`); }
    if (status)   { conditions.push("t.status = ?");   params.push(status); }
    if (priority) { conditions.push("t.priority = ?"); params.push(priority); }
    if (dueDate)  { conditions.push("t.due_date = ?"); params.push(dueDate); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const tasks = await q<RowDataPacket>(
      `SELECT
         t.id, t.uuid, t.title, t.status, t.priority,
         t.due_date AS dueDate, t.due_time AS dueTime,
         t.bg_color AS bgColor, t.is_favorite AS isFavorite,
         t.assigned_to AS assignedTo, t.sort_order AS sortOrder,
         t.completed_at AS completedAt, t.created_by AS createdBy, t.created_at AS createdAt,
         l.uuid AS listUuid, l.name AS listName,
         (SELECT COUNT(*) FROM todo_subtasks s WHERE s.task_id = t.id) AS subtaskTotal,
         (SELECT COUNT(*) FROM todo_subtasks s WHERE s.task_id = t.id AND s.status = 'completed') AS subtaskDone
       FROM todo_tasks t
       LEFT JOIN todo_lists l ON l.id = t.list_id
       ${where}
       ORDER BY
         CASE t.status WHEN 'completed' THEN 1 ELSE 0 END ASC,
         t.sort_order ASC`,
      params
    );

    const tasksWithMembers = await attachTodoMembers(tasks);
    res.json({ success: true, message: "OK", data: tasksWithMembers });
  } catch (err) {
    console.error("[todo-tasks/list]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── createTask ───────────────────────────────────────────────────────────────

export async function createTask(req: Request, res: Response): Promise<void> {
  try {
    const listUuid = req.params["listUuid"] as string;
    const userId   = req.user!.id;

    const lRows = await q<RowDataPacket>(
      `SELECT l.id FROM todo_lists l WHERE l.uuid = ?
       AND (l.created_by = ? OR l.assigned_to = ?
            OR EXISTS (SELECT 1 FROM todo_list_members lm WHERE lm.list_id = l.id AND lm.user_id = ?))`,
      [listUuid, userId, userId, userId]
    );
    if (!lRows[0]) { res.status(404).json({ success: false, message: "List not found" }); return; }
    const listId = Number(lRows[0]["id"]);

    const { title, description, priority, stage, dueDate, dueTime, bgColor, assignedTo, memberIds } =
      req.body as Record<string, unknown>;
    if (!title) { res.status(400).json({ success: false, message: "title is required" }); return; }

    const memberIdArr = Array.isArray(memberIds) ? (memberIds as number[]).map(Number) : [];
    const assignedToId = memberIdArr.length > 0 ? memberIdArr[0] : (assignedTo ? Number(assignedTo) : null);

    const result = await run(
      `INSERT INTO todo_tasks
         (list_id, title, description, priority, stage, due_date, due_time, bg_color, assigned_to, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        listId,
        String(title),
        description ? String(description) : null,
        priority    ? String(priority)    : "none",
        stage       ? String(stage)       : "inprogress",
        dueDate     ? String(dueDate)     : null,
        dueTime     ? String(dueTime)     : null,
        bgColor     ? String(bgColor)     : "default",
        assignedToId,
        userId,
      ]
    );
    const taskId = result.insertId;

    if (memberIdArr.length > 0) {
      await setTodoTaskMembers(taskId, memberIdArr, userId);
    }

    await logTodo(taskId, userId, "created", "Task created");
    if (assignedToId && assignedToId !== userId) {
      await logTodo(taskId, userId, "assigned", "Task assigned");
    }
    await logActivity(userId, "todo.task_created", "todo_task", taskId, undefined, { title }, req.ip);

    const rows = await q<RowDataPacket>(
      `SELECT t.id, t.uuid, t.title, t.description, t.status, t.priority, t.stage,
              t.due_date AS dueDate, t.due_time AS dueTime, t.reminder_at AS reminderAt,
              t.repeat_type AS repeatType, t.repeat_config AS repeatConfig,
              t.bg_color AS bgColor, t.is_favorite AS isFavorite,
              t.assigned_to AS assignedTo, t.sort_order AS sortOrder,
              t.completed_at AS completedAt, t.created_by AS createdBy,
              t.created_at AS createdAt, t.list_id AS listId,
              l.uuid AS listUuid, l.name AS listName
       FROM todo_tasks t
       JOIN todo_lists l ON l.id = t.list_id
       WHERE t.id = ?`,
      [taskId]
    );

    res.status(201).json({ success: true, message: "Task created", data: rows[0] });
  } catch (err) {
    console.error("[todo-tasks/create]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── getTask ──────────────────────────────────────────────────────────────────

export async function getTask(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;
    const isAdmin  = ["SUPER_ADMIN", "ADMIN"].includes(req.user!.role);

    const task = await resolveTask(uuid);
    if (!task) { res.status(404).json({ success: false, message: "Task not found" }); return; }

    if (!isAdmin && Number(task["createdBy"]) !== userId && Number(task["assignedTo"]) !== userId) {
      const accessRow = await q<RowDataPacket>(
        `SELECT 1 FROM todo_task_members WHERE task_id = ? AND user_id = ?
         UNION ALL SELECT 1 FROM todo_list_members WHERE list_id = ? AND user_id = ?
         UNION ALL SELECT 1 FROM todo_lists WHERE id = ? AND assigned_to = ?
         LIMIT 1`,
        [task["id"], userId, task["listId"], userId, task["listId"], userId]
      );
      if (!accessRow[0]) { res.status(403).json({ success: false, message: "Forbidden" }); return; }
    }

    const [subtasks, attachments, noteRows, activityRows] = await Promise.all([
      q<RowDataPacket>(
        `SELECT id, uuid, title, status, sort_order AS sortOrder, completed_at AS completedAt
         FROM todo_subtasks WHERE task_id = ? ORDER BY sort_order ASC`,
        [task["id"]]
      ),
      q<RowDataPacket>(
        `SELECT id, uuid, file_name AS fileName, file_path AS filePath,
                file_size AS fileSize, file_type AS fileType,
                uploaded_by AS uploadedBy, created_at AS createdAt
         FROM todo_attachments WHERE task_id = ?`,
        [task["id"]]
      ),
      q<RowDataPacket>(
        "SELECT content FROM todo_notes WHERE task_id = ?",
        [task["id"]]
      ),
      q<RowDataPacket>(
        `SELECT ta.id, ta.action, ta.detail, ta.created_at AS createdAt,
                u.name AS userName, u.avatar_url AS userAvatarUrl
         FROM todo_activity ta
         JOIN users u ON u.id = ta.user_id
         WHERE ta.task_id = ?
         ORDER BY ta.created_at DESC LIMIT 10`,
        [task["id"]]
      ),
    ]);

    const memberRows = await q<RowDataPacket>(
      `SELECT u.id, u.name, u.email,
              COALESCE(u.avatar_url, e.photo_url) AS avatarUrl
       FROM todo_task_members tm
       JOIN users u ON u.id = tm.user_id
       LEFT JOIN employees e ON e.user_id = u.id
       WHERE tm.task_id = ?
       ORDER BY tm.created_at ASC`,
      [task["id"]]
    );
    const members = memberRows.map(r => ({
      id: Number(r["id"]), name: String(r["name"]),
      email: String(r["email"]), avatarUrl: r["avatarUrl"] ?? null,
    }));

    let assignedUser: RowDataPacket | null = null;
    if (task["assignedTo"] && members.length === 0) {
      const uRows = await q<RowDataPacket>(
        "SELECT id, name, email, avatar_url AS avatarUrl FROM users WHERE id = ?",
        [task["assignedTo"]]
      );
      assignedUser = uRows[0] ?? null;
    }

    res.json({
      success: true, message: "OK",
      data: {
        ...task,
        members,
        subtasks,
        attachments,
        note:         noteRows[0]?.["content"] ?? "",
        activity:     activityRows,
        assignedUser,
      },
    });
  } catch (err) {
    console.error("[todo-tasks/get]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── updateTask ───────────────────────────────────────────────────────────────

export async function updateTask(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;
    const isAdmin  = ["SUPER_ADMIN", "ADMIN"].includes(req.user!.role);

    const task = await resolveTask(uuid);
    if (!task) { res.status(404).json({ success: false, message: "Task not found" }); return; }

    const isCreator  = Number(task["createdBy"]) === userId;
    const isAssigned = Number(task["assignedTo"]) === userId;

    if (!isCreator && !isAdmin) {
      if (!isAssigned) {
        const memberRow = await q<RowDataPacket>(
          "SELECT 1 FROM todo_task_members WHERE task_id = ? AND user_id = ? LIMIT 1",
          [task["id"], userId]
        );
        if (!memberRow[0]) { res.status(403).json({ success: false, message: "Forbidden" }); return; }
      }
      // Assigned-only users can change only status
      const bodyKeys = Object.keys(req.body as Record<string, unknown>);
      if (bodyKeys.some(k => k !== "status")) {
        res.status(403).json({ success: false, message: "Assigned users can only update task status" }); return;
      }
    }

    const { title, description, status, priority, stage, dueDate, dueTime,
            bgColor, isFavorite, assignedTo, sortOrder, repeatType, memberIds, listId } =
      req.body as Record<string, unknown>;

    const sets: string[] = [];
    const p: unknown[]   = [];

    if (title       != null) { sets.push("title = ?");       p.push(String(title)); }
    if (description != null) { sets.push("description = ?"); p.push(description ? String(description) : null); }
    if (priority    != null) { sets.push("priority = ?");    p.push(String(priority)); }
    if (stage       != null) { sets.push("stage = ?");       p.push(String(stage)); }
    if (dueDate     !== undefined) { sets.push("due_date = ?");  p.push(dueDate  ? String(dueDate)  : null); }
    if (dueTime     !== undefined) { sets.push("due_time = ?");  p.push(dueTime  ? String(dueTime)  : null); }
    if (bgColor     != null) { sets.push("bg_color = ?");    p.push(String(bgColor)); }
    if (isFavorite  != null) { sets.push("is_favorite = ?"); p.push(isFavorite ? 1 : 0); }
    if (sortOrder   != null) { sets.push("sort_order = ?");  p.push(Number(sortOrder)); }
    if (repeatType  != null) {
      const rt = String(repeatType);
      if (!VALID_REPEAT_TYPES.includes(rt)) {
        res.status(400).json({ success: false, message: `Invalid repeatType: ${rt}` }); return;
      }
      sets.push("repeat_type = ?"); p.push(rt);
    }
    if (listId != null) {
      const lRows = await q<RowDataPacket>("SELECT id FROM todo_lists WHERE uuid = ?", [String(listId)]);
      if (lRows[0]) { sets.push("list_id = ?"); p.push(Number(lRows[0]["id"])); }
    }
    if (assignedTo  !== undefined) {
      sets.push("assigned_to = ?"); p.push(assignedTo ? Number(assignedTo) : null);
    }

    if (status != null) {
      const newStatus = String(status);
      sets.push("status = ?"); p.push(newStatus);
      if (newStatus === "completed" && task["status"] !== "completed") {
        sets.push("completed_at = NOW()");
      } else if (newStatus === "pending" && task["status"] === "completed") {
        sets.push("completed_at = NULL");
      }
    }

    if (sets.length > 0) {
      p.push(task["id"]);
      await run(`UPDATE todo_tasks SET ${sets.join(", ")} WHERE id = ?`, p);
    }

    const taskId = Number(task["id"]);

    // Handle multi-member assignment
    if (Array.isArray(memberIds)) {
      const ids = (memberIds as number[]).map(Number);
      await setTodoTaskMembers(taskId, ids, userId);
    }

    // Log significant changes to todo_activity
    if (status != null && String(status) !== String(task["status"])) {
      const detail = String(status) === "completed" ? "Marked as completed" : "Reopened";
      await logTodo(taskId, userId, String(status) === "completed" ? "completed" : "reopened", detail);
    }
    if (assignedTo !== undefined && Number(assignedTo) !== Number(task["assignedTo"])) {
      if (assignedTo) {
        const uRows = await q<RowDataPacket>("SELECT name FROM users WHERE id = ?", [Number(assignedTo)]);
        const name  = uRows[0]?.["name"] ?? String(assignedTo);
        await logTodo(taskId, userId, "assigned", `Assigned to ${name}`);
      }
    }
    if (dueDate !== undefined && String(dueDate) !== String(task["dueDate"])) {
      await logTodo(taskId, userId, "due_date_changed", dueDate ? `Due date set to ${dueDate}` : "Due date removed");
    }

    await logActivity(userId, "todo.task_updated", "todo_task", taskId, undefined, { title, status }, req.ip);

    const updated = await resolveTask(uuid);
    res.json({ success: true, message: "Task updated", data: updated });
  } catch (err) {
    console.error("[todo-tasks/update]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── deleteTask ───────────────────────────────────────────────────────────────

export async function deleteTask(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;
    const isAdmin  = ["SUPER_ADMIN", "ADMIN"].includes(req.user!.role);

    const task = await resolveTask(uuid);
    if (!task) { res.status(404).json({ success: false, message: "Task not found" }); return; }

    if (!isAdmin && Number(task["createdBy"]) !== userId && Number(task["assignedTo"]) !== userId) {
      const memberRow = await q<RowDataPacket>(
        "SELECT 1 FROM todo_task_members WHERE task_id = ? AND user_id = ? LIMIT 1",
        [task["id"], userId]
      );
      if (!memberRow[0]) {
        res.status(403).json({ success: false, message: "Forbidden" }); return;
      }
    }

    // Delete attachment files from cloud storage before cascading DB delete
    const attachments = await q<RowDataPacket>(
      "SELECT file_path AS filePath FROM todo_attachments WHERE task_id = ?",
      [task["id"]]
    );
    await Promise.all(attachments.map(att => deleteFile(String(att["filePath"]))));

    await run("DELETE FROM todo_tasks WHERE id = ?", [task["id"]]);
    await logActivity(userId, "todo.task_deleted", "todo_task", Number(task["id"]), { title: task["title"] }, undefined, req.ip);
    res.json({ success: true, message: "Task deleted", data: null });
  } catch (err) {
    console.error("[todo-tasks/delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── updateTaskStatus (toggle complete ↔ pending) ────────────────────────────

export async function updateTaskStatus(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;

    const task = await resolveTask(uuid);
    if (!task) { res.status(404).json({ success: false, message: "Task not found" }); return; }

    const isCreator  = Number(task["createdBy"]) === userId;
    const isAssigned = Number(task["assignedTo"]) === userId;
    const isAdmin    = ["SUPER_ADMIN", "ADMIN"].includes(req.user!.role);
    if (!isCreator && !isAssigned && !isAdmin) {
      const memberRow = await q<RowDataPacket>(
        "SELECT 1 FROM todo_task_members WHERE task_id = ? AND user_id = ? LIMIT 1",
        [task["id"], userId]
      );
      if (!memberRow[0]) { res.status(403).json({ success: false, message: "Forbidden" }); return; }
    }

    const newStatus = task["status"] === "pending" ? "completed" : "pending";
    if (newStatus === "completed") {
      await run("UPDATE todo_tasks SET status = 'completed', completed_at = NOW() WHERE id = ?", [task["id"]]);
    } else {
      await run("UPDATE todo_tasks SET status = 'pending', completed_at = NULL WHERE id = ?", [task["id"]]);
    }

    const taskId = Number(task["id"]);
    const detail = newStatus === "completed" ? "Marked as completed" : "Reopened";
    await logTodo(taskId, userId, newStatus === "completed" ? "completed" : "reopened", detail);
    await logActivity(userId, `todo.task_${newStatus}`, "todo_task", taskId, undefined, { status: newStatus }, req.ip);

    const updatedRows = await q<RowDataPacket>(
      "SELECT status, completed_at AS completedAt FROM todo_tasks WHERE id = ?",
      [task["id"]]
    );
    res.json({ success: true, message: "Status updated", data: updatedRows[0] });
  } catch (err) {
    console.error("[todo-tasks/status]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── toggleTaskFavorite ───────────────────────────────────────────────────────

export async function toggleTaskFavorite(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;

    const rows = await q<RowDataPacket>(
      "SELECT id, is_favorite AS isFavorite FROM todo_tasks WHERE uuid = ? AND (created_by = ? OR assigned_to = ?)",
      [uuid, userId, userId]
    );
    if (!rows[0]) { res.status(404).json({ success: false, message: "Task not found" }); return; }

    const newFav = rows[0]["isFavorite"] ? 0 : 1;
    await run("UPDATE todo_tasks SET is_favorite = ? WHERE id = ?", [newFav, rows[0]["id"]]);
    res.json({ success: true, message: "Favorite toggled", data: { isFavorite: newFav === 1 } });
  } catch (err) {
    console.error("[todo-tasks/favorite]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── reorderTasks ─────────────────────────────────────────────────────────────

export async function reorderTasks(req: Request, res: Response): Promise<void> {
  try {
    const { tasks } = req.body as { tasks: Array<{ uuid: string; sortOrder: number; listId?: string }> };
    if (!Array.isArray(tasks) || tasks.length === 0) {
      res.status(400).json({ success: false, message: "tasks array is required" }); return;
    }

    const userId = req.user!.id;

    // Batch-resolve list UUIDs if provided
    const listUuids = [...new Set(tasks.filter(t => t.listId).map(t => t.listId as string))];
    const listIdMap: Record<string, number> = {};
    if (listUuids.length > 0) {
      const ph    = listUuids.map(() => "?").join(",");
      const lRows = await q<RowDataPacket>(`SELECT id, uuid FROM todo_lists WHERE uuid IN (${ph})`, listUuids);
      lRows.forEach(l => { listIdMap[String(l["uuid"])] = Number(l["id"]); });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const item of tasks) {
        if (item.listId !== undefined) {
          const newListId = item.listId ? (listIdMap[item.listId] ?? null) : null;
          await conn.execute(
            "UPDATE todo_tasks SET sort_order = ?, list_id = ? WHERE uuid = ? AND (created_by = ? OR assigned_to = ?)",
            [Number(item.sortOrder), newListId, item.uuid, userId, userId]
          );
        } else {
          await conn.execute(
            "UPDATE todo_tasks SET sort_order = ? WHERE uuid = ? AND (created_by = ? OR assigned_to = ?)",
            [Number(item.sortOrder), item.uuid, userId, userId]
          );
        }
      }
      await conn.commit();
    } catch (txErr) {
      await conn.rollback(); throw txErr;
    } finally {
      conn.release();
    }

    res.json({ success: true, message: "Tasks reordered", data: null });
  } catch (err) {
    console.error("[todo-tasks/reorder]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Subtasks ─────────────────────────────────────────────────────────────────

export async function listSubtasks(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;

    const task = await resolveTask(uuid);
    if (!task) { res.status(404).json({ success: false, message: "Task not found" }); return; }
    if (Number(task["createdBy"]) !== userId && Number(task["assignedTo"]) !== userId
        && !["SUPER_ADMIN", "ADMIN"].includes(req.user!.role)) {
      const memberRow = await q<RowDataPacket>(
        "SELECT 1 FROM todo_task_members WHERE task_id = ? AND user_id = ? LIMIT 1",
        [task["id"], userId]
      );
      if (!memberRow[0]) { res.status(403).json({ success: false, message: "Forbidden" }); return; }
    }

    const subtasks = await q<RowDataPacket>(
      `SELECT id, uuid, title, status, sort_order AS sortOrder, completed_at AS completedAt
       FROM todo_subtasks WHERE task_id = ? ORDER BY sort_order ASC`,
      [task["id"]]
    );
    res.json({ success: true, message: "OK", data: subtasks });
  } catch (err) {
    console.error("[todo-tasks/subtasks/list]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function createSubtask(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;

    const task = await resolveTask(uuid);
    if (!task) { res.status(404).json({ success: false, message: "Task not found" }); return; }

    const { title } = req.body as Record<string, unknown>;
    if (!title) { res.status(400).json({ success: false, message: "title is required" }); return; }

    const result = await run(
      "INSERT INTO todo_subtasks (task_id, title) VALUES (?, ?)",
      [task["id"], String(title)]
    );
    await logTodo(Number(task["id"]), userId, "subtask_added", `Subtask added: ${title}`);

    const rows = await q<RowDataPacket>(
      `SELECT id, uuid, title, status, sort_order AS sortOrder, completed_at AS completedAt
       FROM todo_subtasks WHERE id = ?`,
      [result.insertId]
    );
    res.status(201).json({ success: true, message: "Subtask created", data: rows[0] });
  } catch (err) {
    console.error("[todo-tasks/subtasks/create]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function updateSubtask(req: Request, res: Response): Promise<void> {
  try {
    const { uuid, subUuid } = req.params as Record<string, string>;
    const userId = req.user!.id;

    const task = await resolveTask(uuid);
    if (!task) { res.status(404).json({ success: false, message: "Task not found" }); return; }

    const subRows = await q<RowDataPacket>(
      "SELECT id, status FROM todo_subtasks WHERE uuid = ? AND task_id = ?",
      [subUuid, task["id"]]
    );
    if (!subRows[0]) { res.status(404).json({ success: false, message: "Subtask not found" }); return; }

    const { title, status } = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const p: unknown[]   = [];

    if (title  != null) { sets.push("title = ?");  p.push(String(title)); }
    if (status != null) {
      const newSt = String(status);
      sets.push("status = ?"); p.push(newSt);
      if (newSt === "completed" && subRows[0]["status"] !== "completed") {
        sets.push("completed_at = NOW()");
      } else if (newSt === "pending") {
        sets.push("completed_at = NULL");
      }
    }

    if (sets.length > 0) {
      p.push(subRows[0]["id"]);
      await run(`UPDATE todo_subtasks SET ${sets.join(", ")} WHERE id = ?`, p);
    }

    const updated = await q<RowDataPacket>(
      `SELECT id, uuid, title, status, sort_order AS sortOrder, completed_at AS completedAt
       FROM todo_subtasks WHERE id = ?`,
      [subRows[0]["id"]]
    );

    if (status != null && String(status) !== String(subRows[0]["status"])) {
      await logTodo(Number(task["id"]), userId,
        String(status) === "completed" ? "subtask_completed" : "subtask_reopened",
        `Subtask ${String(status) === "completed" ? "completed" : "reopened"}`
      );
    }

    res.json({ success: true, message: "Subtask updated", data: updated[0] });
  } catch (err) {
    console.error("[todo-tasks/subtasks/update]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function deleteSubtask(req: Request, res: Response): Promise<void> {
  try {
    const { uuid, subUuid } = req.params as Record<string, string>;

    const task = await resolveTask(uuid);
    if (!task) { res.status(404).json({ success: false, message: "Task not found" }); return; }

    const subRows = await q<RowDataPacket>(
      "SELECT id FROM todo_subtasks WHERE uuid = ? AND task_id = ?",
      [subUuid, task["id"]]
    );
    if (!subRows[0]) { res.status(404).json({ success: false, message: "Subtask not found" }); return; }

    await run("DELETE FROM todo_subtasks WHERE id = ?", [subRows[0]["id"]]);
    res.json({ success: true, message: "Subtask deleted", data: null });
  } catch (err) {
    console.error("[todo-tasks/subtasks/delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function reorderSubtasks(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const { subtasks } = req.body as { subtasks: Array<{ uuid: string; sortOrder: number }> };
    if (!Array.isArray(subtasks) || subtasks.length === 0) {
      res.status(400).json({ success: false, message: "subtasks array is required" }); return;
    }

    const task = await resolveTask(uuid);
    if (!task) { res.status(404).json({ success: false, message: "Task not found" }); return; }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const item of subtasks) {
        await conn.execute(
          "UPDATE todo_subtasks SET sort_order = ? WHERE uuid = ? AND task_id = ?",
          [Number(item.sortOrder), item.uuid, task["id"]]
        );
      }
      await conn.commit();
    } catch (txErr) {
      await conn.rollback(); throw txErr;
    } finally {
      conn.release();
    }

    res.json({ success: true, message: "Subtasks reordered", data: null });
  } catch (err) {
    console.error("[todo-tasks/subtasks/reorder]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Attachments ──────────────────────────────────────────────────────────────

export async function uploadAttachment(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;

    if (!req.file) { res.status(400).json({ success: false, message: "No file uploaded" }); return; }

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!ALLOWED_ATTACHMENT_EXTS.includes(ext)) {
      res.status(400).json({
        success: false,
        message: `File type not allowed. Allowed: ${ALLOWED_ATTACHMENT_EXTS.join(", ")}`,
      }); return;
    }

    const task = await resolveTask(uuid);
    if (!task) {
      res.status(404).json({ success: false, message: "Task not found" }); return;
    }

    const { url } = await uploadFile(req.file.buffer, { folder: "todo-attachments", filename: req.file.originalname, mimetype: req.file.mimetype });
    const result = await run(
      `INSERT INTO todo_attachments (task_id, file_name, file_path, file_size, file_type, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        task["id"],
        req.file.originalname,
        url,
        req.file.size,
        ext.replace(".", ""),
        userId,
      ]
    );

    await logTodo(Number(task["id"]), userId, "attachment_added", `Attachment added: ${req.file.originalname}`);

    const rows = await q<RowDataPacket>(
      `SELECT id, uuid, file_name AS fileName, file_path AS filePath,
              file_size AS fileSize, file_type AS fileType,
              uploaded_by AS uploadedBy, created_at AS createdAt
       FROM todo_attachments WHERE id = ?`,
      [result.insertId]
    );
    res.status(201).json({ success: true, message: "Attachment uploaded", data: rows[0] });
  } catch (err) {
    console.error("[todo-tasks/attachments/upload]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function deleteAttachment(req: Request, res: Response): Promise<void> {
  try {
    const { uuid, attUuid } = req.params as Record<string, string>;
    const userId = req.user!.id;

    const task = await resolveTask(uuid);
    if (!task) { res.status(404).json({ success: false, message: "Task not found" }); return; }

    const attRows = await q<RowDataPacket>(
      `SELECT id, file_path AS filePath, uploaded_by AS uploadedBy
       FROM todo_attachments WHERE uuid = ? AND task_id = ?`,
      [attUuid, task["id"]]
    );
    if (!attRows[0]) { res.status(404).json({ success: false, message: "Attachment not found" }); return; }

    const isAdmin = ["SUPER_ADMIN", "ADMIN"].includes(req.user!.role);
    if (!isAdmin && Number(attRows[0]["uploadedBy"]) !== userId && Number(task["createdBy"]) !== userId) {
      res.status(403).json({ success: false, message: "Forbidden" }); return;
    }

    await deleteFile(String(attRows[0]["filePath"]));
    await run("DELETE FROM todo_attachments WHERE id = ?", [attRows[0]["id"]]);
    await logTodo(Number(task["id"]), userId, "attachment_removed", "Attachment removed");
    res.json({ success: true, message: "Attachment deleted", data: null });
  } catch (err) {
    console.error("[todo-tasks/attachments/delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function downloadAttachment(req: Request, res: Response): Promise<void> {
  try {
    const { attUuid } = req.params as Record<string, string>;

    const rows = await q<RowDataPacket>(
      "SELECT file_name AS fileName, file_path AS filePath FROM todo_attachments WHERE uuid = ?",
      [attUuid]
    );
    if (!rows[0]) { res.status(404).json({ success: false, message: "Attachment not found" }); return; }

    res.setHeader("Content-Disposition", `attachment; filename="${rows[0]["fileName"]}"`);
    res.redirect(String(rows[0]["filePath"]));
  } catch (err) {
    console.error("[todo-tasks/attachments/download]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Notes ────────────────────────────────────────────────────────────────────

export async function getNote(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;

    const task = await resolveTask(uuid);
    if (!task) { res.status(404).json({ success: false, message: "Task not found" }); return; }

    const rows = await q<RowDataPacket>(
      "SELECT content FROM todo_notes WHERE task_id = ?",
      [task["id"]]
    );
    res.json({ success: true, message: "OK", data: { content: rows[0]?.["content"] ?? "" } });
  } catch (err) {
    console.error("[todo-tasks/notes/get]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function upsertNote(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;

    const task = await resolveTask(uuid);
    if (!task) { res.status(404).json({ success: false, message: "Task not found" }); return; }

    const { content } = req.body as Record<string, unknown>;
    const html = content != null ? String(content) : "";

    await run(
      `INSERT INTO todo_notes (task_id, content) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE content = VALUES(content)`,
      [task["id"], html]
    );
    await logTodo(Number(task["id"]), userId, "note_updated", "Note updated");
    res.json({ success: true, message: "Note saved", data: { content: html } });
  } catch (err) {
    console.error("[todo-tasks/notes/upsert]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Activity ─────────────────────────────────────────────────────────────────

export async function listActivity(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const page  = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query["limit"] ?? "20"), 10)));
    const offset = (page - 1) * limit;

    const task = await resolveTask(uuid);
    if (!task) { res.status(404).json({ success: false, message: "Task not found" }); return; }

    const [rows, countRows] = await Promise.all([
      q<RowDataPacket>(
        `SELECT ta.id, ta.action, ta.detail, ta.created_at AS createdAt,
                u.name AS userName, u.avatar_url AS userAvatarUrl
         FROM todo_activity ta
         JOIN users u ON u.id = ta.user_id
         WHERE ta.task_id = ?
         ORDER BY ta.created_at DESC
         LIMIT ? OFFSET ?`,
        [task["id"], limit, offset]
      ),
      q<RowDataPacket>(
        "SELECT COUNT(*) AS total FROM todo_activity WHERE task_id = ?",
        [task["id"]]
      ),
    ]);

    res.json({
      success: true, message: "OK",
      data: {
        activity: rows,
        total:    Number(countRows[0]?.["total"] ?? 0),
        page,
        limit,
      },
    });
  } catch (err) {
    console.error("[todo-tasks/activity]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Reminders ────────────────────────────────────────────────────────────────

export async function setReminder(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;

    const task = await resolveTask(uuid);
    if (!task) { res.status(404).json({ success: false, message: "Task not found" }); return; }

    const { reminderAt, quickOption } = req.body as Record<string, unknown>;
    let reminderDate: Date;

    if (quickOption) {
      try { reminderDate = calcQuickReminderAt(String(quickOption)); }
      catch { res.status(400).json({ success: false, message: "Invalid quickOption" }); return; }
    } else if (reminderAt) {
      reminderDate = new Date(String(reminderAt));
      if (isNaN(reminderDate.getTime())) {
        res.status(400).json({ success: false, message: "Invalid reminderAt datetime" }); return;
      }
    } else {
      res.status(400).json({ success: false, message: "reminderAt or quickOption is required" }); return;
    }

    // Store as UTC ISO string (MySQL DATETIME)
    const isoStr = reminderDate.toISOString().slice(0, 19).replace("T", " ");
    await run("UPDATE todo_tasks SET reminder_at = ? WHERE id = ?", [isoStr, task["id"]]);

    const formatted = reminderDate.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    await logTodo(Number(task["id"]), userId, "reminder_added", `Reminder set for ${formatted}`);

    res.json({ success: true, message: "Reminder set", data: { reminderAt: isoStr } });
  } catch (err) {
    console.error("[todo-tasks/reminder/set]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function deleteReminder(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;

    const task = await resolveTask(uuid);
    if (!task) { res.status(404).json({ success: false, message: "Task not found" }); return; }

    await run("UPDATE todo_tasks SET reminder_at = NULL WHERE id = ?", [task["id"]]);
    await logTodo(Number(task["id"]), userId, "reminder_removed", "Reminder removed");
    res.json({ success: true, message: "Reminder removed", data: null });
  } catch (err) {
    console.error("[todo-tasks/reminder/delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Repeat Settings ──────────────────────────────────────────────────────────

export async function updateRepeat(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;

    const task = await resolveTask(uuid);
    if (!task) { res.status(404).json({ success: false, message: "Task not found" }); return; }
    if (Number(task["createdBy"]) !== userId && !["SUPER_ADMIN", "ADMIN"].includes(req.user!.role)) {
      res.status(403).json({ success: false, message: "Forbidden" }); return;
    }

    const { repeatType, repeatConfig } = req.body as Record<string, unknown>;
    if (!repeatType || !VALID_REPEAT_TYPES.includes(String(repeatType))) {
      res.status(400).json({
        success: false,
        message: `repeatType must be one of: ${VALID_REPEAT_TYPES.join(", ")}`,
      }); return;
    }

    await run(
      "UPDATE todo_tasks SET repeat_type = ?, repeat_config = ? WHERE id = ?",
      [String(repeatType), repeatConfig ? JSON.stringify(repeatConfig) : null, task["id"]]
    );
    await logTodo(Number(task["id"]), userId, "repeat_updated", `Repeat set to ${repeatType}`);

    const updated = await q<RowDataPacket>(
      "SELECT repeat_type AS repeatType, repeat_config AS repeatConfig FROM todo_tasks WHERE id = ?",
      [task["id"]]
    );
    res.json({ success: true, message: "Repeat updated", data: updated[0] });
  } catch (err) {
    console.error("[todo-tasks/repeat]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Smart Views ──────────────────────────────────────────────────────────────

const SMART_TASK_SEL = `
  t.id, t.uuid, t.title, t.status, t.priority,
  t.due_date AS dueDate, t.due_time AS dueTime,
  t.bg_color AS bgColor, t.is_favorite AS isFavorite,
  t.assigned_to AS assignedTo, t.completed_at AS completedAt,
  t.created_at AS createdAt,
  l.name AS listName, l.color AS listColor, l.uuid AS listUuid
`;

export async function getSmartView(req: Request, res: Response): Promise<void> {
  try {
    const view   = req.params["view"] as string;
    const userId = req.user!.id;

    switch (view) {

      case "today": {
        const tasks = await q<RowDataPacket>(
          `SELECT ${SMART_TASK_SEL}
           FROM todo_tasks t
           JOIN todo_lists l ON l.id = t.list_id
           WHERE t.due_date = CURDATE()
             AND (t.created_by = ?
                  OR t.assigned_to = ?
                  OR EXISTS (SELECT 1 FROM todo_task_members tm WHERE tm.task_id = t.id AND tm.user_id = ?)
                  OR EXISTS (SELECT 1 FROM todo_list_members lm WHERE lm.list_id = t.list_id AND lm.user_id = ?)
                  OR EXISTS (SELECT 1 FROM todo_lists tl WHERE tl.id = t.list_id AND tl.assigned_to = ?))
           ORDER BY t.sort_order ASC`,
          [userId, userId, userId, userId, userId]
        );
        res.json({ success: true, message: "OK", data: tasks }); break;
      }

      case "assigned-to-me": {
        const tasks = await q<RowDataPacket>(
          `SELECT ${SMART_TASK_SEL},
                  u.name AS assignedByName
           FROM todo_tasks t
           JOIN todo_lists l ON l.id = t.list_id
           JOIN users u ON u.id = t.created_by
           WHERE t.status = 'pending'
             AND t.created_by != ?
             AND (t.assigned_to = ?
                  OR EXISTS (SELECT 1 FROM todo_task_members tm WHERE tm.task_id = t.id AND tm.user_id = ?))
           ORDER BY t.due_date ASC, t.sort_order ASC`,
          [userId, userId, userId]
        );
        res.json({ success: true, message: "OK", data: tasks }); break;
      }

      case "important": {
        const [favoriteLists, favoriteTasks] = await Promise.all([
          q<RowDataPacket>(
            `SELECT
               l.id, l.uuid, l.name, l.color, l.group_id AS groupId,
               g.name AS groupName, g.uuid AS groupUuid,
               (SELECT COUNT(*) FROM todo_tasks t WHERE t.list_id = l.id) AS taskCount,
               (SELECT COUNT(*) FROM todo_tasks t WHERE t.list_id = l.id AND t.status = 'pending') AS pendingCount
             FROM todo_lists l
             LEFT JOIN todo_groups g ON g.id = l.group_id
             WHERE l.is_favorite = 1 AND l.created_by = ?
             ORDER BY l.sort_order ASC`,
            [userId]
          ),
          q<RowDataPacket>(
            `SELECT ${SMART_TASK_SEL}
             FROM todo_tasks t
             JOIN todo_lists l ON l.id = t.list_id
             WHERE t.is_favorite = 1 AND t.created_by = ? AND t.status = 'pending'
             ORDER BY t.sort_order ASC`,
            [userId]
          ),
        ]);
        res.json({ success: true, message: "OK", data: { favoriteLists, favoriteTasks } }); break;
      }

      case "completed": {
        const days = Math.min(parseInt(String(req.query["days"] ?? "7"), 10) || 7, 30);
        const tasks = await q<RowDataPacket>(
          `SELECT ${SMART_TASK_SEL}
           FROM todo_tasks t
           JOIN todo_lists l ON l.id = t.list_id
           WHERE t.status = 'completed'
             AND t.created_by = ?
             AND t.completed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
           ORDER BY t.completed_at DESC`,
          [userId, days]
        );
        res.json({ success: true, message: "OK", data: tasks }); break;
      }

      case "overdue": {
        const tasks = await q<RowDataPacket>(
          `SELECT ${SMART_TASK_SEL}
           FROM todo_tasks t
           JOIN todo_lists l ON l.id = t.list_id
           WHERE t.due_date < CURDATE()
             AND t.status = 'pending'
             AND (t.created_by = ?
                  OR t.assigned_to = ?
                  OR EXISTS (SELECT 1 FROM todo_task_members tm WHERE tm.task_id = t.id AND tm.user_id = ?)
                  OR EXISTS (SELECT 1 FROM todo_list_members lm WHERE lm.list_id = t.list_id AND lm.user_id = ?)
                  OR EXISTS (SELECT 1 FROM todo_lists tl WHERE tl.id = t.list_id AND tl.assigned_to = ?))
           ORDER BY t.due_date ASC`,
          [userId, userId, userId, userId, userId]
        );
        res.json({ success: true, message: "OK", data: tasks }); break;
      }

      default:
        res.status(400).json({ success: false, message: `Unknown smart view: ${view}` });
    }
  } catch (err) {
    console.error("[todo-tasks/smart-view]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
