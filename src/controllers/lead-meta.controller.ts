// src/controllers/lead-meta.controller.ts
import { Request, Response } from "express";
import { q, run, RowDataPacket } from "../lib/db";
import { logActivity } from "../lib/logger";
import type { LeadMetaOption } from "../types/lead.types";
import { RESERVED_STATUS_LABELS, RESERVED_PRIORITY_LABELS, isDupEntry } from "../lib/lead-rules";

const ALLOWED_TYPES = ["source", "status", "priority", "service"] as const;
type MetaType = (typeof ALLOWED_TYPES)[number];

const META_SEL = "id, uuid, type, label, color, sort_order, created_at";

function rowToMeta(r: RowDataPacket): LeadMetaOption {
  return {
    id:        Number(r["id"]),
    uuid:      String(r["uuid"]),
    type:      r["type"] as MetaType,
    label:     String(r["label"]),
    color:     String(r["color"]),
    sortOrder: Number(r["sort_order"] ?? 0),
    createdAt: String(r["created_at"]),
  };
}

// GET /api/leads/meta
export async function listLeadMeta(_req: Request, res: Response): Promise<void> {
  try {
    const rows = await q<RowDataPacket>(
      `SELECT ${META_SEL} FROM lead_meta_options ORDER BY type, sort_order, label`,
    );
    const sources    = rows.filter(r => r["type"] === "source").map(rowToMeta);
    const statuses   = rows.filter(r => r["type"] === "status").map(rowToMeta);
    const priorities = rows.filter(r => r["type"] === "priority").map(rowToMeta);
    const services   = rows.filter(r => r["type"] === "service").map(rowToMeta);
    res.json({ success: true, data: { sources, statuses, priorities, services }, message: "OK" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// POST /api/leads/meta
export async function createLeadMeta(req: Request, res: Response): Promise<void> {
  try {
    const { type, label, color } = req.body as Record<string, string>;

    if (!ALLOWED_TYPES.includes(type as MetaType)) {
      res.status(400).json({ success: false, message: "type must be source, status, priority, or service" });
      return;
    }
    if (!label?.trim()) {
      res.status(400).json({ success: false, message: "label is required" });
      return;
    }

    const maxRow = await q<RowDataPacket>(
      "SELECT COALESCE(MAX(sort_order), 0) AS maxOrder FROM lead_meta_options WHERE type = ?", [type],
    );
    const sortOrder = Number(maxRow[0]?.["maxOrder"] ?? 0) + 1;

    let result;
    try {
      result = await run(
        "INSERT INTO lead_meta_options (type, label, color, sort_order) VALUES (?, ?, ?, ?)",
        [type, label.trim(), color ?? "#6366F1", sortOrder],
      );
    } catch (dbErr) {
      if (isDupEntry(dbErr)) {
        res.status(400).json({ success: false, message: `A "${type}" option with label "${label.trim()}" already exists` });
        return;
      }
      throw dbErr;
    }

    const rows = await q<RowDataPacket>(`SELECT ${META_SEL} FROM lead_meta_options WHERE id = ?`, [result.insertId]);
    const meta = rowToMeta(rows[0]);

    await logActivity(req.user!.id, "lead_meta.created", "lead_meta", result.insertId, undefined, meta, req.ip);
    res.status(201).json({ success: true, data: meta, message: "Meta option created" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// PATCH /api/leads/meta/:uuid
export async function updateLeadMeta(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params;
    const existing = await q<RowDataPacket>(
      `SELECT ${META_SEL} FROM lead_meta_options WHERE uuid = ?`, [uuid],
    );
    if (!existing.length) {
      res.status(404).json({ success: false, message: "Meta option not found" });
      return;
    }
    const metaId   = Number(existing[0]["id"]);
    const metaType = String(existing[0]["type"]) as MetaType;
    const before   = rowToMeta(existing[0]);

    // Block renaming system-reserved labels
    const { label, color, sortOrder } = req.body as Record<string, unknown>;
    if (label !== undefined) {
      const currentLabel = String(existing[0]["label"]);
      const isReserved =
        (metaType === "status"   && RESERVED_STATUS_LABELS.has(currentLabel)) ||
        (metaType === "priority" && RESERVED_PRIORITY_LABELS.has(currentLabel));

      if (isReserved && String(label).trim() !== currentLabel) {
        res.status(400).json({
          success: false,
          message: `"${currentLabel}" is a system-reserved ${metaType} and cannot be renamed`,
        });
        return;
      }
    }

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
    try {
      await run(`UPDATE lead_meta_options SET ${sets.join(", ")} WHERE id = ?`, params);
    } catch (dbErr) {
      if (isDupEntry(dbErr)) {
        res.status(400).json({ success: false, message: `A "${metaType}" option with that label already exists` });
        return;
      }
      throw dbErr;
    }

    const rows = await q<RowDataPacket>(`SELECT ${META_SEL} FROM lead_meta_options WHERE id = ?`, [metaId]);
    const meta = rowToMeta(rows[0]);

    await logActivity(req.user!.id, "lead_meta.updated", "lead_meta", metaId, before, meta, req.ip);
    res.json({ success: true, data: meta, message: "Meta option updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// DELETE /api/leads/meta/:uuid
export async function deleteLeadMeta(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params;
    const existing = await q<RowDataPacket>(
      "SELECT id, type, label FROM lead_meta_options WHERE uuid = ?", [uuid],
    );
    if (!existing.length) {
      res.status(404).json({ success: false, message: "Meta option not found" });
      return;
    }
    const metaId    = Number(existing[0]["id"]);
    const metaType  = String(existing[0]["type"]) as MetaType;
    const metaLabel = String(existing[0]["label"]);

    // Block deletion of system-reserved labels
    if (metaType === "status" && RESERVED_STATUS_LABELS.has(metaLabel)) {
      res.status(400).json({
        success: false,
        message: `"${metaLabel}" is a system-reserved status and cannot be deleted`,
      });
      return;
    }
    if (metaType === "priority" && RESERVED_PRIORITY_LABELS.has(metaLabel)) {
      res.status(400).json({
        success: false,
        message: `"${metaLabel}" is a system-reserved priority and cannot be deleted`,
      });
      return;
    }

    // Check usage before deletion
    const colMap: Partial<Record<MetaType, string>> = {
      source:   "source_id",
      status:   "status_id",
      priority: "priority_id",
    };

    let usageCount = 0;

    if (colMap[metaType]) {
      const usageRow = await q<RowDataPacket>(
        `SELECT COUNT(*) AS cnt FROM leads WHERE ${colMap[metaType]} = ?`, [metaId],
      );
      usageCount += Number(usageRow[0]?.["cnt"] ?? 0);
    }

    if (metaType === "service") {
      const svcRow = await q<RowDataPacket>(
        "SELECT COUNT(*) AS cnt FROM lead_services WHERE service_id = ?", [metaId],
      );
      usageCount += Number(svcRow[0]?.["cnt"] ?? 0);
    }

    if (usageCount > 0) {
      res.status(400).json({
        success: false,
        message: `In use by ${usageCount} lead${usageCount !== 1 ? "s" : ""}`,
      });
      return;
    }

    await run("DELETE FROM lead_meta_options WHERE id = ?", [metaId]);
    await logActivity(req.user!.id, "lead_meta.deleted", "lead_meta", metaId, { label: metaLabel }, undefined, req.ip);
    res.json({ success: true, data: null, message: "Meta option deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}
