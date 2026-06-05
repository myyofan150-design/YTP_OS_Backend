// src/controllers/comp-off.controller.ts
import { Request, Response } from "express";
import { q, run, pool, RowDataPacket } from "../lib/db";
import { logActivity } from "../lib/logger";

async function getEmpForUser(userId: number): Promise<RowDataPacket | null> {
  const rows = await q<RowDataPacket>("SELECT * FROM employees WHERE user_id = ?", [userId]);
  return rows[0] ?? null;
}

const SEL = `
  c.id, c.uuid, c.employee_id AS employeeId, c.worked_date AS workedDate,
  c.reason, c.status, c.expires_at AS expiresAt,
  c.reviewed_by AS reviewedBy, c.review_note AS reviewNote,
  c.reviewed_at AS reviewedAt, c.created_at AS createdAt`;

// POST /comp-off/request — employee submits an earn request
export async function requestCompOff(req: Request, res: Response): Promise<void> {
  try {
    const emp = await getEmpForUser(req.user!.id);
    if (!emp) { res.status(404).json({ success: false, message: "Employee profile not found" }); return; }

    const { workedDate, reason } = req.body as { workedDate?: string; reason?: string };
    if (!workedDate) { res.status(400).json({ success: false, message: "workedDate is required" }); return; }

    const wd = new Date(workedDate);
    if (isNaN(wd.getTime())) { res.status(400).json({ success: false, message: "Invalid workedDate" }); return; }
    if (wd >= new Date()) { res.status(400).json({ success: false, message: "workedDate must be in the past" }); return; }

    // Only Sundays or weekend-adjacent days (for now: require Sunday or Saturday)
    const dow = wd.getDay();
    if (dow !== 0 && dow !== 6) {
      res.status(400).json({ success: false, message: "Comp-off can only be requested for work done on a weekend (Saturday or Sunday)" }); return;
    }

    // Prevent duplicate requests for the same date
    const existing = await q<RowDataPacket>(
      "SELECT id FROM comp_off_requests WHERE employee_id = ? AND worked_date = ? AND status != 'REJECTED'",
      [emp["id"], workedDate]
    );
    if (existing.length > 0) {
      res.status(409).json({ success: false, message: "A comp-off request for this date already exists" }); return;
    }

    const result = await run(
      "INSERT INTO comp_off_requests (uuid, employee_id, worked_date, reason, status) VALUES (UUID(), ?, ?, ?, 'PENDING')",
      [emp["id"], workedDate, reason ?? null]
    );

    // Notify HR/ADMIN
    const hrUsers = await q<RowDataPacket>("SELECT id FROM users WHERE role IN ('HR','ADMIN','SUPER_ADMIN') AND status = 'ACTIVE'");
    const empUserRows = await q<RowDataPacket>("SELECT name FROM users WHERE id = ?", [req.user!.id]);
    const empName = empUserRows[0] ? String(empUserRows[0]["name"]) : "Employee";
    for (const u of hrUsers) {
      await run(
        "INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, 'GENERAL', 'Comp-off request', ?, '/leave')",
        [u["id"], `${empName} requested comp-off for ${workedDate}`]
      );
    }

    await logActivity(req.user!.id, "compoff.requested", "CompOffRequest", result.insertId, undefined, { workedDate }, req.ip);

    const rows = await q<RowDataPacket>(`SELECT ${SEL} FROM comp_off_requests c WHERE c.id = ?`, [result.insertId]);
    res.status(201).json({ success: true, message: "Comp-off request submitted", data: rows[0] });
  } catch (err) {
    console.error("[comp-off/request]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// GET /comp-off/my-requests — employee's own earn requests
export async function myCompOffRequests(req: Request, res: Response): Promise<void> {
  try {
    const emp = await getEmpForUser(req.user!.id);
    if (!emp) { res.status(404).json({ success: false, message: "Employee profile not found" }); return; }
    const rows = await q<RowDataPacket>(
      `SELECT ${SEL} FROM comp_off_requests c WHERE c.employee_id = ? ORDER BY c.worked_date DESC`,
      [emp["id"]]
    );
    res.json({ success: true, message: "OK", data: rows });
  } catch (err) {
    console.error("[comp-off/my-requests]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// GET /comp-off/pending — HR sees all pending earn requests
export async function pendingCompOffRequests(_req: Request, res: Response): Promise<void> {
  try {
    const rows = await q<RowDataPacket>(
      `SELECT ${SEL},
         e.id AS eId, e.employee_code AS empCode, e.user_id AS eUserId,
         u.name AS uName, u.email AS uEmail, u.avatar_url AS uAvatar
       FROM comp_off_requests c
       JOIN employees e ON c.employee_id = e.id
       JOIN users u ON e.user_id = u.id
       WHERE c.status = 'PENDING'
       ORDER BY c.worked_date ASC`
    );
    const data = rows.map(r => ({
      id: r["id"], uuid: r["uuid"], workedDate: r["workedDate"], reason: r["reason"],
      status: r["status"], expiresAt: r["expiresAt"], createdAt: r["createdAt"],
      employee: {
        id: r["eId"], employeeCode: r["empCode"],
        user: { id: r["eUserId"], name: r["uName"], email: r["uEmail"], avatarUrl: r["uAvatar"] },
      },
    }));
    res.json({ success: true, message: "OK", data });
  } catch (err) {
    console.error("[comp-off/pending]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// GET /comp-off/all — HR sees all earn requests (filterable)
export async function allCompOffRequests(req: Request, res: Response): Promise<void> {
  try {
    const { status, employeeId, year, month, date } = req.query as Record<string, string | undefined>;
    let sql = `SELECT ${SEL},
         e.id AS eId, e.employee_code AS empCode,
         u.name AS uName, u.avatar_url AS uAvatar
       FROM comp_off_requests c
       JOIN employees e ON c.employee_id = e.id
       JOIN users u ON e.user_id = u.id
       WHERE 1=1`;
    const p: unknown[] = [];
    if (status)     { sql += " AND c.status = ?";                  p.push(status); }
    if (employeeId) { sql += " AND c.employee_id = ?";             p.push(Number(employeeId)); }
    if (year)       { sql += " AND YEAR(c.worked_date) = ?";       p.push(Number(year)); }
    if (month)      { sql += " AND MONTH(c.worked_date) = ?";      p.push(Number(month)); }
    if (date)       { sql += " AND c.worked_date = ?";             p.push(date); }
    sql += " ORDER BY c.worked_date DESC";
    const rows = await q<RowDataPacket>(sql, p as string[]);
    const data = rows.map(r => ({
      id: r["id"], uuid: r["uuid"], workedDate: r["workedDate"], reason: r["reason"],
      status: r["status"], expiresAt: r["expiresAt"], createdAt: r["createdAt"],
      employee: { id: r["eId"], employeeCode: r["empCode"], user: { name: r["uName"], avatarUrl: r["uAvatar"] } },
    }));
    res.json({ success: true, message: "OK", data });
  } catch (err) {
    console.error("[comp-off/all]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// PATCH /comp-off/:uuid/review — HR approves or rejects
export async function reviewCompOffRequest(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const { status, reviewNote } = req.body as { status?: string; reviewNote?: string };
    if (!status || !["APPROVED", "REJECTED"].includes(status)) {
      res.status(400).json({ success: false, message: "status must be APPROVED or REJECTED" }); return;
    }

    const reqRows = await q<RowDataPacket>(
      `SELECT c.*, e.user_id AS eUserId, u.name AS uName
       FROM comp_off_requests c
       JOIN employees e ON c.employee_id = e.id
       JOIN users u ON e.user_id = u.id
       WHERE c.uuid = ?`,
      [uuid]
    );
    if (!reqRows[0]) { res.status(404).json({ success: false, message: "Comp-off request not found" }); return; }
    if (reqRows[0]["status"] !== "PENDING") { res.status(409).json({ success: false, message: "Request already reviewed" }); return; }
    const compOff = reqRows[0];

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Expiry = workedDate + 90 days (set on approval)
      let expiresAt: string | null = null;
      if (status === "APPROVED") {
        const wd = new Date(String(compOff["worked_date"]));
        wd.setDate(wd.getDate() + 90);
        expiresAt = wd.toISOString().split("T")[0]!;
      }

      await conn.execute(
        "UPDATE comp_off_requests SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = NOW(), expires_at = ? WHERE uuid = ?",
        [status, req.user!.id, reviewNote ?? null, expiresAt, uuid]
      );

      if (status === "APPROVED") {
        // Increment employee comp_off balance for current year
        const year = new Date().getFullYear();
        await conn.execute(
          `INSERT INTO leave_balances (employee_id, year, comp_off)
           VALUES (?, ?, 1)
           ON DUPLICATE KEY UPDATE comp_off = comp_off + 1`,
          [compOff["employee_id"], year]
        );
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
      "INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, 'GENERAL', ?, ?, '/leave')",
      [
        compOff["eUserId"],
        `Comp-off request ${status.toLowerCase()}`,
        `Your comp-off request for ${compOff["worked_date"]} has been ${status.toLowerCase()}`,
      ]
    );

    await logActivity(
      req.user!.id,
      status === "APPROVED" ? "compoff.approved" : "compoff.rejected",
      "CompOffRequest", Number(compOff["id"]), compOff, { status }, req.ip
    );

    const updated = await q<RowDataPacket>(`SELECT ${SEL} FROM comp_off_requests c WHERE c.uuid = ?`, [uuid]);
    res.json({ success: true, message: `Comp-off ${status.toLowerCase()}`, data: updated[0] });
  } catch (err) {
    console.error("[comp-off/review]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
