// src/controllers/client-meta.controller.ts
import { Request, Response } from "express";
import { q, run, RowDataPacket } from "../lib/db";
import { logActivity } from "../lib/logger";

const ALLOWED_TYPES = ["tag", "contract_type", "service"] as const;
type MetaType = (typeof ALLOWED_TYPES)[number];

const META_SEL = "id, uuid, type, label, color, sort_order AS sortOrder, created_at AS createdAt";

// GET /api/clients/meta
export async function listClientMeta(_req: Request, res: Response): Promise<void> {
  try {
    const rows = await q<RowDataPacket>(
      `SELECT ${META_SEL} FROM client_meta_options ORDER BY type, sort_order, label`
    );
    const tags          = rows.filter(r => r["type"] === "tag");
    const contractTypes = rows.filter(r => r["type"] === "contract_type");
    const services      = rows.filter(r => r["type"] === "service");
    res.json({ success: true, data: { tags, contractTypes, services }, message: "OK" });
  } catch (err) {
    console.error("[client-meta/list]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// POST /api/clients/meta
export async function createClientMeta(req: Request, res: Response): Promise<void> {
  try {
    const { type, label, color } = req.body as Record<string, string>;

    if (!ALLOWED_TYPES.includes(type as MetaType)) {
      res.status(400).json({ success: false, message: "type must be 'tag', 'contract_type', or 'service'" });
      return;
    }
    if (!label?.trim()) {
      res.status(400).json({ success: false, message: "label is required" });
      return;
    }

    const maxRow = await q<RowDataPacket>(
      "SELECT COALESCE(MAX(sort_order), 0) AS maxOrder FROM client_meta_options WHERE type = ?",
      [type]
    );
    const sortOrder = Number(maxRow[0]?.["maxOrder"] ?? 0) + 1;

    const result = await run(
      "INSERT INTO client_meta_options (type, label, color, sort_order, created_by) VALUES (?, ?, ?, ?, ?)",
      [type, label.trim(), color ?? "#6366F1", sortOrder, req.user!.id]
    );

    const rows = await q<RowDataPacket>(
      `SELECT ${META_SEL} FROM client_meta_options WHERE id = ?`,
      [result.insertId]
    );
    await logActivity(req.user!.id, "client_meta.created", "client_meta", result.insertId, undefined, rows[0], req.ip);
    res.status(201).json({ success: true, data: rows[0], message: "Meta option created" });
  } catch (err) {
    console.error("[client-meta/create]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// PATCH /api/clients/meta/:uuid
export async function updateClientMeta(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params;
    const existing = await q<RowDataPacket>(
      `SELECT ${META_SEL} FROM client_meta_options WHERE uuid = ?`, [uuid]
    );
    if (!existing.length) {
      res.status(404).json({ success: false, message: "Meta option not found" });
      return;
    }
    const metaId = Number(existing[0]["id"]);

    const { label, color, sortOrder } = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const params: unknown[] = [];

    if (label     !== undefined) { sets.push("label = ?");      params.push(String(label).trim()); }
    if (color     !== undefined) { sets.push("color = ?");      params.push(color); }
    if (sortOrder !== undefined) { sets.push("sort_order = ?"); params.push(Number(sortOrder)); }

    if (!sets.length) {
      res.status(400).json({ success: false, message: "Nothing to update" });
      return;
    }

    params.push(metaId);
    await run(`UPDATE client_meta_options SET ${sets.join(", ")} WHERE id = ?`, params);

    const rows = await q<RowDataPacket>(
      `SELECT ${META_SEL} FROM client_meta_options WHERE id = ?`, [metaId]
    );
    await logActivity(req.user!.id, "client_meta.updated", "client_meta", metaId, existing[0], rows[0], req.ip);
    res.json({ success: true, data: rows[0], message: "Meta option updated" });
  } catch (err) {
    console.error("[client-meta/update]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// DELETE /api/clients/meta/:uuid
export async function deleteClientMeta(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params;
    const existing = await q<RowDataPacket>(
      "SELECT id, type, label FROM client_meta_options WHERE uuid = ?", [uuid]
    );
    if (!existing.length) {
      res.status(404).json({ success: false, message: "Meta option not found" });
      return;
    }
    const metaId = Number(existing[0]["id"]);

    await run("DELETE FROM client_meta_options WHERE id = ?", [metaId]);
    await logActivity(req.user!.id, "client_meta.deleted", "client_meta", metaId, existing[0], undefined, req.ip);
    res.json({ success: true, data: null, message: "Meta option deleted" });
  } catch (err) {
    console.error("[client-meta/delete]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}
