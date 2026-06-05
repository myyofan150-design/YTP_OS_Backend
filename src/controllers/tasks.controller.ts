// src/controllers/tasks.controller.ts
import { Request, Response } from "express";
import { q, run, RowDataPacket } from "../lib/db";
import { logActivity } from "../lib/logger";
import { uploadFile, deleteFile } from "../lib/storage";

const TASK_SEL = `
  t.id, t.uuid, t.title, t.description, t.status, t.priority,
  t.due_date AS dueDate, t.client_id AS clientId, t.assigned_to_id AS assignedToId,
  t.assigned_by_id AS assignedById, t.parent_task_id AS parentTaskId,
  t.created_at AS createdAt, t.updated_at AS updatedAt,
  u1.id AS atId, u1.name AS atName, COALESCE(emp_at.photo_url, u1.avatar_url) AS atAvatar,
  u2.id AS abId, u2.name AS abName,
  c.id AS clId, c.uuid AS clUuid, c.company_name AS clCompany,
  (SELECT COUNT(*) FROM task_comments tc WHERE tc.task_id = t.id) AS commentCount,
  (SELECT COUNT(*) FROM task_attachments ta WHERE ta.task_id = t.id) AS attachmentCount,
  (SELECT COUNT(*) FROM tasks st WHERE st.parent_task_id = t.id) AS subTaskCount`;

const TASK_JOINS = `FROM tasks t
  LEFT JOIN users u1 ON t.assigned_to_id = u1.id
  LEFT JOIN employees emp_at ON emp_at.user_id = u1.id
  LEFT JOIN users u2 ON t.assigned_by_id = u2.id
  LEFT JOIN clients c ON t.client_id = c.id`;

type Member = { id: number; name: string; avatarUrl?: string | null };

function mapTask(row: RowDataPacket) {
  return {
    id: row["id"], uuid: row["uuid"], title: row["title"],
    description: row["description"], status: row["status"], priority: row["priority"],
    dueDate: row["dueDate"], clientId: row["clientId"],
    assignedToId: row["assignedToId"], assignedById: row["assignedById"],
    parentTaskId: row["parentTaskId"],
    createdAt: row["createdAt"], updatedAt: row["updatedAt"],
    assignedTo: row["atId"] ? { id: row["atId"], name: row["atName"], avatarUrl: row["atAvatar"] } as Member : null,
    assignedBy: row["abId"] ? { id: row["abId"], name: row["abName"] } : null,
    client:     row["clId"] ? { id: row["clId"], uuid: row["clUuid"], companyName: row["clCompany"] } : null,
    _count: {
      comments: Number(row["commentCount"]),
      attachments: Number(row["attachmentCount"]),
      subTasks: Number(row["subTaskCount"]),
    },
    members: [] as Member[],
  };
}

type MappedTask = ReturnType<typeof mapTask>;

async function attachMembers(tasks: MappedTask[]): Promise<MappedTask[]> {
  if (tasks.length === 0) return tasks;
  const ids = tasks.map((t) => t.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = await q<RowDataPacket>(
    `SELECT tm.task_id AS taskId, u.id, u.name, COALESCE(emp.photo_url, u.avatar_url) AS avatarUrl
     FROM task_members tm
     JOIN users u ON tm.user_id = u.id
     LEFT JOIN employees emp ON emp.user_id = u.id
     WHERE tm.task_id IN (${placeholders}) ORDER BY tm.created_at ASC`,
    ids
  );
  const byTask: Record<number, Member[]> = {};
  for (const r of rows) {
    const tid = Number(r["taskId"]);
    if (!byTask[tid]) byTask[tid] = [];
    byTask[tid].push({ id: Number(r["id"]), name: String(r["name"]), avatarUrl: r["avatarUrl"] ?? null });
  }
  return tasks.map((t) => {
    const members = byTask[t.id] ?? [];
    // Backward-compat: if no task_members row yet, synthesize from assignedTo
    if (members.length === 0 && t.assignedTo) members.push(t.assignedTo);
    return { ...t, members };
  });
}

// Replaces all task_members for a task; does NOT touch assigned_to_id (caller handles it)
async function setTaskMembers(taskId: number, memberIds: number[], assignedById: number): Promise<void> {
  await run("DELETE FROM task_members WHERE task_id = ?", [taskId]);
  for (const uid of memberIds) {
    await run(
      "INSERT IGNORE INTO task_members (task_id, user_id, assigned_by_id) VALUES (?, ?, ?)",
      [taskId, uid, assignedById]
    );
  }
}

function roleWhere(userId: number, role: string): { sql: string; params: unknown[] } {
  if (role === "EMPLOYEE") return {
    sql: "AND (t.assigned_to_id = ? OR EXISTS (SELECT 1 FROM task_members tm WHERE tm.task_id = t.id AND tm.user_id = ?))",
    params: [userId, userId],
  };
  if (role === "TEAM_LEAD") return {
    sql: "AND (t.assigned_to_id = ? OR t.assigned_by_id = ? OR EXISTS (SELECT 1 FROM task_members tm WHERE tm.task_id = t.id AND tm.user_id = ?))",
    params: [userId, userId, userId],
  };
  return { sql: "", params: [] };
}

export async function listTasks(req: Request, res: Response): Promise<void> {
  try {
    const { status, priority, clientId, assignedToId, search, overdue } = req.query as Record<string, string | undefined>;
    const rw = roleWhere(req.user!.id, req.user!.role);
    let sql = `SELECT ${TASK_SEL} ${TASK_JOINS} WHERE t.parent_task_id IS NULL ${rw.sql}`;
    const p: unknown[] = [...rw.params];
    if (status)       { sql += " AND t.status = ?";          p.push(status); }
    if (priority)     { sql += " AND t.priority = ?";        p.push(priority); }
    if (clientId)     { sql += " AND t.client_id = ?";       p.push(Number(clientId)); }
    if (assignedToId) {
      sql += " AND (t.assigned_to_id = ? OR EXISTS (SELECT 1 FROM task_members tm WHERE tm.task_id = t.id AND tm.user_id = ?))";
      p.push(Number(assignedToId), Number(assignedToId));
    }
    if (search)       { sql += " AND t.title LIKE ?";        p.push(`%${search}%`); }
    if (overdue === "true") { sql += " AND t.due_date < CURDATE() AND t.status != 'DONE'"; }
    sql += " ORDER BY t.due_date ASC, t.created_at DESC";
    const rows = await q<RowDataPacket>(sql, p as string[]);
    const withMembers = await attachMembers(rows.map(mapTask));
    res.json({ success: true, message: "OK", data: withMembers });
  } catch (err) {
    console.error("[tasks/list]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function createTask(req: Request, res: Response): Promise<void> {
  try {
    if (req.user!.role === "EMPLOYEE") {
      res.status(403).json({ success: false, message: "Employees cannot create tasks" });
      return;
    }

    const { title, description, status, priority, dueDate, clientId, assignedToId, memberIds } = req.body as Record<string, unknown>;
    if (!title) { res.status(400).json({ success: false, message: "title is required" }); return; }

    // Resolve member IDs — new multi-member field takes precedence over legacy assignedToId
    const rawMemberIds = Array.isArray(memberIds)
      ? (memberIds as unknown[]).map(Number).filter(Boolean)
      : assignedToId
      ? [Number(assignedToId)]
      : [];

    const effectiveMemberIds = req.user!.role === "EMPLOYEE" ? [req.user!.id] : rawMemberIds;
    const primaryAssignee = effectiveMemberIds[0] ?? null;

    const result = await run(
      `INSERT INTO tasks (title, description, status, priority, due_date, client_id, assigned_to_id, assigned_by_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(title), description ? String(description) : null,
        status ?? "TODO", priority ?? "MEDIUM",
        dueDate ? String(dueDate) : null,
        clientId ? Number(clientId) : null,
        primaryAssignee, req.user!.id,
      ]
    );

    if (effectiveMemberIds.length > 0) {
      await setTaskMembers(result.insertId, effectiveMemberIds, req.user!.id);
    }

    if (primaryAssignee && primaryAssignee !== req.user!.id) {
      await run(
        "INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, 'GENERAL', ?, ?, '/tasks')",
        [primaryAssignee, "New task assigned to you", String(title)]
      );
    }

    const rows = await q<RowDataPacket>(`SELECT ${TASK_SEL} ${TASK_JOINS} WHERE t.id = ?`, [result.insertId]);
    const [taskWithMembers] = await attachMembers([mapTask(rows[0])]);
    await logActivity(req.user!.id, "task.created", "Task", result.insertId, undefined, { title }, req.ip);
    res.status(201).json({ success: true, message: "Task created", data: taskWithMembers });
  } catch (err) {
    console.error("[tasks/create]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function getTask(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const rows = await q<RowDataPacket>(`SELECT ${TASK_SEL} ${TASK_JOINS} WHERE t.uuid = ?`, [uuid]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Task not found" }); return; }
    const task = mapTask(rows[0]);

    if (req.user!.role === "EMPLOYEE") {
      const isPrimary = rows[0]["assignedToId"] === req.user!.id;
      if (!isPrimary) {
        const memberCheck = await q<RowDataPacket>(
          "SELECT 1 FROM task_members WHERE task_id = ? AND user_id = ?",
          [task.id, req.user!.id]
        );
        if (memberCheck.length === 0) {
          res.status(403).json({ success: false, message: "Access denied" }); return;
        }
      }
    }

    // Sub-tasks
    const subRows = await q<RowDataPacket>(
      `SELECT t.id, t.uuid, t.title, t.status, t.priority, u1.id AS atId, u1.name AS atName, COALESCE(emp_sub.photo_url, u1.avatar_url) AS atAvatar
       FROM tasks t LEFT JOIN users u1 ON t.assigned_to_id = u1.id LEFT JOIN employees emp_sub ON emp_sub.user_id = u1.id WHERE t.parent_task_id = ?`,
      [task.id]
    );
    const subTasks = subRows.map((s) => ({
      id: s["id"], uuid: s["uuid"], title: s["title"], status: s["status"], priority: s["priority"],
      assignedTo: s["atId"] ? { id: s["atId"], name: s["atName"], avatarUrl: s["atAvatar"] } : null,
    }));

    // Comments
    const comments = await q<RowDataPacket>(
      `SELECT tc.id, tc.body, tc.created_at AS createdAt, u.id AS uId, u.name AS uName, COALESCE(emp_c.photo_url, u.avatar_url) AS uAvatar
       FROM task_comments tc JOIN users u ON tc.user_id = u.id LEFT JOIN employees emp_c ON emp_c.user_id = u.id WHERE tc.task_id = ? ORDER BY tc.created_at ASC`,
      [task.id]
    );

    // Attachments
    const attachments = await q<RowDataPacket>(
      "SELECT id, file_path AS filePath, file_name AS fileName, uploaded_by AS uploadedBy, created_at AS createdAt FROM task_attachments WHERE task_id = ? ORDER BY created_at DESC",
      [task.id]
    );

    // Members
    const [taskWithMembers] = await attachMembers([task]);

    res.json({
      success: true, message: "OK",
      data: {
        ...taskWithMembers,
        subTasks,
        comments: comments.map((c) => ({ id: c["id"], body: c["body"], createdAt: c["createdAt"], userId: c["uId"], user: { id: c["uId"], name: c["uName"], avatarUrl: c["uAvatar"] } })),
        attachments,
      },
    });
  } catch (err) {
    console.error("[tasks/get]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function updateTask(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const existRows = await q<RowDataPacket>("SELECT id, assigned_to_id AS assignedToId, assigned_by_id AS assignedById, status, title FROM tasks WHERE uuid = ?", [uuid]);
    if (!existRows[0]) { res.status(404).json({ success: false, message: "Task not found" }); return; }
    const existing = existRows[0];

    if (req.user!.role === "EMPLOYEE") {
      const isPrimary = existing["assignedToId"] === req.user!.id;
      if (!isPrimary) {
        const memberCheck = await q<RowDataPacket>(
          "SELECT 1 FROM task_members WHERE task_id = ? AND user_id = ?",
          [existing["id"], req.user!.id]
        );
        if (memberCheck.length === 0) {
          res.status(403).json({ success: false, message: "Access denied" }); return;
        }
      }
    }

    const { title, description, status, priority, dueDate, clientId, assignedToId, memberIds } = req.body as Record<string, unknown>;
    const isEmployee = req.user!.role === "EMPLOYEE";
    const sets: string[] = [];
    const p: unknown[] = [];

    if (status != null) { sets.push("status = ?"); p.push(String(status)); }

    if (!isEmployee) {
      if (title       != null) { sets.push("title = ?");       p.push(String(title)); }
      if (description != null) { sets.push("description = ?"); p.push(String(description)); }
      if (priority    != null) { sets.push("priority = ?");    p.push(String(priority)); }
      if (dueDate     != null) { sets.push("due_date = ?");    p.push(String(dueDate)); }
      if (clientId    != null) { sets.push("client_id = ?");   p.push(clientId ? Number(clientId) : null); }

      if (memberIds != null && Array.isArray(memberIds)) {
        // Multi-member path: sync task_members + update primary assignee
        const mids = (memberIds as unknown[]).map(Number).filter(Boolean);
        await setTaskMembers(Number(existing["id"]), mids, req.user!.id);
        sets.push("assigned_to_id = ?");
        p.push(mids[0] ?? null);
      } else if (assignedToId != null) {
        // Legacy single-assignee path: keep backward compat
        const aid = assignedToId ? Number(assignedToId) : null;
        sets.push("assigned_to_id = ?");
        p.push(aid);
        if (aid) await setTaskMembers(Number(existing["id"]), [aid], req.user!.id);
        else await run("DELETE FROM task_members WHERE task_id = ?", [existing["id"]]);
      }
    }

    if (sets.length > 0) {
      p.push(existing["id"]);
      await run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, p as string[]);
    }

    if (status === "DONE" && existing["status"] !== "DONE" && existing["assignedById"] !== req.user!.id) {
      await run(
        "INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, 'GENERAL', 'Task marked as done', ?, '/tasks')",
        [existing["assignedById"], String(existing["title"])]
      );
    }

    const updRows = await q<RowDataPacket>(`SELECT ${TASK_SEL} ${TASK_JOINS} WHERE t.id = ?`, [existing["id"]]);
    const [taskWithMembers] = await attachMembers([mapTask(updRows[0])]);
    await logActivity(req.user!.id, "task.updated", "Task", Number(existing["id"]), existing, updRows[0], req.ip);
    res.json({ success: true, message: "Task updated", data: taskWithMembers });
  } catch (err) {
    console.error("[tasks/update]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function deleteTask(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const rows = await q<RowDataPacket>("SELECT id FROM tasks WHERE uuid = ?", [uuid]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Task not found" }); return; }
    await run("DELETE FROM tasks WHERE id = ?", [rows[0]["id"]]);
    await logActivity(req.user!.id, "task.deleted", "Task", Number(rows[0]["id"]), rows[0], undefined, req.ip);
    res.json({ success: true, message: "Task deleted", data: null });
  } catch (err) {
    console.error("[tasks/delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function updateTaskStatus(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const { status } = req.body as { status?: string };
    if (!status) { res.status(400).json({ success: false, message: "status is required" }); return; }

    const rows = await q<RowDataPacket>("SELECT id, assigned_to_id AS assignedToId, assigned_by_id AS assignedById, status AS prevStatus, title FROM tasks WHERE uuid = ?", [uuid]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Task not found" }); return; }

    if (req.user!.role === "EMPLOYEE") {
      const isPrimary = rows[0]["assignedToId"] === req.user!.id;
      if (!isPrimary) {
        const memberCheck = await q<RowDataPacket>(
          "SELECT 1 FROM task_members WHERE task_id = ? AND user_id = ?",
          [rows[0]["id"], req.user!.id]
        );
        if (memberCheck.length === 0) {
          res.status(403).json({ success: false, message: "Access denied" }); return;
        }
      }
    }

    await run("UPDATE tasks SET status = ? WHERE id = ?", [status, rows[0]["id"]]);

    if (status === "DONE" && rows[0]["prevStatus"] !== "DONE" && rows[0]["assignedById"] !== req.user!.id) {
      await run(
        "INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, 'GENERAL', 'Task marked as done', ?, '/tasks')",
        [rows[0]["assignedById"], String(rows[0]["title"])]
      );
    }

    const updRows = await q<RowDataPacket>(`SELECT ${TASK_SEL} ${TASK_JOINS} WHERE t.id = ?`, [rows[0]["id"]]);
    res.json({ success: true, message: "Status updated", data: mapTask(updRows[0]) });
  } catch (err) {
    console.error("[tasks/status]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function addComment(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const { body } = req.body as { body?: string };
    if (!body?.trim()) { res.status(400).json({ success: false, message: "body is required" }); return; }

    const rows = await q<RowDataPacket>("SELECT id FROM tasks WHERE uuid = ?", [uuid]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Task not found" }); return; }

    const result = await run(
      "INSERT INTO task_comments (task_id, user_id, body) VALUES (?, ?, ?)",
      [rows[0]["id"], req.user!.id, body.trim()]
    );
    const comments = await q<RowDataPacket>(
      `SELECT tc.id, tc.body, tc.created_at AS createdAt, u.id AS uId, u.name AS uName, COALESCE(emp_c2.photo_url, u.avatar_url) AS uAvatar
       FROM task_comments tc JOIN users u ON tc.user_id = u.id LEFT JOIN employees emp_c2 ON emp_c2.user_id = u.id WHERE tc.id = ?`,
      [result.insertId]
    );
    const c = comments[0];
    res.status(201).json({
      success: true, message: "Comment added",
      data: { id: c["id"], body: c["body"], createdAt: c["createdAt"], user: { id: c["uId"], name: c["uName"], avatarUrl: c["uAvatar"] } },
    });
  } catch (err) {
    console.error("[tasks/comments/add]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function deleteComment(req: Request, res: Response): Promise<void> {
  try {
    const commentId = parseInt(String(req.params["commentId"] ?? "0"), 10);
    const rows = await q<RowDataPacket>("SELECT id, user_id AS userId FROM task_comments WHERE id = ?", [commentId]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Comment not found" }); return; }
    const isAdmin = ["SUPER_ADMIN", "ADMIN"].includes(req.user!.role);
    if (!isAdmin && rows[0]["userId"] !== req.user!.id) { res.status(403).json({ success: false, message: "Access denied" }); return; }
    await run("DELETE FROM task_comments WHERE id = ?", [commentId]);
    res.json({ success: true, message: "Comment deleted", data: null });
  } catch (err) {
    console.error("[tasks/comments/delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function uploadAttachment(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const rows = await q<RowDataPacket>("SELECT id FROM tasks WHERE uuid = ?", [uuid]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Task not found" }); return; }
    if (!req.file) { res.status(400).json({ success: false, message: "No file uploaded" }); return; }
    const { url } = await uploadFile(req.file.buffer, { folder: "task-attachments", filename: req.file.originalname, mimetype: req.file.mimetype });
    const result = await run(
      "INSERT INTO task_attachments (task_id, file_path, file_name, uploaded_by) VALUES (?, ?, ?, ?)",
      [rows[0]["id"], url, req.file.originalname, req.user!.id]
    );
    res.status(201).json({ success: true, message: "Attachment uploaded", data: { id: result.insertId, filePath: url, fileName: req.file.originalname } });
  } catch (err) {
    console.error("[tasks/attachments/upload]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function deleteAttachment(req: Request, res: Response): Promise<void> {
  try {
    const attachId = parseInt(String(req.params["attachId"] ?? "0"), 10);
    const rows = await q<RowDataPacket>("SELECT id, file_path AS filePath, uploaded_by AS uploadedBy FROM task_attachments WHERE id = ?", [attachId]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Attachment not found" }); return; }
    const isAdmin = ["SUPER_ADMIN", "ADMIN"].includes(req.user!.role);
    if (!isAdmin && rows[0]["uploadedBy"] !== req.user!.id) { res.status(403).json({ success: false, message: "Access denied" }); return; }
    await deleteFile(String(rows[0]["filePath"]));
    await run("DELETE FROM task_attachments WHERE id = ?", [attachId]);
    res.json({ success: true, message: "Attachment deleted", data: null });
  } catch (err) {
    console.error("[tasks/attachments/delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
