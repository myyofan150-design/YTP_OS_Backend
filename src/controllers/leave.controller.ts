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

const LEAVE_USED_FIELD: Record<string, string> = {
  CASUAL: "casual_used", SICK: "sick_used", PAID: "paid_used",
  EMERGENCY: "casual_used", COMP_OFF: "comp_off",
};
const LEAVE_TOTAL_FIELD: Record<string, string> = {
  CASUAL: "casual_total", SICK: "sick_total", PAID: "paid_total",
  EMERGENCY: "casual_total", COMP_OFF: "comp_off",
};

async function getEmpForUser(userId: number): Promise<RowDataPacket | null> {
  const rows = await q<RowDataPacket>("SELECT * FROM employees WHERE user_id = ?", [userId]);
  return rows[0] ?? null;
}

const LEAVE_SEL = `lr.id, lr.uuid, lr.employee_id AS employeeId, lr.leave_type AS leaveType,
  lr.from_date AS fromDate, lr.to_date AS toDate, lr.days, lr.reason, lr.status,
  lr.reviewed_by AS reviewedBy, lr.review_note AS reviewNote, lr.reviewed_at AS reviewedAt,
  lr.created_at AS createdAt`;

export async function applyLeave(req: Request, res: Response): Promise<void> {
  try {
    const emp = await getEmpForUser(req.user!.id);
    if (!emp) { res.status(404).json({ success: false, message: "Employee profile not found" }); return; }

    const { leaveType, fromDate, toDate, reason } = req.body as Record<string, string | undefined>;
    if (!leaveType || !fromDate || !toDate) {
      res.status(400).json({ success: false, message: "leaveType, fromDate and toDate are required" }); return;
    }

    const from = new Date(fromDate);
    const to   = new Date(toDate);
    if (from > to) { res.status(400).json({ success: false, message: "fromDate must be before toDate" }); return; }

    const days = workingDays(from, to);
    const year = from.getFullYear();

    // Check balance
    const balRows = await q<RowDataPacket>(
      "SELECT * FROM leave_balances WHERE employee_id = ? AND year = ?", [emp["id"], year]
    );
    if (balRows[0]) {
      const usedField  = LEAVE_USED_FIELD[leaveType]!;
      const totalField = LEAVE_TOTAL_FIELD[leaveType]!;
      const used  = Number(balRows[0][usedField]  ?? 0);
      const total = Number(balRows[0][totalField] ?? 0);
      if (leaveType !== "COMP_OFF" && (total - used) < days) {
        res.status(400).json({ success: false, message: `Insufficient leave balance. Remaining: ${(total - used).toFixed(1)}, Requested: ${days}` }); return;
      }
    }

    const result = await run(
      "INSERT INTO leave_requests (employee_id, leave_type, from_date, to_date, days, reason, status) VALUES (?, ?, ?, ?, ?, ?, 'PENDING')",
      [emp["id"], leaveType, fromDate, toDate, days, reason ?? null]
    );

    // Notify HR/ADMIN
    const hrUsers = await q<RowDataPacket>("SELECT id FROM users WHERE role IN ('HR','ADMIN','SUPER_ADMIN') AND status = 'ACTIVE'");
    const empUserRows = await q<RowDataPacket>("SELECT name FROM users WHERE id = ?", [req.user!.id]);
    const empName = empUserRows[0] ? String(empUserRows[0]["name"]) : "Employee";
    for (const u of hrUsers) {
      await run(
        "INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, 'LEAVE_REQUEST', 'New leave request', ?, '/leave')",
        [u["id"], `${empName} applied for ${days} day(s) of ${leaveType} leave`]
      );
    }

    await logActivity(req.user!.id, "leave.requested", "LeaveRequest", result.insertId, undefined, { leaveType, days }, req.ip);

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
        lb.paid_total AS paidTotal, lb.paid_used AS paidUsed
       FROM leave_requests lr
       JOIN employees e ON lr.employee_id = e.id
       JOIN users u ON e.user_id = u.id
       LEFT JOIN leave_balances lb ON lb.employee_id = e.id AND lb.year = YEAR(NOW())
       WHERE lr.status = 'PENDING'
       ORDER BY lr.created_at ASC`
    );
    const data = rows.map(r => ({
      id: r["id"], uuid: r["uuid"], leaveType: r["leaveType"], fromDate: r["fromDate"],
      toDate: r["toDate"], days: r["days"], reason: r["reason"], status: r["status"], createdAt: r["createdAt"],
      employee: {
        id: r["eId"], employeeCode: r["empCode"],
        user: { id: r["eUserId"], name: r["uName"], email: r["uEmail"], avatarUrl: r["uAvatar"] },
        leaveBalances: [{ casualTotal: r["casualTotal"], casualUsed: r["casualUsed"], sickTotal: r["sickTotal"], sickUsed: r["sickUsed"], paidTotal: r["paidTotal"], paidUsed: r["paidUsed"] }],
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
    const { status, employeeId } = req.query as Record<string, string | undefined>;
    let sql = `SELECT ${LEAVE_SEL}, e.id AS eId, e.employee_code AS empCode, u.name AS uName, u.avatar_url AS uAvatar
               FROM leave_requests lr JOIN employees e ON lr.employee_id = e.id JOIN users u ON e.user_id = u.id WHERE 1=1`;
    const p: unknown[] = [];
    if (status)     { sql += " AND lr.status = ?";      p.push(status); }
    if (employeeId) { sql += " AND lr.employee_id = ?"; p.push(Number(employeeId)); }
    sql += " ORDER BY lr.created_at DESC";
    const rows = await q<RowDataPacket>(sql, p as string[]);
    const data = rows.map(r => ({
      id: r["id"], uuid: r["uuid"], leaveType: r["leaveType"], fromDate: r["fromDate"],
      toDate: r["toDate"], days: r["days"], reason: r["reason"], status: r["status"], createdAt: r["createdAt"],
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
        const usedField = LEAVE_USED_FIELD[String(leave["leave_type"])]!;
        const days      = Number(leave["days"]);

        await conn.execute(
          `UPDATE leave_balances SET ${usedField} = ${usedField} + ? WHERE employee_id = ? AND year = ?`,
          [days, leave["employee_id"], year]
        );

        // Create attendance logs for each leave day
        const from = new Date(String(leave["from_date"]));
        const to   = new Date(String(leave["to_date"]));
        const cur  = new Date(from); cur.setHours(0, 0, 0, 0);
        while (cur <= to) {
          if (cur.getDay() !== 0) {
            const dateStr = cur.toISOString().split("T")[0];
            await conn.execute(
              `INSERT INTO attendance_logs (employee_id, date, type, late_minutes)
               VALUES (?, ?, 'LEAVE', 0)
               ON DUPLICATE KEY UPDATE type = 'LEAVE'`,
              [leave["employee_id"], dateStr]
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
      toDate: r["toDate"], days: r["days"], status: r["status"],
      employee: { id: r["eId"], user: { id: r["uId"], name: r["uName"], avatarUrl: r["uAvatar"] } },
    }));
    res.json({ success: true, message: "OK", data });
  } catch (err) {
    console.error("[leave/calendar]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
