// src/controllers/subscription-meta.controller.ts
import { Request, Response } from "express";
import { q, run, RowDataPacket } from "../lib/db";
import { logActivity } from "../lib/logger";
import type { MetaOption } from "../types/subscription.types";

const ALLOWED_TYPES = ["category", "billing_cycle", "status"] as const;
type MetaType = (typeof ALLOWED_TYPES)[number];

function rowToMeta(r: RowDataPacket): MetaOption {
  return {
    id:        Number(r["id"]),
    uuid:      String(r["uuid"]),
    type:      r["type"] as MetaType,
    label:     String(r["label"]),
    color:     String(r["color"]),
    sortOrder: Number(r["sort_order"] ?? 0),
  };
}

const META_SEL = "id, uuid, type, label, color, sort_order";

// GET /api/subscriptions/meta
export async function listMeta(_req: Request, res: Response): Promise<void> {
  try {
    const rows = await q<RowDataPacket>(
      `SELECT ${META_SEL} FROM subscription_meta_options ORDER BY type, sort_order`
    );
    const categories    = rows.filter(r => r["type"] === "category").map(rowToMeta);
    const billingCycles = rows.filter(r => r["type"] === "billing_cycle").map(rowToMeta);
    const statuses      = rows.filter(r => r["type"] === "status").map(rowToMeta);
    res.json({ success: true, data: { categories, billingCycles, statuses }, message: "OK" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// POST /api/subscriptions/meta
export async function createMeta(req: Request, res: Response): Promise<void> {
  try {
    const { type, label, color } = req.body as Record<string, string>;

    if (!ALLOWED_TYPES.includes(type as MetaType)) {
      res.status(400).json({ success: false, message: "type must be category, billing_cycle, or status" });
      return;
    }
    if (!label?.trim()) {
      res.status(400).json({ success: false, message: "label is required" });
      return;
    }

    const maxRow = await q<RowDataPacket>(
      "SELECT COALESCE(MAX(sort_order), 0) AS maxOrder FROM subscription_meta_options WHERE type = ?",
      [type]
    );
    const sortOrder = Number(maxRow[0]?.["maxOrder"] ?? 0) + 1;

    const result = await run(
      "INSERT INTO subscription_meta_options (type, label, color, sort_order, created_by) VALUES (?, ?, ?, ?, ?)",
      [type, label.trim(), color ?? "#6366F1", sortOrder, req.user!.id]
    );

    const rows = await q<RowDataPacket>(
      `SELECT ${META_SEL} FROM subscription_meta_options WHERE id = ?`,
      [result.insertId]
    );
    const meta = rowToMeta(rows[0]);

    await logActivity(req.user!.id, "subscription_meta.created", "subscription_meta", result.insertId, undefined, meta, req.ip);

    res.status(201).json({ success: true, data: meta, message: "Meta option created" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// PATCH /api/subscriptions/meta/:uuid
export async function updateMeta(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params;
    const existing = await q<RowDataPacket>(
      `SELECT ${META_SEL} FROM subscription_meta_options WHERE uuid = ?`,
      [uuid]
    );
    if (!existing.length) {
      res.status(404).json({ success: false, message: "Meta option not found" });
      return;
    }
    const metaId = Number(existing[0]["id"]);
    const before = rowToMeta(existing[0]);

    const { label, color, sortOrder } = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const params: unknown[] = [];

    if (label !== undefined) { sets.push("label = ?"); params.push(String(label).trim()); }
    if (color !== undefined) { sets.push("color = ?"); params.push(color); }
    if (sortOrder !== undefined) { sets.push("sort_order = ?"); params.push(Number(sortOrder)); }

    if (!sets.length) {
      res.status(400).json({ success: false, message: "Nothing to update" });
      return;
    }

    params.push(metaId);
    await run(`UPDATE subscription_meta_options SET ${sets.join(", ")} WHERE id = ?`, params);

    const rows = await q<RowDataPacket>(
      `SELECT ${META_SEL} FROM subscription_meta_options WHERE id = ?`,
      [metaId]
    );
    const meta = rowToMeta(rows[0]);

    await logActivity(req.user!.id, "subscription_meta.updated", "subscription_meta", metaId, before, meta, req.ip);

    res.json({ success: true, data: meta, message: "Meta option updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// DELETE /api/subscriptions/meta/:uuid
export async function deleteMeta(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params;
    const existing = await q<RowDataPacket>(
      "SELECT id, type, label FROM subscription_meta_options WHERE uuid = ?",
      [uuid]
    );
    if (!existing.length) {
      res.status(404).json({ success: false, message: "Meta option not found" });
      return;
    }
    const metaId  = Number(existing[0]["id"]);
    const metaType = String(existing[0]["type"]) as MetaType;

    const col =
      metaType === "category"      ? "category_id" :
      metaType === "billing_cycle" ? "billing_cycle_id" :
                                     "status_id";

    const usageRow = await q<RowDataPacket>(
      `SELECT COUNT(*) AS cnt FROM subscriptions WHERE ${col} = ?`,
      [metaId]
    );
    const cnt = Number(usageRow[0]?.["cnt"] ?? 0);
    if (cnt > 0) {
      res.status(400).json({ success: false, message: `In use by ${cnt} subscription${cnt !== 1 ? "s" : ""}` });
      return;
    }

    await run("DELETE FROM subscription_meta_options WHERE id = ?", [metaId]);
    await logActivity(req.user!.id, "subscription_meta.deleted", "subscription_meta", metaId, { label: existing[0]["label"] }, undefined, req.ip);

    res.json({ success: true, data: null, message: "Meta option deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}
