// src/controllers/notes.controller.ts
import { Request, Response } from "express";
import path from "path";
import fs from "fs";
import { q, run, pool, RowDataPacket } from "../lib/db";
import { getRelativePath } from "../lib/storage";

const ADMIN_ROLES = ["SUPER_ADMIN", "ADMIN"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 150);
}

async function resolveTagUuids(uuids: unknown[]): Promise<number[]> {
  if (!Array.isArray(uuids) || uuids.length === 0) return [];
  const ph = uuids.map(() => "?").join(",");
  const rows = await q<RowDataPacket>(
    `SELECT id FROM note_tags WHERE uuid IN (${ph})`, uuids.map(String)
  );
  return rows.map(r => Number(r["id"]));
}

// ─── SELECT fragment ──────────────────────────────────────────────────────────

const NOTE_SEL = `
  n.id, n.uuid, n.title,
  LEFT(n.content, 300) AS contentExcerpt,
  n.category, n.priority, n.status,
  n.is_starred AS isStarred, n.is_read AS isRead,
  n.is_snoozed AS isSnoozed, n.snoozed_until AS snoozedUntil,
  n.linked_client_id AS linkedClientId,
  n.linked_module AS linkedModule, n.linked_module_id AS linkedModuleId,
  n.linked_module_uuid AS linkedModuleUuid,
  n.assigned_to AS assignedTo, n.created_by AS createdBy,
  n.deleted_at AS deletedAt, n.created_at AS createdAt, n.updated_at AS updatedAt,
  c.company_name AS linkedClientName,
  u_assign.name AS assignedUserName, u_assign.avatar_url AS assignedUserAvatar,
  u_create.name AS createdByName,  u_create.avatar_url AS createdByAvatar,
  (SELECT COUNT(*) FROM note_attachments na WHERE na.note_id = n.id) AS attachmentCount`;

const NOTE_JOINS = `
  FROM notes n
  LEFT JOIN clients c      ON c.id  = n.linked_client_id
  LEFT JOIN users u_assign ON u_assign.id = n.assigned_to
  LEFT JOIN users u_create ON u_create.id = n.created_by`;

function shapeNote(row: RowDataPacket, tags: RowDataPacket[] = []): object {
  return {
    id:               row["id"],
    uuid:             row["uuid"],
    title:            row["title"],
    contentExcerpt:   row["contentExcerpt"] ?? null,
    category:         row["category"],
    priority:         row["priority"],
    status:           row["status"],
    isStarred:        Boolean(row["isStarred"]),
    isRead:           Boolean(row["isRead"]),
    isSnoozed:        Boolean(row["isSnoozed"]),
    snoozedUntil:     row["snoozedUntil"] ?? null,
    linkedClientId:   row["linkedClientId"] ?? null,
    linkedClient:     row["linkedClientId"]
      ? { id: row["linkedClientId"], companyName: row["linkedClientName"] }
      : null,
    linkedModule:     row["linkedModule"],
    linkedModuleId:   row["linkedModuleId"] ?? null,
    linkedModuleUuid: row["linkedModuleUuid"] ?? null,
    assignedTo:       row["assignedTo"] ?? null,
    assignedUser:     row["assignedTo"]
      ? { id: row["assignedTo"], name: row["assignedUserName"], avatarUrl: row["assignedUserAvatar"] ?? null }
      : null,
    createdBy:        row["createdBy"],
    createdByUser:    { name: row["createdByName"], avatarUrl: row["createdByAvatar"] ?? null },
    tags,
    attachmentCount:  Number(row["attachmentCount"] ?? 0),
    deletedAt:        row["deletedAt"] ?? null,
    createdAt:        row["createdAt"],
    updatedAt:        row["updatedAt"],
  };
}

async function fetchTagsForNotes(noteIds: number[]): Promise<Record<number, RowDataPacket[]>> {
  if (noteIds.length === 0) return {};
  const ph = noteIds.map(() => "?").join(",");
  const rows = await q<RowDataPacket>(
    `SELECT m.note_id AS noteId, t.id, t.uuid, t.name, t.color
     FROM note_tag_map m
     JOIN note_tags t ON t.id = m.tag_id
     WHERE m.note_id IN (${ph})`,
    noteIds
  );
  const map: Record<number, RowDataPacket[]> = {};
  rows.forEach(r => {
    const nid = Number(r["noteId"]);
    if (!map[nid]) map[nid] = [];
    map[nid].push(r);
  });
  return map;
}

async function getFullNote(noteId: number): Promise<object | null> {
  const fullSel = NOTE_SEL.replace("LEFT(n.content, 300) AS contentExcerpt", "n.content AS contentExcerpt");

  const [note] = await q<RowDataPacket>(`SELECT ${fullSel} ${NOTE_JOINS} WHERE n.id = ?`, [noteId]);
  if (!note) return null;

  const [tags, attachments, mentions] = await Promise.all([
    q<RowDataPacket>(
      `SELECT t.id, t.uuid, t.name, t.color FROM note_tag_map m JOIN note_tags t ON t.id = m.tag_id WHERE m.note_id = ?`,
      [noteId]
    ),
    q<RowDataPacket>(
      `SELECT id, uuid, note_id AS noteId, file_name AS fileName, file_path AS filePath,
              file_size AS fileSize, file_type AS fileType, uploaded_by AS uploadedBy, created_at AS createdAt
       FROM note_attachments WHERE note_id = ? ORDER BY created_at ASC`,
      [noteId]
    ),
    q<RowDataPacket>(
      `SELECT m.id, m.note_id AS noteId, m.mentioned_user_id AS mentionedUserId, u.name, u.avatar_url AS avatarUrl
       FROM note_mentions m JOIN users u ON u.id = m.mentioned_user_id WHERE m.note_id = ?`,
      [noteId]
    ),
  ]);

  return {
    ...shapeNote(note, tags),
    content:     note["contentExcerpt"],
    attachments,
    mentions: mentions.map(m => ({
      id: m["id"], noteId: m["noteId"], mentionedUserId: m["mentionedUserId"],
      user: { name: m["name"], avatarUrl: m["avatarUrl"] ?? null },
    })),
  };
}

// ─── listNotes ────────────────────────────────────────────────────────────────

export async function listNotes(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const role   = req.user!.role;
    const {
      category, priority, status = "active", tagId, assignedTo,
      isStarred, hasAttachments, linkedModule, search,
      sortBy = "newest", page = "1", limit = "30",
    } = req.query as Record<string, string | undefined>;

    const isAdmin = ADMIN_ROLES.includes(role);
    const pageNum  = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
    const offset   = (pageNum - 1) * limitNum;

    let where = `WHERE n.status != 'deleted'`;
    const p: unknown[] = [];

    if (!isAdmin) {
      where += " AND (n.created_by = ? OR n.assigned_to = ?)";
      p.push(userId, userId);
    }

    if (status)       { where += " AND n.status = ?";        p.push(status); }
    if (category)     { where += " AND n.category = ?";      p.push(category); }
    if (priority)     { where += " AND n.priority = ?";      p.push(priority); }
    if (linkedModule) { where += " AND n.linked_module = ?"; p.push(linkedModule); }
    if (assignedTo)   { where += " AND n.assigned_to = ?";   p.push(Number(assignedTo)); }
    if (isStarred === "true") { where += " AND n.is_starred = 1"; }
    if (hasAttachments === "true") {
      where += " AND EXISTS (SELECT 1 FROM note_attachments na WHERE na.note_id = n.id)";
    }
    if (tagId) {
      where += " AND EXISTS (SELECT 1 FROM note_tag_map m JOIN note_tags nt ON nt.id = m.tag_id WHERE m.note_id = n.id AND nt.uuid = ?)";
      p.push(tagId);
    }
    if (search) {
      where += " AND MATCH(n.title, n.content) AGAINST(? IN BOOLEAN MODE)";
      p.push(`${search}*`);
    }

    const orderMap: Record<string, string> = {
      newest:  "n.created_at DESC",
      oldest:  "n.created_at ASC",
      updated: "n.updated_at DESC",
    };
    const orderBy = orderMap[sortBy] ?? "n.created_at DESC";

    const [[{ total }]] = await Promise.all([
      q<RowDataPacket>(`SELECT COUNT(*) AS total ${NOTE_JOINS} ${where}`, p),
    ]);

    const notes = await q<RowDataPacket>(
      `SELECT ${NOTE_SEL} ${NOTE_JOINS} ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...p, limitNum, offset]
    );

    const noteIds = notes.map(n => Number(n["id"]));
    const tagsMap = await fetchTagsForNotes(noteIds);

    res.json({
      success: true, message: "OK",
      data: {
        notes: notes.map(n => ({
          ...shapeNote(n, tagsMap[Number(n["id"])] ?? []),
          contentExcerpt: stripHtml(String(n["contentExcerpt"] ?? "")),
        })),
        total: Number(total),
        page: pageNum,
        limit: limitNum,
      },
    });
  } catch (err) {
    console.error("[notes/list]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── getNote ──────────────────────────────────────────────────────────────────

export async function getNote(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId = req.user!.id;
    const isAdmin = ADMIN_ROLES.includes(req.user!.role);

    const [meta] = await q<RowDataPacket>(
      `SELECT id, created_by AS createdBy, assigned_to AS assignedTo, is_read AS isRead, status
       FROM notes WHERE uuid = ? AND status != 'deleted'`, [uuid]
    );
    if (!meta) {
      res.status(404).json({ success: false, message: "Note not found" });
      return;
    }
    if (!isAdmin && Number(meta["createdBy"]) !== userId && Number(meta["assignedTo"]) !== userId) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    const noteId = Number(meta["id"]);

    if (!meta["isRead"]) {
      run(`UPDATE notes SET is_read = 1 WHERE id = ?`, [noteId]).catch(() => {});
    }

    const fullSel = NOTE_SEL.replace("LEFT(n.content, 300) AS contentExcerpt", "n.content AS contentExcerpt");
    const [note] = await q<RowDataPacket>(`SELECT ${fullSel} ${NOTE_JOINS} WHERE n.id = ?`, [noteId]);

    const [tags, attachments, mentions] = await Promise.all([
      q<RowDataPacket>(
        `SELECT t.id, t.uuid, t.name, t.color FROM note_tag_map m JOIN note_tags t ON t.id = m.tag_id WHERE m.note_id = ?`,
        [noteId]
      ),
      q<RowDataPacket>(
        `SELECT id, uuid, note_id AS noteId, file_name AS fileName, file_path AS filePath,
                file_size AS fileSize, file_type AS fileType, uploaded_by AS uploadedBy, created_at AS createdAt
         FROM note_attachments WHERE note_id = ? ORDER BY created_at ASC`,
        [noteId]
      ),
      q<RowDataPacket>(
        `SELECT m.id, m.note_id AS noteId, m.mentioned_user_id AS mentionedUserId, u.name, u.avatar_url AS avatarUrl
         FROM note_mentions m JOIN users u ON u.id = m.mentioned_user_id WHERE m.note_id = ?`,
        [noteId]
      ),
    ]);

    const shaped = {
      ...shapeNote(note, tags),
      content: note["contentExcerpt"],
      attachments,
      mentions: mentions.map(m => ({
        id: m["id"], noteId: m["noteId"], mentionedUserId: m["mentionedUserId"],
        user: { name: m["name"], avatarUrl: m["avatarUrl"] ?? null },
      })),
    };

    res.json({ success: true, message: "OK", data: shaped });
  } catch (err) {
    console.error("[notes/get]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── createNote ───────────────────────────────────────────────────────────────

export async function createNote(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const {
      title, content, category, priority, status,
      isStarred, linkedClientId, linkedModule, linkedModuleId, linkedModuleUuid,
      assignedTo, tagIds, mentionUserIds,
    } = req.body as Record<string, unknown>;

    if (!title || !String(title).trim()) {
      res.status(400).json({ success: false, message: "title is required" });
      return;
    }

    const result = await run(
      `INSERT INTO notes (title, content, category, priority, status, is_starred,
         linked_client_id, linked_module, linked_module_id, linked_module_uuid,
         assigned_to, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(title).trim(),
        content        ? String(content)            : null,
        category       ? String(category)           : "personal",
        priority       ? String(priority)           : "low",
        status         ? String(status)             : "active",
        isStarred      ? 1                          : 0,
        linkedClientId ? Number(linkedClientId)     : null,
        linkedModule   ? String(linkedModule)       : "none",
        linkedModuleId ? Number(linkedModuleId)     : null,
        linkedModuleUuid ? String(linkedModuleUuid) : null,
        assignedTo     ? Number(assignedTo)         : null,
        userId,
      ]
    );

    const noteId = result.insertId;

    // resolve tag UUIDs → integer IDs
    const resolvedTagIds = await resolveTagUuids(Array.isArray(tagIds) ? tagIds : []);
    for (const tid of resolvedTagIds) {
      await run(`INSERT IGNORE INTO note_tag_map (note_id, tag_id) VALUES (?, ?)`, [noteId, tid]);
    }

    if (Array.isArray(mentionUserIds) && mentionUserIds.length > 0) {
      for (const uid of mentionUserIds) {
        await run(`INSERT IGNORE INTO note_mentions (note_id, mentioned_user_id) VALUES (?, ?)`, [noteId, Number(uid)]);
      }
    }

    const data = await getFullNote(noteId);
    res.status(201).json({ success: true, message: "Note created", data });
  } catch (err) {
    console.error("[notes/create]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── updateNote ───────────────────────────────────────────────────────────────

export async function updateNote(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId  = req.user!.id;
    const isAdmin = ADMIN_ROLES.includes(req.user!.role);

    const [existing] = await q<RowDataPacket>(
      `SELECT id, created_by AS createdBy, assigned_to AS assignedTo, status, priority, title
       FROM notes WHERE uuid = ? AND status != 'deleted'`, [uuid]
    );
    if (!existing) {
      res.status(404).json({ success: false, message: "Note not found" });
      return;
    }
    if (!isAdmin && Number(existing["createdBy"]) !== userId && Number(existing["assignedTo"]) !== userId) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    const noteId = Number(existing["id"]);
    const {
      title, content, category, priority, status,
      isStarred, linkedClientId, linkedModule, linkedModuleId, linkedModuleUuid,
      assignedTo, tagIds, mentionUserIds,
    } = req.body as Record<string, unknown>;

    const sets: string[] = [];
    const params: unknown[] = [];

    if (title        !== undefined) { sets.push("title = ?");              params.push(String(title).trim()); }
    if (content      !== undefined) { sets.push("content = ?");            params.push(content ? String(content) : null); }
    if (category     !== undefined) { sets.push("category = ?");           params.push(String(category)); }
    if (priority     !== undefined) { sets.push("priority = ?");           params.push(String(priority)); }
    if (status       !== undefined) { sets.push("status = ?");             params.push(String(status)); }
    if (isStarred    !== undefined) { sets.push("is_starred = ?");         params.push(isStarred ? 1 : 0); }
    if (linkedClientId  !== undefined) { sets.push("linked_client_id = ?");  params.push(linkedClientId ? Number(linkedClientId) : null); }
    if (linkedModule    !== undefined) { sets.push("linked_module = ?");      params.push(String(linkedModule)); }
    if (linkedModuleId  !== undefined) { sets.push("linked_module_id = ?");   params.push(linkedModuleId ? Number(linkedModuleId) : null); }
    if (linkedModuleUuid !== undefined) { sets.push("linked_module_uuid = ?"); params.push(linkedModuleUuid ? String(linkedModuleUuid) : null); }
    if (assignedTo   !== undefined) { sets.push("assigned_to = ?");        params.push(assignedTo ? Number(assignedTo) : null); }

    if (sets.length > 0) {
      params.push(noteId);
      await run(`UPDATE notes SET ${sets.join(", ")} WHERE id = ?`, params);
    }

    // sync tags (full replace) — accepts UUIDs
    if (Array.isArray(tagIds)) {
      await run(`DELETE FROM note_tag_map WHERE note_id = ?`, [noteId]);
      const resolvedTagIds = await resolveTagUuids(tagIds);
      for (const tid of resolvedTagIds) {
        await run(`INSERT IGNORE INTO note_tag_map (note_id, tag_id) VALUES (?, ?)`, [noteId, tid]);
      }
    }

    // sync mentions (full replace)
    if (Array.isArray(mentionUserIds)) {
      await run(`DELETE FROM note_mentions WHERE note_id = ?`, [noteId]);
      for (const uid of mentionUserIds) {
        await run(`INSERT IGNORE INTO note_mentions (note_id, mentioned_user_id) VALUES (?, ?)`, [noteId, Number(uid)]);
      }
    }

    const data = await getFullNote(noteId);
    res.json({ success: true, message: "Note updated", data });
  } catch (err) {
    console.error("[notes/update]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── deleteNote (soft) ────────────────────────────────────────────────────────

export async function deleteNote(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId  = req.user!.id;
    const isAdmin = ADMIN_ROLES.includes(req.user!.role);

    const [existing] = await q<RowDataPacket>(
      `SELECT id, created_by AS createdBy FROM notes WHERE uuid = ? AND status != 'deleted'`, [uuid]
    );
    if (!existing) {
      res.status(404).json({ success: false, message: "Note not found" });
      return;
    }
    if (!isAdmin && Number(existing["createdBy"]) !== userId) {
      res.status(403).json({ success: false, message: "Only the creator or an admin can delete this note" });
      return;
    }

    await run(`UPDATE notes SET status = 'deleted', deleted_at = NOW() WHERE id = ?`, [existing["id"]]);
    res.json({ success: true, message: "Note deleted", data: null });
  } catch (err) {
    console.error("[notes/delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── restoreNote ──────────────────────────────────────────────────────────────

export async function restoreNote(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId  = req.user!.id;
    const isAdmin = ADMIN_ROLES.includes(req.user!.role);

    const [existing] = await q<RowDataPacket>(
      `SELECT id, created_by AS createdBy FROM notes WHERE uuid = ? AND status = 'deleted'`, [uuid]
    );
    if (!existing) {
      res.status(404).json({ success: false, message: "Deleted note not found" });
      return;
    }
    if (!isAdmin && Number(existing["createdBy"]) !== userId) {
      res.status(403).json({ success: false, message: "Only the creator or an admin can restore this note" });
      return;
    }

    await run(`UPDATE notes SET status = 'active', deleted_at = NULL WHERE id = ?`, [existing["id"]]);
    res.json({ success: true, message: "Note restored", data: null });
  } catch (err) {
    console.error("[notes/restore]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── duplicateNote ────────────────────────────────────────────────────────────

export async function duplicateNote(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId  = req.user!.id;
    const isAdmin = ADMIN_ROLES.includes(req.user!.role);

    const [orig] = await q<RowDataPacket>(
      `SELECT id, created_by AS createdBy, assigned_to AS assignedTo, title, content,
              category, priority, linked_client_id AS linkedClientId,
              linked_module AS linkedModule, linked_module_id AS linkedModuleId,
              linked_module_uuid AS linkedModuleUuid
       FROM notes WHERE uuid = ? AND status != 'deleted'`, [uuid]
    );
    if (!orig) {
      res.status(404).json({ success: false, message: "Note not found" });
      return;
    }
    if (!isAdmin && Number(orig["createdBy"]) !== userId && Number(orig["assignedTo"]) !== userId) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    const result = await run(
      `INSERT INTO notes (title, content, category, priority, status,
         linked_client_id, linked_module, linked_module_id, linked_module_uuid,
         assigned_to, created_by)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
      [
        `Copy of ${orig["title"]}`,
        orig["content"] ?? null,
        orig["category"],
        orig["priority"],
        orig["linkedClientId"] ?? null,
        orig["linkedModule"] ?? "none",
        orig["linkedModuleId"] ?? null,
        orig["linkedModuleUuid"] ?? null,
        orig["assignedTo"] ?? null,
        userId,
      ]
    );

    const newId = result.insertId;

    // copy tags
    const tagRows = await q<RowDataPacket>(
      `SELECT tag_id FROM note_tag_map WHERE note_id = ?`, [orig["id"]]
    );
    for (const t of tagRows) {
      await run(`INSERT IGNORE INTO note_tag_map (note_id, tag_id) VALUES (?, ?)`, [newId, t["tag_id"]]);
    }

    const data = await getFullNote(newId);
    res.status(201).json({ success: true, message: "Note duplicated", data });
  } catch (err) {
    console.error("[notes/duplicate]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── snoozeNote ───────────────────────────────────────────────────────────────

export async function snoozeNote(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const { snoozedUntil } = req.body as Record<string, unknown>;

    const [note] = await q<RowDataPacket>(
      `SELECT id FROM notes WHERE uuid = ? AND status != 'deleted'`, [uuid]
    );
    if (!note) {
      res.status(404).json({ success: false, message: "Note not found" });
      return;
    }

    if (snoozedUntil) {
      await run(
        `UPDATE notes SET is_snoozed = 1, snoozed_until = ? WHERE id = ?`,
        [new Date(String(snoozedUntil)), note["id"]]
      );
    } else {
      await run(
        `UPDATE notes SET is_snoozed = 0, snoozed_until = NULL WHERE id = ?`, [note["id"]]
      );
    }

    res.json({ success: true, message: snoozedUntil ? "Note snoozed" : "Note unsnoozed", data: null });
  } catch (err) {
    console.error("[notes/snooze]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── toggleStar ───────────────────────────────────────────────────────────────

export async function toggleStar(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;

    const [note] = await q<RowDataPacket>(
      `SELECT id, is_starred AS isStarred FROM notes WHERE uuid = ? AND status != 'deleted'`, [uuid]
    );
    if (!note) {
      res.status(404).json({ success: false, message: "Note not found" });
      return;
    }

    const newVal = note["isStarred"] ? 0 : 1;
    await run(`UPDATE notes SET is_starred = ? WHERE id = ?`, [newVal, note["id"]]);
    res.json({ success: true, message: newVal ? "Starred" : "Unstarred", data: { isStarred: Boolean(newVal) } });
  } catch (err) {
    console.error("[notes/star]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── archiveNote ──────────────────────────────────────────────────────────────

export async function archiveNote(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;

    const [note] = await q<RowDataPacket>(
      `SELECT id, status FROM notes WHERE uuid = ? AND status != 'deleted'`, [uuid]
    );
    if (!note) {
      res.status(404).json({ success: false, message: "Note not found" });
      return;
    }

    const newStatus = note["status"] === "archived" ? "active" : "archived";
    await run(`UPDATE notes SET status = ? WHERE id = ?`, [newStatus, note["id"]]);
    res.json({ success: true, message: `Note ${newStatus}`, data: { status: newStatus } });
  } catch (err) {
    console.error("[notes/archive]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── searchNotes ──────────────────────────────────────────────────────────────

export async function searchNotes(req: Request, res: Response): Promise<void> {
  try {
    const userId  = req.user!.id;
    const isAdmin = ADMIN_ROLES.includes(req.user!.role);
    const { q: query, limit = "20" } = req.query as Record<string, string | undefined>;

    if (!query || !query.trim()) {
      res.status(400).json({ success: false, message: "q (search term) is required" });
      return;
    }

    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const term     = query.trim();

    let where = `WHERE n.status != 'deleted' AND MATCH(n.title, n.content) AGAINST(? IN BOOLEAN MODE)`;
    const p: unknown[] = [`${term}*`];

    if (!isAdmin) {
      where += " AND (n.created_by = ? OR n.assigned_to = ?)";
      p.push(userId, userId);
    }

    const notes = await q<RowDataPacket>(
      `SELECT ${NOTE_SEL} ${NOTE_JOINS} ${where} LIMIT ?`,
      [...p, limitNum]
    );

    // persist recent search
    pool.execute(
      `INSERT INTO note_recent_searches (user_id, search_term, searched_at)
       VALUES (?, ?, NOW())
       ON DUPLICATE KEY UPDATE searched_at = NOW()`,
      [userId, term.slice(0, 300)]
    ).catch(() => {});

    const noteIds = notes.map(n => Number(n["id"]));
    const tagsMap = await fetchTagsForNotes(noteIds);

    res.json({
      success: true, message: "OK",
      data: notes.map(n => ({
        ...shapeNote(n, tagsMap[Number(n["id"])] ?? []),
        contentExcerpt: stripHtml(String(n["contentExcerpt"] ?? "")),
      })),
    });
  } catch (err) {
    console.error("[notes/search]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── getRecentSearches ────────────────────────────────────────────────────────

export async function getRecentSearches(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const rows = await q<RowDataPacket>(
      `SELECT search_term AS term, searched_at AS searchedAt
       FROM note_recent_searches
       WHERE user_id = ?
       ORDER BY searched_at DESC
       LIMIT 10`,
      [userId]
    );
    res.json({ success: true, message: "OK", data: rows });
  } catch (err) {
    console.error("[notes/recent-searches]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── clearRecentSearches ──────────────────────────────────────────────────────

export async function clearRecentSearches(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    await run(`DELETE FROM note_recent_searches WHERE user_id = ?`, [userId]);
    res.json({ success: true, message: "Recent searches cleared", data: null });
  } catch (err) {
    console.error("[notes/clear-recent-searches]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── uploadAttachment ─────────────────────────────────────────────────────────

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/png", "image/jpeg", "image/gif",
  "video/mp4", "video/quicktime",
  "application/zip", "application/x-zip-compressed",
]);

export async function uploadAttachment(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId  = req.user!.id;
    const isAdmin = ADMIN_ROLES.includes(req.user!.role);

    if (!req.file) {
      res.status(400).json({ success: false, message: "No file uploaded" });
      return;
    }

    // validate type before touching DB
    if (!ALLOWED_MIME_TYPES.has(req.file.mimetype)) {
      try { fs.unlinkSync(path.join(process.cwd(), getRelativePath("note-attachments", req.file.filename))); } catch { /* ignore */ }
      res.status(400).json({ success: false, message: "File type not allowed. Supported: PDF, DOCX, XLSX, images, videos, ZIP" });
      return;
    }

    const [note] = await q<RowDataPacket>(
      `SELECT id, created_by AS createdBy FROM notes WHERE uuid = ? AND status != 'deleted'`, [uuid]
    );
    if (!note) {
      res.status(404).json({ success: false, message: "Note not found" });
      return;
    }
    if (!isAdmin && Number(note["createdBy"]) !== userId) {
      res.status(403).json({ success: false, message: "Only the note creator or an admin can add attachments" });
      return;
    }

    const filePath = getRelativePath("note-attachments", req.file.filename);
    const absPath  = path.join(process.cwd(), filePath);
    const fileSize = fs.statSync(absPath).size;

    const result = await run(
      `INSERT INTO note_attachments (note_id, file_name, file_path, file_size, file_type, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [note["id"], req.file.originalname, filePath, fileSize, req.file.mimetype, userId]
    );

    const [att] = await q<RowDataPacket>(
      `SELECT id, uuid, note_id AS noteId, file_name AS fileName, file_path AS filePath,
              file_size AS fileSize, file_type AS fileType, uploaded_by AS uploadedBy, created_at AS createdAt
       FROM note_attachments WHERE id = ?`,
      [result.insertId]
    );

    res.status(201).json({ success: true, message: "Attachment uploaded", data: att });
  } catch (err) {
    console.error("[notes/upload-attachment]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── deleteAttachment ─────────────────────────────────────────────────────────

export async function deleteAttachment(req: Request, res: Response): Promise<void> {
  try {
    const { uuid, attUuid } = req.params as Record<string, string>;
    const userId  = req.user!.id;
    const isAdmin = ADMIN_ROLES.includes(req.user!.role);

    const [note] = await q<RowDataPacket>(
      `SELECT id, created_by AS createdBy FROM notes WHERE uuid = ? AND status != 'deleted'`, [uuid]
    );
    if (!note) {
      res.status(404).json({ success: false, message: "Note not found" });
      return;
    }

    const [att] = await q<RowDataPacket>(
      `SELECT id, file_path AS filePath, file_name AS fileName, uploaded_by AS uploadedBy
       FROM note_attachments WHERE uuid = ? AND note_id = ?`,
      [attUuid, note["id"]]
    );
    if (!att) {
      res.status(404).json({ success: false, message: "Attachment not found" });
      return;
    }

    // uploader, note creator, or admin can delete
    if (!isAdmin && Number(att["uploadedBy"]) !== userId && Number(note["createdBy"]) !== userId) {
      res.status(403).json({ success: false, message: "Not authorised to delete this attachment" });
      return;
    }

    try {
      const abs = path.join(process.cwd(), att["filePath"]);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch { /* non-fatal */ }

    await run(`DELETE FROM note_attachments WHERE id = ?`, [att["id"]]);
    res.json({ success: true, message: "Attachment deleted", data: null });
  } catch (err) {
    console.error("[notes/delete-attachment]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── downloadAttachment ───────────────────────────────────────────────────────

export async function downloadAttachment(req: Request, res: Response): Promise<void> {
  try {
    const { uuid, attUuid } = req.params as Record<string, string>;
    const userId  = req.user!.id;
    const isAdmin = ADMIN_ROLES.includes(req.user!.role);

    const [note] = await q<RowDataPacket>(
      `SELECT id, created_by AS createdBy, assigned_to AS assignedTo
       FROM notes WHERE uuid = ? AND status != 'deleted'`, [uuid]
    );
    if (!note) {
      res.status(404).json({ success: false, message: "Note not found" });
      return;
    }
    if (!isAdmin && Number(note["createdBy"]) !== userId && Number(note["assignedTo"]) !== userId) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    const [att] = await q<RowDataPacket>(
      `SELECT file_path AS filePath, file_name AS fileName FROM note_attachments WHERE uuid = ? AND note_id = ?`,
      [attUuid, note["id"]]
    );
    if (!att) {
      res.status(404).json({ success: false, message: "Attachment not found" });
      return;
    }

    const absPath = path.join(process.cwd(), att["filePath"]);
    if (!fs.existsSync(absPath)) {
      res.status(404).json({ success: false, message: "File not found on disk" });
      return;
    }

    res.setHeader("Content-Disposition", `attachment; filename="${att["fileName"]}"`);
    res.sendFile(absPath);
  } catch (err) {
    console.error("[notes/download-attachment]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── previewAttachment ────────────────────────────────────────────────────────

const INLINE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif"]);

export async function previewAttachment(req: Request, res: Response): Promise<void> {
  try {
    const { uuid, attUuid } = req.params as Record<string, string>;
    const userId  = req.user!.id;
    const isAdmin = ADMIN_ROLES.includes(req.user!.role);

    const [note] = await q<RowDataPacket>(
      `SELECT id, created_by AS createdBy, assigned_to AS assignedTo
       FROM notes WHERE uuid = ? AND status != 'deleted'`, [uuid]
    );
    if (!note) {
      res.status(404).json({ success: false, message: "Note not found" });
      return;
    }
    if (!isAdmin && Number(note["createdBy"]) !== userId && Number(note["assignedTo"]) !== userId) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    const [att] = await q<RowDataPacket>(
      `SELECT file_path AS filePath, file_name AS fileName, file_type AS fileType
       FROM note_attachments WHERE uuid = ? AND note_id = ?`,
      [attUuid, note["id"]]
    );
    if (!att) {
      res.status(404).json({ success: false, message: "Attachment not found" });
      return;
    }

    if (!INLINE_MIME_TYPES.has(att["fileType"])) {
      res.redirect(`/api/notes/${uuid}/attachments/${attUuid}/download`);
      return;
    }

    const absPath = path.join(process.cwd(), att["filePath"]);
    if (!fs.existsSync(absPath)) {
      res.status(404).json({ success: false, message: "File not found on disk" });
      return;
    }

    res.setHeader("Content-Type", att["fileType"]);
    res.sendFile(absPath);
  } catch (err) {
    console.error("[notes/preview-attachment]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── getNoteStats ─────────────────────────────────────────────────────────────

export async function getNoteStats(req: Request, res: Response): Promise<void> {
  try {
    const userId  = req.user!.id;
    const isAdmin = ADMIN_ROLES.includes(req.user!.role);

    const accessFilter = isAdmin
      ? "n.status != 'deleted'"
      : "n.status != 'deleted' AND (n.created_by = ? OR n.assigned_to = ?)";
    const accessParams: unknown[] = isAdmin ? [] : [userId, userId];

    const [totals, byCategory, byPriority, recentlyUpdated] = await Promise.all([
      q<RowDataPacket>(`
        SELECT
          COUNT(*) AS total,
          SUM(n.is_starred = 1) AS starred,
          SUM(n.status = 'archived') AS archived
        FROM notes n WHERE ${accessFilter}`, accessParams),

      q<RowDataPacket>(`
        SELECT n.category, COUNT(*) AS count
        FROM notes n
        WHERE ${accessFilter}
        GROUP BY n.category`, accessParams),

      q<RowDataPacket>(`
        SELECT n.priority, COUNT(*) AS count
        FROM notes n
        WHERE ${accessFilter}
        GROUP BY n.priority`, accessParams),

      q<RowDataPacket>(`
        SELECT n.id, n.uuid, n.title, n.updated_at AS updatedAt, n.category, n.priority
        FROM notes n
        WHERE ${accessFilter}
        ORDER BY n.updated_at DESC
        LIMIT 5`, accessParams),
    ]);

    const t = totals[0] ?? {};
    res.json({
      success: true, message: "OK",
      data: {
        total:     Number(t["total"] ?? 0),
        starred:   Number(t["starred"] ?? 0),
        archived:  Number(t["archived"] ?? 0),
        byCategory:   Object.fromEntries(byCategory.map(r => [r["category"], Number(r["count"])])),
        byPriority:   Object.fromEntries(byPriority.map(r => [r["priority"],  Number(r["count"])])),
        recentlyUpdated: recentlyUpdated,
      },
    });
  } catch (err) {
    console.error("[notes/stats]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── addMentions ──────────────────────────────────────────────────────────────

export async function addMentions(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId  = req.user!.id;
    const isAdmin = ADMIN_ROLES.includes(req.user!.role);
    const { userIds } = req.body as Record<string, unknown>;

    if (!Array.isArray(userIds) || userIds.length === 0) {
      res.status(400).json({ success: false, message: "userIds array is required" });
      return;
    }

    const [note] = await q<RowDataPacket>(
      `SELECT n.id, n.title, n.created_by AS createdBy, u.name AS creatorName
       FROM notes n JOIN users u ON u.id = n.created_by
       WHERE n.uuid = ? AND n.status != 'deleted'`, [uuid]
    );
    if (!note) {
      res.status(404).json({ success: false, message: "Note not found" });
      return;
    }
    if (!isAdmin && Number(note["createdBy"]) !== userId) {
      res.status(403).json({ success: false, message: "Only the note creator or an admin can add mentions" });
      return;
    }

    let mentioned = 0;
    for (const uid of userIds) {
      const numUid = Number(uid);
      if (!numUid) continue;
      await run(
        `INSERT IGNORE INTO note_mentions (note_id, mentioned_user_id) VALUES (?, ?)`,
        [note["id"], numUid]
      );
      // notify the mentioned user
      run(
        `INSERT INTO notifications (user_id, type, title, body, link)
         VALUES (?, 'GENERAL', 'You were mentioned in a note', ?, ?)`,
        [
          numUid,
          `${note["creatorName"]} mentioned you in "${note["title"]}"`,
          `/notes/${uuid}`,
        ]
      ).catch(() => {});
      mentioned++;
    }

    res.json({ success: true, message: "Mentions added", data: { mentioned } });
  } catch (err) {
    console.error("[notes/add-mentions]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── removeMention ────────────────────────────────────────────────────────────

export async function removeMention(req: Request, res: Response): Promise<void> {
  try {
    const { uuid, userId: targetId } = req.params as Record<string, string>;
    const userId  = req.user!.id;
    const isAdmin = ADMIN_ROLES.includes(req.user!.role);

    const [note] = await q<RowDataPacket>(
      `SELECT id, created_by AS createdBy FROM notes WHERE uuid = ? AND status != 'deleted'`, [uuid]
    );
    if (!note) {
      res.status(404).json({ success: false, message: "Note not found" });
      return;
    }
    if (!isAdmin && Number(note["createdBy"]) !== userId) {
      res.status(403).json({ success: false, message: "Only the note creator or an admin can remove mentions" });
      return;
    }

    await run(
      `DELETE FROM note_mentions WHERE note_id = ? AND mentioned_user_id = ?`,
      [note["id"], Number(targetId)]
    );
    res.json({ success: true, message: "Mention removed", data: null });
  } catch (err) {
    console.error("[notes/remove-mention]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── listMentions ─────────────────────────────────────────────────────────────

export async function listMentions(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;

    const [note] = await q<RowDataPacket>(
      `SELECT id FROM notes WHERE uuid = ? AND status != 'deleted'`, [uuid]
    );
    if (!note) {
      res.status(404).json({ success: false, message: "Note not found" });
      return;
    }

    const rows = await q<RowDataPacket>(
      `SELECT u.id, u.name, u.email, u.avatar_url AS avatarUrl
       FROM note_mentions nm
       JOIN users u ON u.id = nm.mentioned_user_id
       WHERE nm.note_id = ?
       ORDER BY nm.created_at ASC`,
      [note["id"]]
    );
    res.json({ success: true, message: "OK", data: rows });
  } catch (err) {
    console.error("[notes/list-mentions]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Bulk Operations ──────────────────────────────────────────────────────────

export async function bulkStar(req: Request, res: Response): Promise<void> {
  try {
    const userId  = req.user!.id;
    const isAdmin = ADMIN_ROLES.includes(req.user!.role);
    const { uuids, starred } = req.body as Record<string, unknown>;

    if (!Array.isArray(uuids) || uuids.length === 0) {
      res.status(400).json({ success: false, message: "uuids array is required" });
      return;
    }

    const ph = uuids.map(() => "?").join(",");
    const starVal = starred ? 1 : 0;
    const params: unknown[] = [starVal, ...uuids.map(String), ...(isAdmin ? [] : [userId])];
    const result = await run(
      `UPDATE notes SET is_starred = ? WHERE uuid IN (${ph}) AND status != 'deleted'${isAdmin ? "" : " AND created_by = ?"}`,
      params
    );

    res.json({ success: true, message: "Updated", data: { updated: result.affectedRows } });
  } catch (err) {
    console.error("[notes/bulk-star]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function bulkArchive(req: Request, res: Response): Promise<void> {
  try {
    const userId  = req.user!.id;
    const isAdmin = ADMIN_ROLES.includes(req.user!.role);
    const { uuids } = req.body as Record<string, unknown>;

    if (!Array.isArray(uuids) || uuids.length === 0) {
      res.status(400).json({ success: false, message: "uuids array is required" });
      return;
    }

    const ph = uuids.map(() => "?").join(",");
    const params: unknown[] = [...uuids.map(String), ...(isAdmin ? [] : [userId])];
    const result = await run(
      `UPDATE notes SET status = 'archived' WHERE uuid IN (${ph}) AND status = 'active'${isAdmin ? "" : " AND created_by = ?"}`,
      params
    );

    res.json({ success: true, message: "Archived", data: { updated: result.affectedRows } });
  } catch (err) {
    console.error("[notes/bulk-archive]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function bulkDelete(req: Request, res: Response): Promise<void> {
  try {
    const userId  = req.user!.id;
    const isAdmin = ADMIN_ROLES.includes(req.user!.role);
    const { uuids } = req.body as Record<string, unknown>;

    if (!Array.isArray(uuids) || uuids.length === 0) {
      res.status(400).json({ success: false, message: "uuids array is required" });
      return;
    }

    const ph = uuids.map(() => "?").join(",");
    const params: unknown[] = [...uuids.map(String), ...(isAdmin ? [] : [userId])];
    const result = await run(
      `UPDATE notes SET status = 'deleted', deleted_at = NOW() WHERE uuid IN (${ph}) AND status != 'deleted'${isAdmin ? "" : " AND created_by = ?"}`,
      params
    );

    res.json({ success: true, message: "Deleted", data: { updated: result.affectedRows } });
  } catch (err) {
    console.error("[notes/bulk-delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function bulkTag(req: Request, res: Response): Promise<void> {
  try {
    const userId  = req.user!.id;
    const isAdmin = ADMIN_ROLES.includes(req.user!.role);
    const { uuids, tagId } = req.body as Record<string, unknown>;

    if (!Array.isArray(uuids) || uuids.length === 0 || !tagId) {
      res.status(400).json({ success: false, message: "uuids array and tagId are required" });
      return;
    }

    // resolve tag UUID → integer id
    const [tag] = await q<RowDataPacket>(`SELECT id FROM note_tags WHERE uuid = ?`, [String(tagId)]);
    if (!tag) {
      res.status(404).json({ success: false, message: "Tag not found" });
      return;
    }

    const ph = uuids.map(() => "?").join(",");
    const accessFilter = isAdmin ? "" : " AND n.created_by = ?";
    const accessParam  = isAdmin ? [] : [userId];

    const notes = await q<RowDataPacket>(
      `SELECT id FROM notes n WHERE uuid IN (${ph}) AND status != 'deleted'${accessFilter}`,
      [...uuids.map(String), ...accessParam]
    );

    let updated = 0;
    for (const note of notes) {
      await run(
        `INSERT IGNORE INTO note_tag_map (note_id, tag_id) VALUES (?, ?)`,
        [note["id"], tag["id"]]
      );
      updated++;
    }

    res.json({ success: true, message: "Tag applied", data: { updated } });
  } catch (err) {
    console.error("[notes/bulk-tag]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
