// src/controllers/leave.controller.ts
import { Request, Response } from "express";
import { q, run, pool, RowDataPacket } from "../lib/db";
import { logActivity } from "../lib/logger";

function workingDays(from: Date, to: Date): number {
  let count = 0;
  const cur = new Date(from); cur.setHours(0, 0, 0, 0);
  const end = new Date(to);   end.setHours(0, 0, 0, 0);
  while (cur <= end) {
    if (cur.getDay() !== 0) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// For CASUAL/SICK/PAID/EMERGENCY — fields that track used days against a total
const LEAVE_USED_FIELD: Record<string, string> = {
  CASUAL:    "casual_used",
  SICK:      "sick_used",
  PAID:      "paid_used",
  EMERGENCY: "casual_used",
};
const LEAVE_TOTAL_FIELD: Record<string, string> = {
  CASUAL:    "casual_total",
  SICK:      "sick_total",
  PAID:      "paid_total",
  EMERGENCY: "casual_total",
};

// Leave types allowed for half-day requests
const HALF_DAY_ALLOWED_TYPES = new Set(["CASUAL", "SICK", "PAID"]);

async function getEmpForUser(userId: number): Promise<RowDataPacket | null> {
  const rows = await q<RowDataPacket>("SELECT * FROM employees WHERE user_id = ?", [userId]);
  return rows[0] ?? null;
}

const LEAVE_SEL = `lr.id, lr.uuid, lr.employee_id AS employeeId, lr.leave_type AS leaveType,
  lr.from_date AS fromDate, lr.to_date AS toDate, lr.days,
  lr.is_half_day AS isHalfDay, lr.half_day_slot AS halfDaySlot,
  lr.reason, lr.status,
  lr.reviewed_by AS reviewedBy, lr.review_note AS reviewNote, lr.reviewed_at AS reviewedAt,
  lr.created_at AS createdAt`;

export async function applyLeave(req: Request, res: Response): Promise<void> {
  try {
    const emp = await getEmpForUser(req.user!.id);
    if (!emp) { res.status(404).json({ success: false, message: "Employee profile not found" }); return; }

    const { leaveType, fromDate, toDate, reason, isHalfDay, halfDaySlot } =
      req.body as Record<string, string | boolean | undefined>;

    if (!leaveType || !fromDate || !toDate) {
      res.status(400).json({ success: false, message: "leaveType, fromDate and toDate are required" }); return;
    }

    const halfDay = Boolean(isHalfDay);

    if (halfDay) {
      if (!HALF_DAY_ALLOWED_TYPES.has(String(leaveType))) {
        res.status(400).json({ success: false, message: "Half-day leave is only allowed for CASUAL, SICK, or PAID leave" }); return;
      }
      if (String(fromDate) !== String(toDate)) {
        res.status(400).json({ success: false, message: "Half-day leave must be for a single day (fromDate must equal toDate)" }); return;
      }
      if (!halfDaySlot || !["FIRST_HALF", "SECOND_HALF"].includes(String(halfDaySlot))) {
        res.status(400).json({ success: false, message: "halfDaySlot must be FIRST_HALF or SECOND_HALF for half-day leave" }); return;
      }
    }

    const from = new Date(String(fromDate));
    const to   = new Date(String(toDate));
    if (from > to) { res.status(400).json({ success: false, message: "fromDate must be before toDate" }); return; }

    const days = halfDay ? 0.5 : workingDays(from, to);
    const year = from.getFullYear();

    // Check balance
    const balRows = await q<RowDataPacket>(
      "SELECT * FROM leave_balances WHERE employee_id = ? AND year = ?", [emp["id"], year]
    );
    if (balRows[0]) {
      if (leaveType === "COMP_OFF") {
        const avail = Number(balRows[0]["comp_off"] ?? 0);
        if (avail < days) {
          res.status(400).json({ success: false, message: `Insufficient comp-off balance. Available: ${avail.toFixed(1)}, Requested: ${days}` }); return;
        }
      } else {
        const usedField  = LEAVE_USED_FIELD[String(leaveType)];
        const totalField = LEAVE_TOTAL_FIELD[String(leaveType)];
        if (usedField && totalField) {
          const used  = Number(balRows[0][usedField]  ?? 0);
          const total = Number(balRows[0][totalField] ?? 0);
          if ((total - used) < days) {
            res.status(400).json({ success: false, message: `Insufficient leave balance. Remaining: ${(total - used).toFixed(1)}, Requested: ${days}` }); return;
          }
        }
      }
    }

    const result = await run(
      `INSERT INTO leave_requests
         (employee_id, leave_type, from_date, to_date, days, is_half_day, half_day_slot, reason, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
      [emp["id"], leaveType, fromDate, toDate, days, halfDay ? 1 : 0, halfDay ? String(halfDaySlot) : null, reason ?? null]
    );

    // Notify HR/ADMIN
    const hrUsers = await q<RowDataPacket>("SELECT id FROM users WHERE role IN ('HR','ADMIN','SUPER_ADMIN') AND status = 'ACTIVE'");
    const empUserRows = await q<RowDataPacket>("SELECT name FROM users WHERE id = ?", [req.user!.id]);
    const empName = empUserRows[0] ? String(empUserRows[0]["name"]) : "Employee";
    const dayLabel = halfDay ? `half-day (${String(halfDaySlot).replace("_", " ").toLowerCase()})` : `${days} day(s)`;
    for (const u of hrUsers) {
      await run(
        "INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, 'LEAVE_REQUEST', 'New leave request', ?, '/leave')",
        [u["id"], `${empName} applied for ${dayLabel} of ${leaveType} leave`]
      );
    }

    await logActivity(req.user!.id, "leave.requested", "LeaveRequest", result.insertId, undefined, { leaveType, days, halfDay }, req.ip);

    const leaveRows = await q<RowDataPacket>(`SELECT ${LEAVE_SEL} FROM leave_requests lr WHERE lr.id = ?`, [result.insertId]);
    res.status(201).json({ success: true, message: "Leave request submitted", data: leaveRows[0] });
  } catch (err) {
    console.error("[leave/apply]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function myLeaveRequests(req: Request, res: Response): Promise<void> {
  try {
    const emp = await getEmpForUser(req.user!.id);
    if (!emp) { res.status(404).json({ success: false, message: "Employee profile not found" }); return; }
    const rows = await q<RowDataPacket>(`SELECT ${LEAVE_SEL} FROM leave_requests lr WHERE lr.employee_id = ? ORDER BY lr.created_at DESC`, [emp["id"]]);
    res.json({ success: true, message: "OK", data: rows });
  } catch (err) {
    console.error("[leave/my-requests]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function pendingLeaves(_req: Request, res: Response): Promise<void> {
  try {
    const rows = await q<RowDataPacket>(
      `SELECT ${LEAVE_SEL},
        e.id AS eId, e.employee_code AS empCode, e.user_id AS eUserId,
        u.name AS uName, u.email AS uEmail, u.avatar_url AS uAvatar,
        lb.casual_total AS casualTotal, lb.casual_used AS casualUsed,
        lb.sick_total AS sickTotal, lb.sick_used AS sickUsed,
        lb.paid_total AS paidTotal, lb.paid_used AS paidUsed,
        lb.comp_off AS compOff
       FROM leave_requests lr
       JOIN employees e ON lr.employee_id = e.id
       JOIN users u ON e.user_id = u.id
       LEFT JOIN leave_balances lb ON lb.employee_id = e.id AND lb.year = YEAR(NOW())
       WHERE lr.status = 'PENDING'
       ORDER BY lr.created_at ASC`
    );
    const data = rows.map(r => ({
      id: r["id"], uuid: r["uuid"], leaveType: r["leaveType"], fromDate: r["fromDate"],
      toDate: r["toDate"], days: r["days"], isHalfDay: Boolean(r["isHalfDay"]), halfDaySlot: r["halfDaySlot"],
      reason: r["reason"], status: r["status"], createdAt: r["createdAt"],
      employee: {
        id: r["eId"], employeeCode: r["empCode"],
        user: { id: r["eUserId"], name: r["uName"], email: r["uEmail"], avatarUrl: r["uAvatar"] },
        leaveBalances: [{ casualTotal: r["casualTotal"], casualUsed: r["casualUsed"], sickTotal: r["sickTotal"], sickUsed: r["sickUsed"], paidTotal: r["paidTotal"], paidUsed: r["paidUsed"], compOff: r["compOff"] }],
      },
    }));
    res.json({ success: true, message: "OK", data });
  } catch (err) {
    console.error("[leave/pending]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function allLeaves(req: Request, res: Response): Promise<void> {
  try {
    const { status, employeeId, leaveType, year, month, date } = req.query as Record<string, string | undefined>;
    let sql = `SELECT ${LEAVE_SEL}, e.id AS eId, e.employee_code AS empCode, u.name AS uName, u.avatar_url AS uAvatar
               FROM leave_requests lr JOIN employees e ON lr.employee_id = e.id JOIN users u ON e.user_id = u.id WHERE 1=1`;
    const p: unknown[] = [];
    if (status)     { sql += " AND lr.status = ?";               p.push(status); }
    if (employeeId) { sql += " AND lr.employee_id = ?";          p.push(Number(employeeId)); }
    if (leaveType)  { sql += " AND lr.leave_type = ?";           p.push(leaveType); }
    if (year)       { sql += " AND YEAR(lr.from_date) = ?";      p.push(Number(year)); }
    if (month)      { sql += " AND MONTH(lr.from_date) = ?";     p.push(Number(month)); }
    if (date)       { sql += " AND lr.from_date <= ? AND lr.to_date >= ?"; p.push(date); p.push(date); }
    sql += " ORDER BY lr.created_at DESC";
    const rows = await q<RowDataPacket>(sql, p as string[]);
    const data = rows.map(r => ({
      id: r["id"], uuid: r["uuid"], leaveType: r["leaveType"], fromDate: r["fromDate"],
      toDate: r["toDate"], days: r["days"], isHalfDay: Boolean(r["isHalfDay"]), halfDaySlot: r["halfDaySlot"],
      reason: r["reason"], status: r["status"], createdAt: r["createdAt"],
      employee: { id: r["eId"], employeeCode: r["empCode"], user: { name: r["uName"], avatarUrl: r["uAvatar"] } },
    }));
    res.json({ success: true, message: "OK", data });
  } catch (err) {
    console.error("[leave/all]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function reviewLeave(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const { status, reviewNote } = req.body as { status?: string; reviewNote?: string };
    if (!status || !["APPROVED", "REJECTED"].includes(status)) {
      res.status(400).json({ success: false, message: "status must be APPROVED or REJECTED" }); return;
    }

    const leaveRows = await q<RowDataPacket>(
      `SELECT lr.*, e.user_id AS eUserId, u.name AS uName
       FROM leave_requests lr JOIN employees e ON lr.employee_id = e.id JOIN users u ON e.user_id = u.id
       WHERE lr.uuid = ?`,
      [uuid]
    );
    if (!leaveRows[0]) { res.status(404).json({ success: false, message: "Leave request not found" }); return; }
    if (leaveRows[0]["status"] !== "PENDING") { res.status(409).json({ success: false, message: "Request already reviewed" }); return; }
    const leave = leaveRows[0];

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      await conn.execute(
        "UPDATE leave_requests SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = NOW() WHERE uuid = ?",
        [status, req.user!.id, reviewNote ?? null, uuid]
      );

      if (status === "APPROVED") {
        const year      = new Date(String(leave["from_date"])).getFullYear();
        const days      = Number(leave["days"]);
        const leaveType = String(leave["leave_type"]);
        const halfDay   = Boolean(leave["is_half_day"]);
        const halfSlot  = String(leave["half_day_slot"] ?? "");

        if (leaveType === "COMP_OFF") {
          // Deduct from comp_off available balance
          await conn.execute(
            "UPDATE leave_balances SET comp_off = comp_off - ? WHERE employee_id = ? AND year = ?",
            [days, leave["employee_id"], year]
          );
        } else {
          const usedField = LEAVE_USED_FIELD[leaveType];
          if (usedField) {
            await conn.execute(
              `UPDATE leave_balances SET ${usedField} = ${usedField} + ? WHERE employee_id = ? AND year = ?`,
              [days, leave["employee_id"], year]
            );
          }
        }

        // Create attendance logs for leave days
        const from = new Date(String(leave["from_date"]));
        const to   = new Date(String(leave["to_date"]));
        const cur  = new Date(from); cur.setHours(0, 0, 0, 0);
        while (cur <= to) {
          if (cur.getDay() !== 0) {
            const dateStr    = cur.toISOString().split("T")[0];
            const attType    = halfDay ? "HALF_DAY" : "LEAVE";
            const attNotes   = halfDay ? halfSlot : null;
            await conn.execute(
              `INSERT INTO attendance_logs (employee_id, date, type, notes, late_minutes)
               VALUES (?, ?, ?, ?, 0)
               ON DUPLICATE KEY UPDATE type = VALUES(type), notes = VALUES(notes)`,
              [leave["employee_id"], dateStr, attType, attNotes]
            );
          }
          cur.setDate(cur.getDate() + 1);
        }
      }

      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    // Notify employee
    await run(
      "INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, 'LEAVE_REQUEST', ?, ?, '/leave')",
      [
        leave["eUserId"],
        `Leave request ${status.toLowerCase()}`,
        `Your ${leave["leave_type"]} leave has been ${status.toLowerCase()}`,
      ]
    );

    await logActivity(
      req.user!.id,
      status === "APPROVED" ? "leave.approved" : "leave.rejected",
      "LeaveRequest", Number(leave["id"]), leave, { status }, req.ip
    );

    const updated = await q<RowDataPacket>(`SELECT ${LEAVE_SEL} FROM leave_requests lr WHERE lr.uuid = ?`, [uuid]);
    res.json({ success: true, message: `Leave ${status.toLowerCase()}`, data: updated[0] });
  } catch (err) {
    console.error("[leave/review]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function cancelLeave(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const rows = await q<RowDataPacket>(
      `SELECT lr.id, lr.status, lr.employee_id AS employeeId, e.user_id AS userId
       FROM leave_requests lr JOIN employees e ON lr.employee_id = e.id
       WHERE lr.uuid = ?`,
      [uuid]
    );
    if (!rows[0]) { res.status(404).json({ success: false, message: "Leave request not found" }); return; }

    if (Number(rows[0]["userId"]) !== req.user!.id) {
      res.status(403).json({ success: false, message: "You can only cancel your own leave requests" }); return;
    }
    if (rows[0]["status"] !== "PENDING") {
      res.status(409).json({ success: false, message: "Only PENDING requests can be cancelled" }); return;
    }

    await run("UPDATE leave_requests SET status = 'CANCELLED' WHERE uuid = ?", [uuid]);
    await logActivity(req.user!.id, "leave.cancelled", "LeaveRequest", Number(rows[0]["id"]), { status: "PENDING" }, { status: "CANCELLED" }, req.ip);

    res.json({ success: true, message: "Leave request cancelled", data: null });
  } catch (err) {
    console.error("[leave/cancel]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function leaveCalendar(req: Request, res: Response): Promise<void> {
  try {
    const now   = new Date();
    const month = parseInt(String(req.query["month"] ?? now.getMonth() + 1), 10);
    const year  = parseInt(String(req.query["year"]  ?? now.getFullYear()),  10);
    const gte = `${year}-${String(month).padStart(2, "0")}-01`;
    const last = new Date(year, month, 0).getDate();
    const lte = `${year}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`;

    const rows = await q<RowDataPacket>(
      `SELECT ${LEAVE_SEL}, e.id AS eId, u.id AS uId, u.name AS uName, u.avatar_url AS uAvatar
       FROM leave_requests lr
       JOIN employees e ON lr.employee_id = e.id
       JOIN users u ON e.user_id = u.id
       WHERE lr.status = 'APPROVED' AND lr.from_date <= ? AND lr.to_date >= ?
       ORDER BY lr.from_date ASC`,
      [lte, gte]
    );
    const data = rows.map(r => ({
      id: r["id"], uuid: r["uuid"], leaveType: r["leaveType"], fromDate: r["fromDate"],
      toDate: r["toDate"], days: r["days"], isHalfDay: Boolean(r["isHalfDay"]), halfDaySlot: r["halfDaySlot"],
      status: r["status"],
      employee: { id: r["eId"], user: { id: r["uId"], name: r["uName"], avatarUrl: r["uAvatar"] } },
    }));
    res.json({ success: true, message: "OK", data });
  } catch (err) {
    console.error("[leave/calendar]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
