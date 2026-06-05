// src/controllers/shifts.controller.ts
import { Request, Response } from "express";
import { q, run, RowDataPacket } from "../lib/db";
import { logActivity } from "../lib/logger";

export async function listShifts(req: Request, res: Response): Promise<void> {
  try {
    const rows = await q<RowDataPacket>(
      "SELECT * FROM shifts ORDER BY is_default DESC, name ASC",
      []
    );
    res.json({ success: true, message: "OK", data: rows });
  } catch (err) {
    console.error("[shifts/list]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function createShift(req: Request, res: Response): Promise<void> {
  try {
    const { name, startTime, endTime, graceMinutes, breakMinutes, isOvernight } =
      req.body as Record<string, string | number | boolean | undefined>;

    if (!name || !startTime || !endTime) {
      res.status(400).json({ success: false, message: "name, startTime, endTime are required" });
      return;
    }

    const result = await run(
      `INSERT INTO shifts (name, start_time, end_time, grace_minutes, break_minutes, is_overnight, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        String(name),
        String(startTime),
        String(endTime),
        Number(graceMinutes ?? 15),
        Number(breakMinutes ?? 60),
        isOvernight ? 1 : 0,
        req.user!.id,
      ]
    );
    const rows = await q<RowDataPacket>("SELECT * FROM shifts WHERE id = ?", [result.insertId]);
    await logActivity(req.user!.id, "shift.create", "Shift", result.insertId, undefined, rows[0], req.ip);
    res.status(201).json({ success: true, message: "Shift created", data: rows[0] });
  } catch (err) {
    console.error("[shifts/create]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function updateShift(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"), 10);
    const existing = await q<RowDataPacket>("SELECT * FROM shifts WHERE id = ?", [id]);
    if (!existing[0]) {
      res.status(404).json({ success: false, message: "Shift not found" });
      return;
    }

    const { name, startTime, endTime, graceMinutes, breakMinutes, isOvernight, isDefault } =
      req.body as Record<string, string | number | boolean | undefined>;

    const sets: string[] = [];
    const p: unknown[] = [];
    if (name         !== undefined) { sets.push("name = ?");           p.push(String(name)); }
    if (startTime    !== undefined) { sets.push("start_time = ?");     p.push(String(startTime)); }
    if (endTime      !== undefined) { sets.push("end_time = ?");       p.push(String(endTime)); }
    if (graceMinutes !== undefined) { sets.push("grace_minutes = ?");  p.push(Number(graceMinutes)); }
    if (breakMinutes !== undefined) { sets.push("break_minutes = ?");  p.push(Number(breakMinutes)); }
    if (isOvernight  !== undefined) { sets.push("is_overnight = ?");   p.push(isOvernight ? 1 : 0); }
    if (isDefault    !== undefined) {
      if (isDefault) await run("UPDATE shifts SET is_default = 0", []);
      sets.push("is_default = ?");
      p.push(isDefault ? 1 : 0);
    }
    if (!sets.length) {
      res.status(400).json({ success: false, message: "No fields to update" });
      return;
    }
    p.push(id);

    await run(`UPDATE shifts SET ${sets.join(", ")} WHERE id = ?`, p);
    const rows = await q<RowDataPacket>("SELECT * FROM shifts WHERE id = ?", [id]);
    await logActivity(req.user!.id, "shift.update", "Shift", id, existing[0], rows[0], req.ip);
    res.json({ success: true, message: "Shift updated", data: rows[0] });
  } catch (err) {
    console.error("[shifts/update]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function deleteShift(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"), 10);
    const existing = await q<RowDataPacket>("SELECT * FROM shifts WHERE id = ?", [id]);
    if (!existing[0]) {
      res.status(404).json({ success: false, message: "Shift not found" });
      return;
    }
    if (existing[0]["is_default"]) {
      res.status(400).json({ success: false, message: "Cannot delete the default shift" });
      return;
    }
    await run("DELETE FROM shifts WHERE id = ?", [id]);
    await logActivity(req.user!.id, "shift.delete", "Shift", id, existing[0], undefined, req.ip);
    res.json({ success: true, message: "Shift deleted" });
  } catch (err) {
    console.error("[shifts/delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
