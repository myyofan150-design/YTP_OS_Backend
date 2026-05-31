// src/controllers/workspace.controller.ts
import { Request, Response } from "express";
import { q, run, RowDataPacket } from "../lib/db";

export async function listWorkspaces(_req: Request, res: Response) {
  try {
    const rows = await q<RowDataPacket>(
      `SELECT w.id, w.uuid, w.name, w.icon, w.color, w.created_by AS createdBy, w.created_at AS createdAt,
        (SELECT COUNT(*) FROM workspace_properties wp WHERE wp.workspace_id = w.id) AS propCount,
        (SELECT COUNT(*) FROM workspace_entries we WHERE we.workspace_id = w.id) AS entryCount
       FROM workspaces w ORDER BY w.created_at ASC`
    );
    const data = rows.map(r => ({ ...r, _count: { properties: Number(r["propCount"]), entries: Number(r["entryCount"]) } }));
    res.json({ success: true, data, message: "OK" });
  } catch (err) {
    console.error("[workspace/list]", err);
    res.status(500).json({ success: false, message: "Failed" });
  }
}

export async function createWorkspace(req: Request, res: Response) {
  try {
    const { name, icon, color } = req.body as { name: string; icon?: string; color?: string };
    if (!name?.trim()) return res.status(400).json({ success: false, message: "Name is required" });
    const result = await run(
      "INSERT INTO workspaces (name, icon, color, created_by) VALUES (?, ?, ?, ?)",
      [name.trim(), icon ?? null, color ?? null, req.user!.id]
    );
    const rows = await q<RowDataPacket>("SELECT id, uuid, name, icon, color, created_by AS createdBy, created_at AS createdAt FROM workspaces WHERE id = ?", [result.insertId]);
    res.status(201).json({ success: true, data: rows[0], message: "Workspace created" });
  } catch (err) {
    console.error("[workspace/create]", err);
    res.status(500).json({ success: false, message: "Failed" });
  }
}

export async function getWorkspace(req: Request, res: Response) {
  try {
    const uuid = String(req.params["uuid"]);
    const rows = await q<RowDataPacket>("SELECT id, uuid, name, icon, color, created_by AS createdBy, created_at AS createdAt FROM workspaces WHERE uuid = ?", [uuid]);
    if (!rows[0]) return res.status(404).json({ success: false, message: "Workspace not found" });
    const ws = rows[0];

    const [properties, entries] = await Promise.all([
      q<RowDataPacket>(
        "SELECT id, workspace_id AS workspaceId, name, type, options, is_required AS isRequired, sort_order AS sortOrder FROM workspace_properties WHERE workspace_id = ? ORDER BY sort_order ASC",
        [ws["id"]]
      ),
      q<RowDataPacket>(
        "SELECT id, uuid, workspace_id AS workspaceId, title, data, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt FROM workspace_entries WHERE workspace_id = ? ORDER BY created_at DESC",
        [ws["id"]]
      ),
    ]);

    res.json({ success: true, data: { ...ws, properties, entries }, message: "OK" });
  } catch (err) {
    console.error("[workspace/get]", err);
    res.status(500).json({ success: false, message: "Failed" });
  }
}

export async function addProperty(req: Request, res: Response) {
  try {
    const uuid = String(req.params["uuid"]);
    const rows = await q<RowDataPacket>("SELECT id FROM workspaces WHERE uuid = ?", [uuid]);
    if (!rows[0]) return res.status(404).json({ success: false, message: "Workspace not found" });

    const { name, type, options, isRequired = false, sortOrder = 0 } = req.body as {
      name: string; type: string; options?: string[]; isRequired?: boolean; sortOrder?: number;
    };
    if (!name?.trim() || !type) return res.status(400).json({ success: false, message: "name and type are required" });

    const validTypes = ["TEXT","NUMBER","DATE","SELECT","MULTI_SELECT","URL","EMAIL","CHECKBOX","FILE"];
    if (!validTypes.includes(type)) return res.status(400).json({ success: false, message: "Invalid property type" });

    const result = await run(
      "INSERT INTO workspace_properties (workspace_id, name, type, options, is_required, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
      [rows[0]["id"], name.trim(), type, options ? JSON.stringify(options) : null, isRequired ? 1 : 0, Number(sortOrder)]
    );
    const propRows = await q<RowDataPacket>(
      "SELECT id, workspace_id AS workspaceId, name, type, options, is_required AS isRequired, sort_order AS sortOrder FROM workspace_properties WHERE id = ?",
      [result.insertId]
    );
    res.status(201).json({ success: true, data: propRows[0], message: "Property added" });
  } catch (err) {
    console.error("[workspace/add-property]", err);
    res.status(500).json({ success: false, message: "Failed" });
  }
}

export async function deleteProperty(req: Request, res: Response) {
  try {
    const uuid   = String(req.params["uuid"]);
    const propId = Number(req.params["propId"]);
    const wsRows = await q<RowDataPacket>("SELECT id FROM workspaces WHERE uuid = ?", [uuid]);
    if (!wsRows[0]) return res.status(404).json({ success: false, message: "Workspace not found" });
    const propRows = await q<RowDataPacket>("SELECT id FROM workspace_properties WHERE id = ? AND workspace_id = ?", [propId, wsRows[0]["id"]]);
    if (!propRows[0]) return res.status(404).json({ success: false, message: "Property not found" });
    await run("DELETE FROM workspace_properties WHERE id = ?", [propId]);
    res.json({ success: true, data: null, message: "Property deleted" });
  } catch (err) {
    console.error("[workspace/delete-property]", err);
    res.status(500).json({ success: false, message: "Failed" });
  }
}

export async function createEntry(req: Request, res: Response) {
  try {
    const uuid = String(req.params["uuid"]);
    const wsRows = await q<RowDataPacket>("SELECT id FROM workspaces WHERE uuid = ?", [uuid]);
    if (!wsRows[0]) return res.status(404).json({ success: false, message: "Workspace not found" });

    const { title, data = {} } = req.body as { title: string; data?: Record<string, unknown> };
    if (!title?.trim()) return res.status(400).json({ success: false, message: "Title is required" });

    const props = await q<RowDataPacket>("SELECT id, name, is_required AS isRequired FROM workspace_properties WHERE workspace_id = ?", [wsRows[0]["id"]]);
    for (const prop of props) {
      if (prop["isRequired"] && !data[String(prop["id"])]) {
        return res.status(400).json({ success: false, message: `${prop["name"]} is required` });
      }
    }

    const result = await run(
      "INSERT INTO workspace_entries (workspace_id, title, data, created_by) VALUES (?, ?, ?, ?)",
      [wsRows[0]["id"], title.trim(), JSON.stringify(data), req.user!.id]
    );
    const entryRows = await q<RowDataPacket>(
      "SELECT id, uuid, workspace_id AS workspaceId, title, data, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt FROM workspace_entries WHERE id = ?",
      [result.insertId]
    );
    res.status(201).json({ success: true, data: entryRows[0], message: "Entry created" });
  } catch (err) {
    console.error("[workspace/create-entry]", err);
    res.status(500).json({ success: false, message: "Failed" });
  }
}

export async function updateEntry(req: Request, res: Response) {
  try {
    const uuid      = String(req.params["uuid"]);
    const entryUuid = String(req.params["entryUuid"]);
    const wsRows = await q<RowDataPacket>("SELECT id FROM workspaces WHERE uuid = ?", [uuid]);
    if (!wsRows[0]) return res.status(404).json({ success: false, message: "Workspace not found" });
    const entryRows = await q<RowDataPacket>("SELECT id FROM workspace_entries WHERE uuid = ? AND workspace_id = ?", [entryUuid, wsRows[0]["id"]]);
    if (!entryRows[0]) return res.status(404).json({ success: false, message: "Entry not found" });

    const { title, data } = req.body as { title?: string; data?: Record<string, unknown> };
    const sets: string[] = [];
    const p: unknown[] = [];
    if (title != null) { sets.push("title = ?"); p.push(title.trim()); }
    if (data  != null) { sets.push("data = ?");  p.push(JSON.stringify(data)); }
    if (sets.length > 0) {
      p.push(entryRows[0]["id"]);
      await run(`UPDATE workspace_entries SET ${sets.join(", ")} WHERE id = ?`, p as string[]);
    }

    const updated = await q<RowDataPacket>(
      "SELECT id, uuid, workspace_id AS workspaceId, title, data, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt FROM workspace_entries WHERE id = ?",
      [entryRows[0]["id"]]
    );
    res.json({ success: true, data: updated[0], message: "Entry updated" });
  } catch (err) {
    console.error("[workspace/update-entry]", err);
    res.status(500).json({ success: false, message: "Failed" });
  }
}

export async function deleteEntry(req: Request, res: Response) {
  try {
    const uuid      = String(req.params["uuid"]);
    const entryUuid = String(req.params["entryUuid"]);
    const wsRows = await q<RowDataPacket>("SELECT id FROM workspaces WHERE uuid = ?", [uuid]);
    if (!wsRows[0]) return res.status(404).json({ success: false, message: "Workspace not found" });
    const entryRows = await q<RowDataPacket>("SELECT id, created_by AS createdBy FROM workspace_entries WHERE uuid = ? AND workspace_id = ?", [entryUuid, wsRows[0]["id"]]);
    if (!entryRows[0]) return res.status(404).json({ success: false, message: "Entry not found" });

    const isAdmin = ["SUPER_ADMIN","ADMIN"].includes(req.user!.role);
    if (!isAdmin && Number(entryRows[0]["createdBy"]) !== req.user!.id) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    await run("DELETE FROM workspace_entries WHERE id = ?", [entryRows[0]["id"]]);
    res.json({ success: true, data: null, message: "Entry deleted" });
  } catch (err) {
    console.error("[workspace/delete-entry]", err);
    res.status(500).json({ success: false, message: "Failed" });
  }
}
