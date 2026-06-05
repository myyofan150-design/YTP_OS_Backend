// src/controllers/attendance.controller.ts
import { Request, Response } from "express";
import { q, run, RowDataPacket } from "../lib/db";
import { logActivity } from "../lib/logger";

// ─── Camel-case mappers (MySQL returns snake_case) ────────────────────────────

// MySQL stores DATETIME as UTC but returns the raw string without 'Z'.
// Appending 'Z' tells the browser it's UTC, so toLocaleTimeString converts correctly to local IST.
function dt(s: unknown): string | null {
  if (!s) return null;
  const str = String(s);
  // Already has timezone marker — pass through
  if (str.includes("Z") || str.includes("+")) return str;
  // "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DDTHH:MM:SSZ"
  return str.replace(" ", "T") + "Z";
}

function mapLog(r: RowDataPacket, employee?: object): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id:              Number(r["id"]),
    employeeId:      Number(r["employee_id"]),
    date:            String(r["date"]).slice(0, 10),
    clockIn:         dt(r["clock_in"]),
    clockOut:        dt(r["clock_out"]),
    type:            r["type"],
    lateMinutes:     Number(r["late_minutes"]     ?? 0),
    earlyOutMinutes: Number(r["early_out_minutes"] ?? 0),
    overtimeMinutes: Number(r["overtime_minutes"] ?? 0),
    workMinutes:     r["work_minutes"] != null ? Number(r["work_minutes"]) : null,
    notes:           r["notes"]     ?? null,
    isManual:        Boolean(r["is_manual"]),
    source:          r["source"]    ?? "WEB",
    createdAt:       r["created_at"],
  };
  if (employee !== undefined) out["employee"] = employee;
  return out;
}

function mapRegularize(r: RowDataPacket): Record<string, unknown> {
  return {
    id:                Number(r["id"]),
    uuid:              r["uuid"],
    employeeId:        Number(r["employee_id"]),
    date:              String(r["date"]).slice(0, 10),
    requestedClockIn:  r["requested_clock_in"]  ?? null,
    requestedClockOut: r["requested_clock_out"] ?? null,
    requestedType:     r["requested_type"],
    reason:            r["reason"],
    status:            r["status"],
    reviewedBy:        r["reviewed_by"]  ?? null,
    reviewNote:        r["review_note"]  ?? null,
    reviewedAt:        r["reviewed_at"]  ?? null,
    createdAt:         r["created_at"],
    empCode:           r["empCode"]      ?? null,
    empName:           r["empName"]      ?? null,
    empAvatar:         r["empAvatar"]    ?? null,
    department:        r["department"]   ?? null,
    reviewerName:      r["reviewerName"] ?? null,
  };
}

function mapWFH(r: RowDataPacket): Record<string, unknown> {
  return {
    id:          Number(r["id"]),
    uuid:        r["uuid"],
    employeeId:  Number(r["employee_id"]),
    fromDate:    String(r["from_date"]).slice(0, 10),
    toDate:      String(r["to_date"]).slice(0, 10),
    days:        Number(r["days"]),
    reason:      r["reason"]      ?? null,
    status:      r["status"],
    reviewedBy:  r["reviewed_by"] ?? null,
    reviewNote:  r["review_note"] ?? null,
    reviewedAt:  r["reviewed_at"] ?? null,
    createdAt:   r["created_at"],
    empCode:     r["empCode"]      ?? null,
    empName:     r["empName"]      ?? null,
    empAvatar:   r["empAvatar"]    ?? null,
    department:  r["department"]   ?? null,
    reviewerName: r["reviewerName"] ?? null,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// IST = UTC + 5:30
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

// Today's date string in IST (important for employees clocking in between 12 AM – 5:30 AM IST)
function todayStr(): string {
  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  return nowIST.toISOString().split("T")[0]!;
}

function monthRange(month: number, year: number): { gte: string; lte: string } {
  const gte  = `${year}-${String(month).padStart(2, "0")}-01`;
  const last = new Date(year, month, 0).getDate();
  const lte  = `${year}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  return { gte, lte };
}

// Parse a MySQL datetime string (stored as UTC by the pool) back to a UTC Date.
// Without the 'Z', new Date("YYYY-MM-DD HH:MM:SS") is parsed as LOCAL time on the server,
// which is wrong when server is UTC and the string is UTC.
function parseUTC(s: string | null | undefined): Date | null {
  if (!s) return null;
  return new Date(String(s).replace(" ", "T") + "Z");
}

// Return the UTC timestamp that corresponds to a given IST time string (e.g. "09:00:00")
// for today's IST date. This is the correct reference for late/overtime calculations.
function shiftTodayUTC(timeStr: string): Date {
  const [h, m] = timeStr.split(":").map(Number);
  // Compute today's date in IST
  const nowIST    = new Date(Date.now() + IST_OFFSET_MS);
  // IST midnight as UTC timestamp
  const istMidnightUTC = Date.UTC(
    nowIST.getUTCFullYear(), nowIST.getUTCMonth(), nowIST.getUTCDate()
  ) - IST_OFFSET_MS;
  // Add shift hours (in IST)
  return new Date(istMidnightUTC + h! * 3600000 + m! * 60000);
}

function workingDaysInMonth(year: number, month: number): number {
  const daysInMonth = new Date(year, month, 0).getDate();

  // For the current month cap at today's IST date so future days aren't counted as absent
  const todayIST    = new Date(Date.now() + IST_OFFSET_MS);
  const isCurrent   = todayIST.getUTCFullYear() === year && todayIST.getUTCMonth() + 1 === month;
  const lastDay     = isCurrent ? Math.min(todayIST.getUTCDate(), daysInMonth) : daysInMonth;

  let count = 0;
  for (let d = 1; d <= lastDay; d++) {
    if (new Date(year, month - 1, d).getDay() !== 0) count++;
  }
  return count;
}

async function getEmployeeForUser(userId: number): Promise<RowDataPacket | null> {
  const rows = await q<RowDataPacket>(
    "SELECT id, shift_start AS shiftStart, shift_end AS shiftEnd FROM employees WHERE user_id = ?",
    [userId]
  );
  return rows[0] ?? null;
}

async function createNotification(userId: number, title: string, body: string, link: string): Promise<void> {
  await run(
    "INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, 'GENERAL', ?, ?, ?)",
    [userId, title, body, link]
  );
}

async function getHRUserIds(): Promise<number[]> {
  const rows = await q<RowDataPacket>(
    "SELECT id FROM users WHERE role IN ('SUPER_ADMIN','ADMIN','HR') AND status = 'ACTIVE'",
    []
  );
  return rows.map(r => Number(r["id"]));
}

// ─── Clock In / Out ───────────────────────────────────────────────────────────

export async function clockIn(req: Request, res: Response): Promise<void> {
  try {
    const emp = await getEmployeeForUser(req.user!.id);
    if (!emp) { res.status(404).json({ success: false, message: "Employee profile not found" }); return; }

    const today   = todayStr();
    const holiday = await q<RowDataPacket>("SELECT id FROM holidays WHERE date = ?", [today]);
    if (holiday[0]) { res.status(400).json({ success: false, message: "Today is a holiday — no clock-in required" }); return; }

    const existing = await q<RowDataPacket>(
      "SELECT id FROM attendance_logs WHERE employee_id = ? AND date = ?",
      [emp["id"], today]
    );
    if (existing[0]) { res.status(409).json({ success: false, message: "Already clocked in today" }); return; }

    const now           = new Date();
    const expectedStart = shiftTodayUTC(String(emp["shiftStart"]));
    const lateMinutes   = Math.max(0, Math.floor((now.getTime() - expectedStart.getTime()) / 60000));

    const result = await run(
      "INSERT INTO attendance_logs (employee_id, date, clock_in, type, late_minutes, source) VALUES (?, ?, ?, 'PRESENT', ?, 'WEB')",
      [emp["id"], today, now, lateMinutes]
    );
    const rows = await q<RowDataPacket>("SELECT * FROM attendance_logs WHERE id = ?", [result.insertId]);
    res.status(201).json({ success: true, message: "Clocked in", data: mapLog(rows[0]!) });
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
    const rows  = await q<RowDataPacket>(
      "SELECT * FROM attendance_logs WHERE employee_id = ? AND date = ?",
      [emp["id"], today]
    );
    if (!rows[0])              { res.status(404).json({ success: false, message: "No clock-in found for today" }); return; }
    if (rows[0]["clock_out"]) { res.status(409).json({ success: false, message: "Already clocked out today" }); return; }

    const now           = new Date();
    const clockInTime   = parseUTC(rows[0]["clock_in"] as string)!.getTime();
    const workMinutes   = Math.floor((now.getTime() - clockInTime) / 60000);
    const shiftStartMs  = shiftTodayUTC(String(emp["shiftStart"])).getTime();
    const shiftEndMs    = shiftTodayUTC(String(emp["shiftEnd"])).getTime();
    const shiftDuration = Math.floor((shiftEndMs - shiftStartMs) / 60000);
    const overtimeMinutes = Math.max(0, Math.floor((now.getTime() - shiftEndMs) / 60000));
    const type = workMinutes < shiftDuration / 2 ? "HALF_DAY" : String(rows[0]["type"]);

    await run(
      "UPDATE attendance_logs SET clock_out = ?, work_minutes = ?, overtime_minutes = ?, type = ? WHERE id = ?",
      [now, workMinutes, overtimeMinutes, type, rows[0]["id"]]
    );
    const updRows = await q<RowDataPacket>("SELECT * FROM attendance_logs WHERE id = ?", [rows[0]["id"]]);
    res.json({ success: true, message: "Clocked out", data: mapLog(updRows[0]!) });
  } catch (err) {
    console.error("[attendance/clock-out]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function getToday(req: Request, res: Response): Promise<void> {
  try {
    const emp = await getEmployeeForUser(req.user!.id);
    if (!emp) { res.status(404).json({ success: false, message: "Employee profile not found" }); return; }
    const rows = await q<RowDataPacket>(
      "SELECT * FROM attendance_logs WHERE employee_id = ? AND date = ?",
      [emp["id"], todayStr()]
    );
    res.json({ success: true, message: "OK", data: rows[0] ? mapLog(rows[0]) : null });
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
    const year  = parseInt(String(req.query["year"]  ?? now.getFullYear()), 10);
    const { gte, lte } = monthRange(month, year);

    const logs = await q<RowDataPacket>(
      "SELECT * FROM attendance_logs WHERE employee_id = ? AND date >= ? AND date <= ? ORDER BY date ASC",
      [emp["id"], gte, lte]
    );
    res.json({ success: true, message: "OK", data: logs.map(r => mapLog(r)) });
  } catch (err) {
    console.error("[attendance/my-history]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function attendanceSummary(req: Request, res: Response): Promise<void> {
  try {
    const now   = new Date();
    const month = parseInt(String(req.query["month"] ?? now.getMonth() + 1), 10);
    const year  = parseInt(String(req.query["year"]  ?? now.getFullYear()), 10);
    const { gte, lte } = monthRange(month, year);

    // Resolve which employee(s) to summarise
    const hrRoles  = ["SUPER_ADMIN", "ADMIN", "HR"];
    const isHR     = hrRoles.includes(req.user!.role);
    const paramEmpId = req.query["employeeId"]
      ? parseInt(String(req.query["employeeId"]), 10)
      : undefined;

    let targetEmpId: number | undefined = paramEmpId;
    if (!isHR && !targetEmpId) {
      // Employee viewing their own summary
      const emp = await getEmployeeForUser(req.user!.id);
      if (emp) targetEmpId = Number(emp["id"]);
    }
    // HR without explicit employeeId → team-wide summary (no filter)

    const clauses = ["date >= ?", "date <= ?"];
    const p: unknown[] = [gte, lte];
    if (targetEmpId) { clauses.push("employee_id = ?"); p.push(targetEmpId); }

    const logs = await q<RowDataPacket>(
      `SELECT type,
              late_minutes     AS lateMinutes,
              overtime_minutes AS overtimeMinutes,
              work_minutes     AS workMinutes
       FROM attendance_logs WHERE ${clauses.join(" AND ")}`,
      p
    );

    const wDays       = workingDaysInMonth(year, month);
    const presentDays = logs.filter(l => l["type"] === "PRESENT").length;
    const halfDays    = logs.filter(l => l["type"] === "HALF_DAY").length;
    const leaveDays   = logs.filter(l => l["type"] === "LEAVE").length;
    const compOffDays = logs.filter(l => l["type"] === "COMP_OFF").length;
    const wfhDays     = logs.filter(l => l["type"] === "WFH").length;
    const holidayDays = logs.filter(l => l["type"] === "HOLIDAY").length;
    const absentDays  = Math.max(0, wDays - presentDays - halfDays - leaveDays - compOffDays - wfhDays - holidayDays);
    const totalLate   = logs.reduce((s, l) => s + Number(l["lateMinutes"] ?? 0), 0);
    const totalOt     = logs.reduce((s, l) => s + Number(l["overtimeMinutes"] ?? 0), 0);
    const totalWork   = logs.reduce((s, l) => s + Number(l["workMinutes"] ?? 0), 0);

    res.json({
      success: true, message: "OK",
      data: { workingDays: wDays, presentDays, halfDays, leaveDays, compOffDays, wfhDays, holidayDays, absentDays, totalLateMinutes: totalLate, totalOvertimeMinutes: totalOt, totalWorkMinutes: totalWork },
    });
  } catch (err) {
    console.error("[attendance/summary]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Team Views ───────────────────────────────────────────────────────────────

export async function teamAttendance(req: Request, res: Response): Promise<void> {
  try {
    const now   = new Date();
    const month = parseInt(String(req.query["month"] ?? now.getMonth() + 1), 10);
    const year  = parseInt(String(req.query["year"]  ?? now.getFullYear()), 10);
    const empId = req.query["employeeId"] ? parseInt(String(req.query["employeeId"]), 10) : undefined;
    const date  = req.query["date"] ? String(req.query["date"]) : undefined;
    const { gte, lte } = monthRange(month, year);

    const clauses: string[] = [];
    const p: unknown[] = [];
    if (date) { clauses.push("a.date = ?"); p.push(date); }
    else { clauses.push("a.date >= ? AND a.date <= ?"); p.push(gte, lte); }
    if (empId) { clauses.push("a.employee_id = ?"); p.push(empId); }

    const rows = await q<RowDataPacket>(
      `SELECT a.*,
              e.id           AS eId,
              e.employee_code AS empCode,
              e.department,
              u.id           AS uId,
              u.name         AS uName,
              u.avatar_url   AS uAvatar
       FROM attendance_logs a
       JOIN employees e ON a.employee_id = e.id
       JOIN users     u ON e.user_id     = u.id
       WHERE ${clauses.join(" AND ")}
       ORDER BY a.date ASC, u.name ASC`,
      p
    );

    const data = rows.map(r => mapLog(r, {
      id:           Number(r["eId"]),
      employeeCode: r["empCode"],
      department:   r["department"] ?? null,
      user: { id: Number(r["uId"]), name: r["uName"], avatarUrl: r["uAvatar"] ?? null },
    }));

    res.json({ success: true, message: "OK", data });
  } catch (err) {
    console.error("[attendance/team]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function liveBoard(req: Request, res: Response): Promise<void> {
  try {
    const today = todayStr();
    const rows  = await q<RowDataPacket>(
      `SELECT e.id          AS employeeId,
              e.employee_code AS employeeCode,
              e.department,
              u.name,
              u.avatar_url   AS avatarUrl,
              a.id           AS logId,
              a.clock_in     AS clockIn,
              a.clock_out    AS clockOut,
              a.type,
              a.late_minutes AS lateMinutes
       FROM employees e
       JOIN users u ON e.user_id = u.id
       LEFT JOIN attendance_logs a ON a.employee_id = e.id AND a.date = ?
       WHERE e.status = 'ACTIVE'
       ORDER BY u.name ASC`,
      [today]
    );

    const data = rows.map(r => ({
      employeeId:   Number(r["employeeId"]),
      employeeCode: String(r["employeeCode"] ?? ""),
      department:   r["department"] ?? null,
      name:         String(r["name"] ?? ""),
      avatarUrl:    r["avatarUrl"]  ?? null,
      status: !r["logId"]
        ? "NOT_IN"
        : ["LEAVE","HOLIDAY","COMP_OFF"].includes(String(r["type"]))
          ? String(r["type"])
          : !r["clockOut"] ? "IN" : "OUT",
      clockIn:     dt(r["clockIn"]),
      clockOut:    dt(r["clockOut"]),
      lateMinutes: Number(r["lateMinutes"] ?? 0),
      type:        r["type"]        ?? null,
    }));

    res.json({ success: true, message: "OK", data });
  } catch (err) {
    console.error("[attendance/live]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function todayAbsentees(req: Request, res: Response): Promise<void> {
  try {
    const today = todayStr();
    if (new Date().getDay() === 0) { res.json({ success: true, message: "Sunday", data: [] }); return; }

    const holiday = await q<RowDataPacket>("SELECT id FROM holidays WHERE date = ?", [today]);
    if (holiday[0]) { res.json({ success: true, message: "Holiday", data: [] }); return; }

    const rows = await q<RowDataPacket>(
      `SELECT e.id AS employeeId, e.employee_code AS employeeCode, u.name, u.avatar_url AS avatarUrl
       FROM employees e JOIN users u ON e.user_id = u.id
       WHERE e.status = 'ACTIVE'
         AND NOT EXISTS (SELECT 1 FROM attendance_logs al WHERE al.employee_id = e.id AND al.date = ?)
         AND NOT EXISTS (
           SELECT 1 FROM leave_requests lr
           WHERE lr.employee_id = e.id AND lr.status = 'APPROVED'
             AND lr.from_date <= ? AND lr.to_date >= ?
         )
       ORDER BY u.name ASC`,
      [today, today, today]
    );
    res.json({ success: true, message: "OK", data: rows });
  } catch (err) {
    console.error("[attendance/absentees]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Override ─────────────────────────────────────────────────────────────────

export async function overrideAttendance(req: Request, res: Response): Promise<void> {
  try {
    const id   = parseInt(String(req.params["id"] ?? "0"), 10);
    const rows = await q<RowDataPacket>("SELECT * FROM attendance_logs WHERE id = ?", [id]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Attendance record not found" }); return; }

    const { type, clockIn, clockOut, notes, lateMinutes, overtimeMinutes, workMinutes } =
      req.body as Record<string, string | number | undefined>;

    const sets: string[] = ["is_manual = 1", "source = 'MANUAL'"];
    const p: unknown[] = [];

    let ciDate: Date | undefined;
    let coDate: Date | undefined;

    if (type    !== undefined) { sets.push("type = ?");  p.push(type); }
    if (clockIn !== undefined) {
      ciDate = new Date(String(clockIn));
      sets.push("clock_in = ?");
      p.push(ciDate);
    }
    if (clockOut !== undefined) {
      coDate = new Date(String(clockOut));
      sets.push("clock_out = ?");
      p.push(coDate);
    }
    if (notes !== undefined) { sets.push("notes = ?"); p.push(notes); }

    // Recalculate work_minutes from the resulting clock times (unless caller sent an explicit value)
    if (workMinutes !== undefined) {
      sets.push("work_minutes = ?");
      p.push(Number(workMinutes));
    } else {
      // Resolve final clock_in and clock_out after the override
      const finalCi = ciDate ?? parseUTC(rows[0]["clock_in"]  as string | null);
      const finalCo = coDate ?? parseUTC(rows[0]["clock_out"] as string | null);
      if (finalCi && finalCo) {
        const calcWork = Math.max(0, Math.floor((finalCo.getTime() - finalCi.getTime()) / 60000));
        sets.push("work_minutes = ?");
        p.push(calcWork);
      }
    }

    // Recalculate late_minutes from the new clock_in vs the employee shift_start
    if (lateMinutes !== undefined) {
      sets.push("late_minutes = ?");
      p.push(Number(lateMinutes));
    } else if (ciDate) {
      const empRows = await q<RowDataPacket>(
        `SELECT e.shift_start FROM employees e
         JOIN attendance_logs al ON al.employee_id = e.id WHERE al.id = ?`,
        [id]
      );
      if (empRows[0]) {
        const shiftStart = shiftTodayUTC(String(empRows[0]["shift_start"]));
        const calcLate   = Math.max(0, Math.floor((ciDate.getTime() - shiftStart.getTime()) / 60000));
        sets.push("late_minutes = ?");
        p.push(calcLate);
      }
    }

    if (overtimeMinutes !== undefined) {
      sets.push("overtime_minutes = ?");
      p.push(Number(overtimeMinutes));
    }

    p.push(id);
    await run(`UPDATE attendance_logs SET ${sets.join(", ")} WHERE id = ?`, p);
    const updRows = await q<RowDataPacket>("SELECT * FROM attendance_logs WHERE id = ?", [id]);
    await logActivity(req.user!.id, "attendance.manual_override", "AttendanceLog", id, rows[0], updRows[0], req.ip);
    res.json({ success: true, message: "Attendance overridden", data: mapLog(updRows[0]!) });
  } catch (err) {
    console.error("[attendance/override]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Regularization ───────────────────────────────────────────────────────────

export async function submitRegularize(req: Request, res: Response): Promise<void> {
  try {
    const emp = await getEmployeeForUser(req.user!.id);
    if (!emp) { res.status(404).json({ success: false, message: "Employee profile not found" }); return; }

    const { date, requestedClockIn, requestedClockOut, requestedType, reason } =
      req.body as Record<string, string | undefined>;

    if (!date || !reason || !requestedType) {
      res.status(400).json({ success: false, message: "date, requestedType and reason are required" }); return;
    }
    if (!["PRESENT","HALF_DAY","WFH"].includes(requestedType)) {
      res.status(400).json({ success: false, message: "requestedType must be PRESENT, HALF_DAY or WFH" }); return;
    }

    const result = await run(
      `INSERT INTO attendance_regularization_requests
         (employee_id, date, requested_clock_in, requested_clock_out, requested_type, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [emp["id"], date, requestedClockIn ?? null, requestedClockOut ?? null, requestedType, reason]
    );
    const rows = await q<RowDataPacket>(
      "SELECT * FROM attendance_regularization_requests WHERE id = ?",
      [result.insertId]
    );
    const hrIds = await getHRUserIds();
    for (const hId of hrIds) {
      await createNotification(hId, "Attendance Regularization Request",
        `New regularization request for ${date}`, "/attendance/regularize");
    }
    res.status(201).json({ success: true, message: "Regularization request submitted", data: mapRegularize(rows[0]!) });
  } catch (err) {
    console.error("[attendance/regularize/submit]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function myRegularizations(req: Request, res: Response): Promise<void> {
  try {
    const emp = await getEmployeeForUser(req.user!.id);
    if (!emp) { res.status(404).json({ success: false, message: "Employee profile not found" }); return; }

    const rows = await q<RowDataPacket>(
      `SELECT r.*, u.name AS reviewerName
       FROM attendance_regularization_requests r
       LEFT JOIN users u ON r.reviewed_by = u.id
       WHERE r.employee_id = ?
       ORDER BY r.created_at DESC`,
      [emp["id"]]
    );
    res.json({ success: true, message: "OK", data: rows.map(r => mapRegularize(r)) });
  } catch (err) {
    console.error("[attendance/regularize/my]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function pendingRegularizations(req: Request, res: Response): Promise<void> {
  try {
    const status = String(req.query["status"] ?? "PENDING");
    const rows   = await q<RowDataPacket>(
      `SELECT r.*,
              e.employee_code AS empCode, e.department,
              u.name          AS empName, u.avatar_url AS empAvatar,
              rv.name         AS reviewerName
       FROM attendance_regularization_requests r
       JOIN employees e ON r.employee_id = e.id
       JOIN users     u ON e.user_id     = u.id
       LEFT JOIN users rv ON r.reviewed_by = rv.id
       WHERE r.status = ?
       ORDER BY r.created_at DESC`,
      [status]
    );
    res.json({ success: true, message: "OK", data: rows.map(r => mapRegularize(r)) });
  } catch (err) {
    console.error("[attendance/regularize/pending]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function reviewRegularization(req: Request, res: Response): Promise<void> {
  try {
    const id   = parseInt(String(req.params["id"] ?? "0"), 10);
    const rows = await q<RowDataPacket>(
      `SELECT r.*, e.user_id AS empUserId, e.shift_start AS shiftStart, e.shift_end AS shiftEnd
       FROM attendance_regularization_requests r
       JOIN employees e ON r.employee_id = e.id
       WHERE r.id = ?`,
      [id]
    );
    if (!rows[0]) { res.status(404).json({ success: false, message: "Request not found" }); return; }
    if (rows[0]["status"] !== "PENDING") { res.status(400).json({ success: false, message: "Request already reviewed" }); return; }

    const { status, reviewNote } = req.body as { status?: string; reviewNote?: string };
    if (!status || !["APPROVED","REJECTED"].includes(status)) {
      res.status(400).json({ success: false, message: "status must be APPROVED or REJECTED" }); return;
    }

    await run(
      "UPDATE attendance_regularization_requests SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = NOW() WHERE id = ?",
      [status, req.user!.id, reviewNote ?? null, id]
    );

    if (status === "APPROVED") {
      const row    = rows[0]!;
      const date   = String(row["date"]).slice(0, 10);
      const ciStr  = row["requested_clock_in"]  ? String(row["requested_clock_in"])  : null;
      const coStr  = row["requested_clock_out"] ? String(row["requested_clock_out"]) : null;
      const rType  = String(row["requested_type"]);

      let lateMinutes = 0;
      if (ciStr) {
        const shiftStart = new Date(`${date}T${row["shiftStart"]}`);
        const clockInDt  = new Date(`${date}T${ciStr}`);
        lateMinutes = Math.max(0, Math.floor((clockInDt.getTime() - shiftStart.getTime()) / 60000));
      }

      await run(
        `INSERT INTO attendance_logs (employee_id, date, clock_in, clock_out, type, late_minutes, is_manual, source, regularization_id)
         VALUES (?, ?, ?, ?, ?, ?, 1, 'MANUAL', ?)
         ON DUPLICATE KEY UPDATE
           clock_in = VALUES(clock_in), clock_out = VALUES(clock_out),
           type = VALUES(type), late_minutes = VALUES(late_minutes),
           is_manual = 1, source = 'MANUAL', regularization_id = VALUES(regularization_id)`,
        [
          row["employee_id"], date,
          ciStr ? new Date(`${date}T${ciStr}`) : null,
          coStr ? new Date(`${date}T${coStr}`) : null,
          rType, lateMinutes, id,
        ]
      );
    }

    const msg = status === "APPROVED" ? "approved" : "rejected";
    await createNotification(Number(rows[0]["empUserId"]),
      `Regularization ${msg}`,
      `Your attendance regularization for ${String(rows[0]["date"]).slice(0,10)} was ${msg}`,
      "/attendance/regularize"
    );
    await logActivity(req.user!.id, `attendance.regularize.${msg}`, "RegularizationRequest", id, rows[0], { status, reviewNote }, req.ip);
    res.json({ success: true, message: `Request ${msg}` });
  } catch (err) {
    console.error("[attendance/regularize/review]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── WFH ─────────────────────────────────────────────────────────────────────

export async function submitWFH(req: Request, res: Response): Promise<void> {
  try {
    const emp = await getEmployeeForUser(req.user!.id);
    if (!emp) { res.status(404).json({ success: false, message: "Employee profile not found" }); return; }

    const { fromDate, toDate, reason } = req.body as Record<string, string | undefined>;
    if (!fromDate || !toDate) {
      res.status(400).json({ success: false, message: "fromDate and toDate are required" }); return;
    }

    let days = 0;
    const cur = new Date(fromDate), end = new Date(toDate);
    while (cur <= end) { if (cur.getDay() !== 0) days++; cur.setDate(cur.getDate() + 1); }

    const result = await run(
      "INSERT INTO wfh_requests (employee_id, from_date, to_date, days, reason) VALUES (?, ?, ?, ?, ?)",
      [emp["id"], fromDate, toDate, days, reason ?? null]
    );
    const rows = await q<RowDataPacket>("SELECT * FROM wfh_requests WHERE id = ?", [result.insertId]);

    const hrIds = await getHRUserIds();
    for (const hId of hrIds) {
      await createNotification(hId, "WFH Request Submitted",
        `New WFH request for ${fromDate} to ${toDate}`, "/attendance/wfh");
    }
    res.status(201).json({ success: true, message: "WFH request submitted", data: mapWFH(rows[0]!) });
  } catch (err) {
    console.error("[attendance/wfh/submit]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function myWFHRequests(req: Request, res: Response): Promise<void> {
  try {
    const emp = await getEmployeeForUser(req.user!.id);
    if (!emp) { res.status(404).json({ success: false, message: "Employee profile not found" }); return; }

    const rows = await q<RowDataPacket>(
      `SELECT w.*, u.name AS reviewerName
       FROM wfh_requests w
       LEFT JOIN users u ON w.reviewed_by = u.id
       WHERE w.employee_id = ?
       ORDER BY w.created_at DESC`,
      [emp["id"]]
    );
    res.json({ success: true, message: "OK", data: rows.map(r => mapWFH(r)) });
  } catch (err) {
    console.error("[attendance/wfh/my]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function pendingWFHRequests(req: Request, res: Response): Promise<void> {
  try {
    const status = String(req.query["status"] ?? "PENDING");
    const rows   = await q<RowDataPacket>(
      `SELECT w.*,
              e.employee_code AS empCode, e.department,
              u.name          AS empName, u.avatar_url AS empAvatar,
              rv.name         AS reviewerName
       FROM wfh_requests w
       JOIN employees e ON w.employee_id = e.id
       JOIN users     u ON e.user_id     = u.id
       LEFT JOIN users rv ON w.reviewed_by = rv.id
       WHERE w.status = ?
       ORDER BY w.created_at DESC`,
      [status]
    );
    res.json({ success: true, message: "OK", data: rows.map(r => mapWFH(r)) });
  } catch (err) {
    console.error("[attendance/wfh/pending]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function reviewWFH(req: Request, res: Response): Promise<void> {
  try {
    const id   = parseInt(String(req.params["id"] ?? "0"), 10);
    const rows = await q<RowDataPacket>(
      `SELECT w.*, e.user_id AS empUserId
       FROM wfh_requests w JOIN employees e ON w.employee_id = e.id WHERE w.id = ?`,
      [id]
    );
    if (!rows[0]) { res.status(404).json({ success: false, message: "Request not found" }); return; }
    if (rows[0]["status"] !== "PENDING") { res.status(400).json({ success: false, message: "Request already reviewed" }); return; }

    const { status, reviewNote } = req.body as { status?: string; reviewNote?: string };
    if (!status || !["APPROVED","REJECTED"].includes(status)) {
      res.status(400).json({ success: false, message: "status must be APPROVED or REJECTED" }); return;
    }

    await run(
      "UPDATE wfh_requests SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = NOW() WHERE id = ?",
      [status, req.user!.id, reviewNote ?? null, id]
    );

    if (status === "APPROVED") {
      const r     = rows[0]!;
      const empId = Number(r["employee_id"]);
      const cur   = new Date(String(r["from_date"]).slice(0, 10));
      const end   = new Date(String(r["to_date"]).slice(0, 10));
      while (cur <= end) {
        if (cur.getDay() !== 0) {
          const dateStr   = cur.toISOString().split("T")[0]!;
          const isHoliday = await q<RowDataPacket>("SELECT id FROM holidays WHERE date = ?", [dateStr]);
          if (!isHoliday[0]) {
            await run(
              `INSERT INTO attendance_logs (employee_id, date, type, late_minutes, is_manual, source)
               VALUES (?, ?, 'WFH', 0, 1, 'MANUAL')
               ON DUPLICATE KEY UPDATE type = 'WFH', is_manual = 1, source = 'MANUAL'`,
              [empId, dateStr]
            );
          }
        }
        cur.setDate(cur.getDate() + 1);
      }
    }

    const msg = status === "APPROVED" ? "approved" : "rejected";
    const row  = rows[0]!;
    await createNotification(Number(row["empUserId"]),
      `WFH Request ${msg}`,
      `Your WFH request for ${String(row["from_date"]).slice(0,10)} – ${String(row["to_date"]).slice(0,10)} was ${msg}`,
      "/attendance/wfh"
    );
    await logActivity(req.user!.id, `attendance.wfh.${msg}`, "WFHRequest", id, row, { status, reviewNote }, req.ip);
    res.json({ success: true, message: `WFH request ${msg}` });
  } catch (err) {
    console.error("[attendance/wfh/review]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Report ───────────────────────────────────────────────────────────────────

export async function attendanceReport(req: Request, res: Response): Promise<void> {
  try {
    const now   = new Date();
    const month = parseInt(String(req.query["month"] ?? now.getMonth() + 1), 10);
    const year  = parseInt(String(req.query["year"]  ?? now.getFullYear()), 10);
    const empId = req.query["employeeId"] ? parseInt(String(req.query["employeeId"]), 10) : undefined;
    const dept  = req.query["department"] ? String(req.query["department"]) : undefined;
    const { gte, lte } = monthRange(month, year);

    const clauses = ["a.date >= ?", "a.date <= ?"];
    const p: unknown[] = [gte, lte];
    if (empId) { clauses.push("a.employee_id = ?"); p.push(empId); }
    if (dept)  { clauses.push("e.department = ?");  p.push(dept); }

    const rows = await q<RowDataPacket>(
      `SELECT a.employee_id, a.type,
              a.late_minutes     AS lateMinutes,
              a.overtime_minutes AS overtimeMinutes,
              a.work_minutes     AS workMinutes,
              e.id AS eId, e.employee_code AS empCode, e.department, e.designation,
              u.name AS uName, u.avatar_url AS uAvatar
       FROM attendance_logs a
       JOIN employees e ON a.employee_id = e.id
       JOIN users     u ON e.user_id     = u.id
       WHERE ${clauses.join(" AND ")}
       ORDER BY u.name ASC, a.date ASC`,
      p
    );

    const wDays  = workingDaysInMonth(year, month);
    const empMap = new Map<number, {
      employeeId: number; employeeCode: string; name: string; avatarUrl: string | null;
      department: string | null; designation: string | null;
      present: number; halfDay: number; leave: number; compOff: number; wfh: number; holiday: number;
      totalLateMinutes: number; totalOvertimeMinutes: number; totalWorkMinutes: number;
    }>();

    for (const r of rows) {
      const eid = Number(r["eId"]);
      if (!empMap.has(eid)) {
        empMap.set(eid, {
          employeeId: eid, employeeCode: String(r["empCode"]),
          name: String(r["uName"]), avatarUrl: r["uAvatar"] ?? null,
          department: r["department"] ?? null, designation: r["designation"] ?? null,
          present: 0, halfDay: 0, leave: 0, compOff: 0, wfh: 0, holiday: 0,
          totalLateMinutes: 0, totalOvertimeMinutes: 0, totalWorkMinutes: 0,
        });
      }
      const entry = empMap.get(eid)!;
      const t = String(r["type"]);
      if      (t === "PRESENT")  entry.present++;
      else if (t === "HALF_DAY") entry.halfDay++;
      else if (t === "LEAVE")    entry.leave++;
      else if (t === "COMP_OFF") entry.compOff++;
      else if (t === "WFH")      entry.wfh++;
      else if (t === "HOLIDAY")  entry.holiday++;
      entry.totalLateMinutes     += Number(r["lateMinutes"]     ?? 0);
      entry.totalOvertimeMinutes += Number(r["overtimeMinutes"] ?? 0);
      entry.totalWorkMinutes     += Number(r["workMinutes"]     ?? 0);
    }

    const employees = [...empMap.values()].map(e => ({
      ...e,
      absent: Math.max(0, wDays - e.present - e.halfDay - e.leave - e.compOff - e.wfh - e.holiday),
    }));

    res.json({ success: true, message: "OK", data: { workingDays: wDays, month, year, employees } });
  } catch (err) {
    console.error("[attendance/report]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Policies ─────────────────────────────────────────────────────────────────

export async function getPolicies(req: Request, res: Response): Promise<void> {
  try {
    const rows = await q<RowDataPacket>("SELECT * FROM attendance_policies ORDER BY key_name ASC", []);
    const data = rows.map(r => ({
      id:          Number(r["id"]),
      keyName:     r["key_name"],
      value:       r["value"],
      label:       r["label"]       ?? null,
      description: r["description"] ?? null,
    }));
    res.json({ success: true, message: "OK", data });
  } catch (err) {
    console.error("[attendance/policies]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function updatePolicies(req: Request, res: Response): Promise<void> {
  try {
    const updates = req.body as Record<string, string>;
    for (const [key, value] of Object.entries(updates)) {
      await run(
        "UPDATE attendance_policies SET value = ?, updated_by = ? WHERE key_name = ?",
        [String(value), req.user!.id, key]
      );
    }
    await logActivity(req.user!.id, "attendance.policies.update", "AttendancePolicy", undefined, undefined, updates, req.ip);
    res.json({ success: true, message: "Policies updated" });
  } catch (err) {
    console.error("[attendance/policies/update]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
