// src/controllers/holidays.controller.ts
import { Request, Response } from "express";
import { q, run, RowDataPacket } from "../lib/db";
import { logActivity } from "../lib/logger";

export async function listHolidays(req: Request, res: Response): Promise<void> {
  try {
    const year = parseInt(String(req.query["year"] ?? new Date().getFullYear()), 10);
    const rows = await q<RowDataPacket>(
      "SELECT * FROM holidays WHERE YEAR(date) = ? ORDER BY date ASC",
      [year]
    );
    res.json({ success: true, message: "OK", data: rows });
  } catch (err) {
    console.error("[holidays/list]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function createHoliday(req: Request, res: Response): Promise<void> {
  try {
    const { name, date, type } = req.body as Record<string, string | undefined>;
    if (!name || !date) {
      res.status(400).json({ success: false, message: "name and date are required" });
      return;
    }
    const validTypes = ["NATIONAL", "OPTIONAL", "COMPANY"];
    const holidayType = validTypes.includes(String(type ?? "")) ? String(type) : "NATIONAL";

    try {
      const result = await run(
        "INSERT INTO holidays (name, date, type, created_by) VALUES (?, ?, ?, ?)",
        [name, date, holidayType, req.user!.id]
      );
      const rows = await q<RowDataPacket>("SELECT * FROM holidays WHERE id = ?", [result.insertId]);
      await logActivity(req.user!.id, "holiday.create", "Holiday", result.insertId, undefined, rows[0], req.ip);
      res.status(201).json({ success: true, message: "Holiday created", data: rows[0] });
    } catch (dupErr: unknown) {
      if ((dupErr as { code?: string })?.code === "ER_DUP_ENTRY") {
        res.status(409).json({ success: false, message: "A holiday already exists on this date" });
        return;
      }
      throw dupErr;
    }
  } catch (err) {
    console.error("[holidays/create]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function deleteHoliday(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"), 10);
    const existing = await q<RowDataPacket>("SELECT * FROM holidays WHERE id = ?", [id]);
    if (!existing[0]) {
      res.status(404).json({ success: false, message: "Holiday not found" });
      return;
    }
    await run("DELETE FROM holidays WHERE id = ?", [id]);
    await logActivity(req.user!.id, "holiday.delete", "Holiday", id, existing[0], undefined, req.ip);
    res.json({ success: true, message: "Holiday deleted" });
  } catch (err) {
    console.error("[holidays/delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function bulkMarkHolidayAttendance(req: Request, res: Response): Promise<void> {
  try {
    const { date } = req.body as { date?: string };
    if (!date) {
      res.status(400).json({ success: false, message: "date is required" });
      return;
    }

    const holiday = await q<RowDataPacket>("SELECT id FROM holidays WHERE date = ?", [date]);
    if (!holiday[0]) {
      res.status(404).json({ success: false, message: "No holiday found on this date" });
      return;
    }

    const employees = await q<RowDataPacket>(
      "SELECT id FROM employees WHERE status = 'ACTIVE'",
      []
    );

    let marked = 0;
    for (const emp of employees) {
      await run(
        `INSERT INTO attendance_logs (employee_id, date, type, late_minutes, source)
         VALUES (?, ?, 'HOLIDAY', 0, 'MANUAL')
         ON DUPLICATE KEY UPDATE type = 'HOLIDAY', is_manual = 1, source = 'MANUAL'`,
        [emp["id"], date]
      );
      marked++;
    }

    await logActivity(req.user!.id, "holiday.bulk_mark", "Holiday", undefined, undefined, { date, marked }, req.ip);
    res.json({ success: true, message: `Marked ${marked} employees as HOLIDAY for ${date}`, data: { marked } });
  } catch (err) {
    console.error("[holidays/bulk-mark]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
