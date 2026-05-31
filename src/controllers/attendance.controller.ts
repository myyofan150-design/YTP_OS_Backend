// src/controllers/attendance.controller.ts
import { Request, Response } from "express";
import { q, run, RowDataPacket } from "../lib/db";
import { logActivity } from "../lib/logger";

function todayStr(): string {
  return new Date().toISOString().split("T")[0]!;
}

function monthRange(month: number, year: number): { gte: string; lte: string } {
  const gte = `${year}-${String(month).padStart(2, "0")}-01`;
  const last = new Date(year, month, 0).getDate();
  const lte = `${year}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  return { gte, lte };
}

function shiftToday(timeStr: string): Date {
  const [h, m] = timeStr.split(":").map(Number);
  const d = new Date();
  d.setHours(h!, m!, 0, 0);
  return d;
}

async function getEmployeeForUser(userId: number): Promise<RowDataPacket | null> {
  const rows = await q<RowDataPacket>(
    "SELECT id, shift_start AS shiftStart, shift_end AS shiftEnd FROM employees WHERE user_id = ?",
    [userId]
  );
  return rows[0] ?? null;
}

export async function clockIn(req: Request, res: Response): Promise<void> {
  try {
    const emp = await getEmployeeForUser(req.user!.id);
    if (!emp) { res.status(404).json({ success: false, message: "Employee profile not found" }); return; }

    const today = todayStr();
    const existing = await q<RowDataPacket>("SELECT id FROM attendance_logs WHERE employee_id = ? AND date = ?", [emp["id"], today]);
    if (existing[0]) { res.status(409).json({ success: false, message: "Already clocked in today" }); return; }

    const now = new Date();
    const expectedStart = shiftToday(String(emp["shiftStart"]));
    const lateMinutes = Math.max(0, Math.floor((now.getTime() - expectedStart.getTime()) / 60000));

    const result = await run(
      "INSERT INTO attendance_logs (employee_id, date, clock_in, type, late_minutes) VALUES (?, ?, ?, 'PRESENT', ?)",
      [emp["id"], today, now, lateMinutes]
    );
    const rows = await q<RowDataPacket>("SELECT * FROM attendance_logs WHERE id = ?", [result.insertId]);
    res.status(201).json({ success: true, message: "Clocked in", data: rows[0] });
  } catch (err) {
    console.error("[attendance/clock-in]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function clockOut(req: Request, res: Response): Promise<void> {
  try {
    const emp = await getEmployeeForUser(req.user!.id);
    if (!emp) { res.status(404).json({ success: false, message: "Employee profile not found" }); return; }

    const today = todayStr();
    const rows = await q<RowDataPacket>("SELECT * FROM attendance_logs WHERE employee_id = ? AND date = ?", [emp["id"], today]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "No clock-in found for today" }); return; }
    if (rows[0]["clock_out"]) { res.status(409).json({ success: false, message: "Already clocked out today" }); return; }

    const now = new Date();
    const clockInTime = new Date(rows[0]["clock_in"] as string).getTime();
    const workMinutes = Math.floor((now.getTime() - clockInTime) / 60000);

    const shiftStartMs  = shiftToday(String(emp["shiftStart"])).getTime();
    const shiftEndMs    = shiftToday(String(emp["shiftEnd"])).getTime();
    const shiftDuration = Math.floor((shiftEndMs - shiftStartMs) / 60000);
    const overtimeMinutes = Math.max(0, Math.floor((now.getTime() - shiftEndMs) / 60000));
    const type = workMinutes < shiftDuration / 2 ? "HALF_DAY" : String(rows[0]["type"]);

    await run(
      "UPDATE attendance_logs SET clock_out = ?, work_minutes = ?, overtime_minutes = ?, type = ? WHERE id = ?",
      [now, workMinutes, overtimeMinutes, type, rows[0]["id"]]
    );
    const updRows = await q<RowDataPacket>("SELECT * FROM attendance_logs WHERE id = ?", [rows[0]["id"]]);
    res.json({ success: true, message: "Clocked out", data: updRows[0] });
  } catch (err) {
    console.error("[attendance/clock-out]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function getToday(req: Request, res: Response): Promise<void> {
  try {
    const emp = await getEmployeeForUser(req.user!.id);
    if (!emp) { res.status(404).json({ success: false, message: "Employee profile not found" }); return; }
    const rows = await q<RowDataPacket>("SELECT * FROM attendance_logs WHERE employee_id = ? AND date = ?", [emp["id"], todayStr()]);
    res.json({ success: true, message: "OK", data: rows[0] ?? null });
  } catch (err) {
    console.error("[attendance/today]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function myHistory(req: Request, res: Response): Promise<void> {
  try {
    const emp = await getEmployeeForUser(req.user!.id);
    if (!emp) { res.status(404).json({ success: false, message: "Employee profile not found" }); return; }

    const now   = new Date();
    const month = parseInt(String(req.query["month"] ?? now.getMonth() + 1), 10);
    const year  = parseInt(String(req.query["year"]  ?? now.getFullYear()),  10);
    const { gte, lte } = monthRange(month, year);

    const logs = await q<RowDataPacket>(
      "SELECT * FROM attendance_logs WHERE employee_id = ? AND date >= ? AND date <= ? ORDER BY date ASC",
      [emp["id"], gte, lte]
    );
    res.json({ success: true, message: "OK", data: logs });
  } catch (err) {
    console.error("[attendance/my-history]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function teamAttendance(req: Request, res: Response): Promise<void> {
  try {
    const now   = new Date();
    const month = parseInt(String(req.query["month"]      ?? now.getMonth() + 1), 10);
    const year  = parseInt(String(req.query["year"]       ?? now.getFullYear()),  10);
    const empId = req.query["employeeId"] ? parseInt(String(req.query["employeeId"]), 10) : undefined;
    const { gte, lte } = monthRange(month, year);

    let sql = `SELECT a.*,
      e.id AS eId, e.employee_code AS empCode,
      u.id AS uId, u.name AS uName, u.avatar_url AS uAvatar
      FROM attendance_logs a
      JOIN employees e ON a.employee_id = e.id
      JOIN users u ON e.user_id = u.id
      WHERE a.date >= ? AND a.date <= ?`;
    const p: unknown[] = [gte, lte];
    if (empId) { sql += " AND a.employee_id = ?"; p.push(empId); }
    sql += " ORDER BY a.date ASC, a.employee_id ASC";

    const rows = await q<RowDataPacket>(sql, p as string[]);
    const data = rows.map(r => ({
      ...r,
      employee: { id: r["eId"], employeeCode: r["empCode"], user: { id: r["uId"], name: r["uName"], avatarUrl: r["uAvatar"] } },
    }));
    res.json({ success: true, message: "OK", data });
  } catch (err) {
    console.error("[attendance/team]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function overrideAttendance(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"), 10);
    const rows = await q<RowDataPacket>("SELECT * FROM attendance_logs WHERE id = ?", [id]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Attendance record not found" }); return; }

    const { type, clockIn, clockOut, notes } = req.body as Record<string, string | undefined>;
    const sets: string[] = ["is_manual = 1"];
    const p: unknown[] = [];
    if (type)     { sets.push("type = ?");      p.push(type); }
    if (clockIn)  { sets.push("clock_in = ?");  p.push(new Date(clockIn)); }
    if (clockOut) { sets.push("clock_out = ?"); p.push(new Date(clockOut)); }
    if (notes)    { sets.push("notes = ?");     p.push(notes); }
    p.push(id);

    await run(`UPDATE attendance_logs SET ${sets.join(", ")} WHERE id = ?`, p as string[]);
    const updRows = await q<RowDataPacket>("SELECT * FROM attendance_logs WHERE id = ?", [id]);
    await logActivity(req.user!.id, "attendance.manual_override", "AttendanceLog", id, rows[0], updRows[0], req.ip);
    res.json({ success: true, message: "Attendance overridden", data: updRows[0] });
  } catch (err) {
    console.error("[attendance/override]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function attendanceSummary(req: Request, res: Response): Promise<void> {
  try {
    const now   = new Date();
    const month = parseInt(String(req.query["month"]      ?? now.getMonth() + 1), 10);
    const year  = parseInt(String(req.query["year"]       ?? now.getFullYear()),  10);
    const empId = req.query["employeeId"] ? parseInt(String(req.query["employeeId"]), 10) : undefined;
    const { gte, lte } = monthRange(month, year);

    let sql = "SELECT type, late_minutes AS lateMinutes, overtime_minutes AS overtimeMinutes, work_minutes AS workMinutes FROM attendance_logs WHERE date >= ? AND date <= ?";
    const p: unknown[] = [gte, lte];
    if (empId) { sql += " AND employee_id = ?"; p.push(empId); }

    const logs = await q<RowDataPacket>(sql, p as string[]);

    const daysInMonth = new Date(year, month, 0).getDate();
    let workingDays = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      if (new Date(year, month - 1, d).getDay() !== 0) workingDays++;
    }

    const presentDays = logs.filter(l => l["type"] === "PRESENT").length;
    const halfDays    = logs.filter(l => l["type"] === "HALF_DAY").length;
    const leaveDays   = logs.filter(l => l["type"] === "LEAVE").length;
    const absentDays  = Math.max(0, workingDays - presentDays - halfDays - leaveDays);
    const totalLate   = logs.reduce((s, l) => s + Number(l["lateMinutes"]), 0);
    const totalOt     = logs.reduce((s, l) => s + Number(l["overtimeMinutes"]), 0);
    const totalWork   = logs.reduce((s, l) => s + Number(l["workMinutes"] ?? 0), 0);

    res.json({
      success: true, message: "OK",
      data: { workingDays, presentDays, halfDays, leaveDays, absentDays, totalLateMinutes: totalLate, totalOvertimeMinutes: totalOt, totalWorkMinutes: totalWork },
    });
  } catch (err) {
    console.error("[attendance/summary]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
