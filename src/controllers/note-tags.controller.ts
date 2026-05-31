// src/controllers/note-tags.controller.ts
import { Request, Response } from "express";
import { q, run, RowDataPacket } from "../lib/db";
import { logActivity } from "../lib/logger";

const ADMIN_ROLES = ["SUPER_ADMIN", "ADMIN"];

const TAG_SEL = `
  t.id, t.uuid, t.name, t.color,
  t.created_by AS createdBy,
  t.created_at AS createdAt,
  COUNT(m.note_id) AS noteCount`;

// ─── listTags ─────────────────────────────────────────────────────────────────

export async function listTags(_req: Request, res: Response): Promise<void> {
  try {
    const tags = await q<RowDataPacket>(`
      SELECT ${TAG_SEL}
      FROM note_tags t
      LEFT JOIN note_tag_map m ON m.tag_id = t.id
      GROUP BY t.id
      ORDER BY t.name ASC`
    );
    res.json({ success: true, message: "OK", data: tags.map(t => ({
      ...t, noteCount: Number(t["noteCount"] ?? 0),
    })) });
  } catch (err) {
    console.error("[note-tags/list]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── createTag ────────────────────────────────────────────────────────────────

export async function createTag(req: Request, res: Response): Promise<void> {
  try {
    const { name, color } = req.body as Record<string, unknown>;
    const userId = req.user!.id;

    if (!name || !String(name).trim()) {
      res.status(400).json({ success: false, message: "name is required" });
      return;
    }

    const trimmed = String(name).trim();

    // case-insensitive uniqueness check
    const [dup] = await q<RowDataPacket>(
      `SELECT id FROM note_tags WHERE LOWER(name) = LOWER(?)`, [trimmed]
    );
    if (dup) {
      res.status(409).json({ success: false, message: "A tag with this name already exists" });
      return;
    }

    const result = await run(
      `INSERT INTO note_tags (name, color, created_by) VALUES (?, ?, ?)`,
      [trimmed, color ? String(color) : "#6366F1", userId]
    );

    const [tag] = await q<RowDataPacket>(`
      SELECT ${TAG_SEL}
      FROM note_tags t
      LEFT JOIN note_tag_map m ON m.tag_id = t.id
      WHERE t.id = ?
      GROUP BY t.id`, [result.insertId]
    );

    await logActivity(userId, "CREATE_NOTE_TAG", "note_tag", result.insertId, undefined, { name: trimmed }, req.ip);
    res.status(201).json({ success: true, message: "Tag created", data: { ...tag, noteCount: 0 } });
  } catch (err) {
    console.error("[note-tags/create]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── updateTag ────────────────────────────────────────────────────────────────

export async function updateTag(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const { name, color } = req.body as Record<string, unknown>;
    const userId  = req.user!.id;
    const isAdmin = ADMIN_ROLES.includes(req.user!.role);

    const [existing] = await q<RowDataPacket>(
      `SELECT id, created_by AS createdBy FROM note_tags WHERE uuid = ?`, [uuid]
    );
    if (!existing) {
      res.status(404).json({ success: false, message: "Tag not found" });
      return;
    }
    if (!isAdmin && Number(existing["createdBy"]) !== userId) {
      res.status(403).json({ success: false, message: "Only the creator or an admin can edit this tag" });
      return;
    }

    const sets: string[] = [];
    const params: unknown[] = [];

    if (name !== undefined) {
      const trimmed = String(name).trim();
      // uniqueness check (exclude self)
      const [dup] = await q<RowDataPacket>(
        `SELECT id FROM note_tags WHERE LOWER(name) = LOWER(?) AND id != ?`,
        [trimmed, existing["id"]]
      );
      if (dup) {
        res.status(409).json({ success: false, message: "A tag with this name already exists" });
        return;
      }
      sets.push("name = ?");
      params.push(trimmed);
    }
    if (color !== undefined) { sets.push("color = ?"); params.push(String(color)); }

    if (sets.length === 0) {
      res.status(400).json({ success: false, message: "Nothing to update" });
      return;
    }

    params.push(existing["id"]);
    await run(`UPDATE note_tags SET ${sets.join(", ")} WHERE id = ?`, params);

    const [updated] = await q<RowDataPacket>(`
      SELECT ${TAG_SEL}
      FROM note_tags t
      LEFT JOIN note_tag_map m ON m.tag_id = t.id
      WHERE t.id = ?
      GROUP BY t.id`, [existing["id"]]
    );

    await logActivity(userId, "UPDATE_NOTE_TAG", "note_tag", Number(existing["id"]), undefined, undefined, req.ip);
    res.json({ success: true, message: "Tag updated", data: { ...updated, noteCount: Number(updated?.["noteCount"] ?? 0) } });
  } catch (err) {
    console.error("[note-tags/update]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── deleteTag ────────────────────────────────────────────────────────────────

export async function deleteTag(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId  = req.user!.id;
    const isAdmin = ADMIN_ROLES.includes(req.user!.role);

    const [existing] = await q<RowDataPacket>(
      `SELECT id, created_by AS createdBy FROM note_tags WHERE uuid = ?`, [uuid]
    );
    if (!existing) {
      res.status(404).json({ success: false, message: "Tag not found" });
      return;
    }
    if (!isAdmin && Number(existing["createdBy"]) !== userId) {
      res.status(403).json({ success: false, message: "Only the creator or an admin can delete this tag" });
      return;
    }

    // FK CASCADE on note_tag_map handles cleanup automatically
    await run(`DELETE FROM note_tags WHERE id = ?`, [existing["id"]]);
    await logActivity(userId, "DELETE_NOTE_TAG", "note_tag", Number(existing["id"]), undefined, undefined, req.ip);
    res.json({ success: true, message: "Tag deleted", data: null });
  } catch (err) {
    console.error("[note-tags/delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
