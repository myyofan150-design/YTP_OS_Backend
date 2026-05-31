// src/controllers/todo-groups.controller.ts

import { Request, Response } from "express";
import { q, run, pool, RowDataPacket } from "../lib/db";
import { logActivity } from "../lib/logger";

// ─── listGroups ───────────────────────────────────────────────────────────────

export async function listGroups(req: Request, res: Response): Promise<void> {
  try {
    const userId  = req.user!.id;
    const isAdmin = ["SUPER_ADMIN", "ADMIN"].includes(req.user!.role);
    const showAll = isAdmin && req.query["all"] === "true";

    const sql = `
      SELECT
        g.id, g.uuid, g.name, g.color,
        g.sort_order AS sortOrder, g.created_by AS createdBy,
        g.created_at AS createdAt, g.updated_at AS updatedAt,
        (SELECT COUNT(*) FROM todo_lists l WHERE l.group_id = g.id) AS listCount
      FROM todo_groups g
      ${showAll ? "" : "WHERE g.created_by = ?"}
      ORDER BY g.sort_order ASC, g.created_at ASC
    `;
    const groups = await q<RowDataPacket>(sql, showAll ? [] : [userId]);
    res.json({ success: true, message: "OK", data: groups });
  } catch (err) {
    console.error("[todo-groups/list]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── createGroup ──────────────────────────────────────────────────────────────

export async function createGroup(req: Request, res: Response): Promise<void> {
  try {
    const { name, color } = req.body as Record<string, unknown>;
    if (!name) {
      res.status(400).json({ success: false, message: "name is required" }); return;
    }

    const userId = req.user!.id;
    const result = await run(
      "INSERT INTO todo_groups (name, color, created_by) VALUES (?, ?, ?)",
      [String(name), color ? String(color) : "#6366F1", userId]
    );

    const rows = await q<RowDataPacket>(
      `SELECT id, uuid, name, color, sort_order AS sortOrder,
              created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt,
              0 AS listCount
       FROM todo_groups WHERE id = ?`,
      [result.insertId]
    );

    await logActivity(userId, "todo.group_created", "todo_group", result.insertId, undefined, { name }, req.ip);
    res.status(201).json({ success: true, message: "Group created", data: rows[0] });
  } catch (err) {
    console.error("[todo-groups/create]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── updateGroup ──────────────────────────────────────────────────────────────

export async function updateGroup(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;

    const rows = await q<RowDataPacket>(
      "SELECT id FROM todo_groups WHERE uuid = ? AND created_by = ?",
      [uuid, userId]
    );
    if (!rows[0]) { res.status(404).json({ success: false, message: "Group not found" }); return; }

    const { name, color, sortOrder } = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const p: unknown[]   = [];
    if (name      != null) { sets.push("name = ?");       p.push(String(name)); }
    if (color     != null) { sets.push("color = ?");      p.push(String(color)); }
    if (sortOrder != null) { sets.push("sort_order = ?"); p.push(Number(sortOrder)); }

    if (sets.length > 0) {
      p.push(rows[0]["id"]);
      await run(`UPDATE todo_groups SET ${sets.join(", ")} WHERE id = ?`, p);
    }

    const updated = await q<RowDataPacket>(
      `SELECT id, uuid, name, color, sort_order AS sortOrder,
              created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt
       FROM todo_groups WHERE id = ?`,
      [rows[0]["id"]]
    );

    await logActivity(userId, "todo.group_updated", "todo_group", Number(rows[0]["id"]), undefined, { name, color }, req.ip);
    res.json({ success: true, message: "Group updated", data: updated[0] });
  } catch (err) {
    console.error("[todo-groups/update]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── deleteGroup ──────────────────────────────────────────────────────────────
// Lists in the group have group_id SET NULL (via FK ON DELETE SET NULL)

export async function deleteGroup(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;

    const rows = await q<RowDataPacket>(
      "SELECT id, name FROM todo_groups WHERE uuid = ? AND created_by = ?",
      [uuid, userId]
    );
    if (!rows[0]) { res.status(404).json({ success: false, message: "Group not found" }); return; }

    await run("DELETE FROM todo_groups WHERE id = ?", [rows[0]["id"]]);
    await logActivity(userId, "todo.group_deleted", "todo_group", Number(rows[0]["id"]), { name: rows[0]["name"] }, undefined, req.ip);
    res.json({ success: true, message: "Group deleted", data: null });
  } catch (err) {
    console.error("[todo-groups/delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── reorderGroups ────────────────────────────────────────────────────────────

export async function reorderGroups(req: Request, res: Response): Promise<void> {
  try {
    const { groups } = req.body as { groups: Array<{ uuid: string; sortOrder: number }> };
    if (!Array.isArray(groups) || groups.length === 0) {
      res.status(400).json({ success: false, message: "groups array is required" }); return;
    }

    const userId = req.user!.id;
    const conn   = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const item of groups) {
        await conn.execute(
          "UPDATE todo_groups SET sort_order = ? WHERE uuid = ? AND created_by = ?",
          [Number(item.sortOrder), item.uuid, userId]
        );
      }
      await conn.commit();
    } catch (txErr) {
      await conn.rollback();
      throw txErr;
    } finally {
      conn.release();
    }

    res.json({ success: true, message: "Groups reordered", data: null });
  } catch (err) {
    console.error("[todo-groups/reorder]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
