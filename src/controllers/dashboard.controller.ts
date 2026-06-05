// src/controllers/dashboard.controller.ts
import { Request, Response } from "express";
import { q, RowDataPacket } from "../lib/db";

export async function getStats(_req: Request, res: Response) {
  try {
    const now     = new Date();
    const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const in30days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const todayStr = now.toISOString().split("T")[0];
    const m = now.getMonth() + 1, y = now.getFullYear();

    const [
      clients, employees, tasks, todos,
      invoiceMonth, invoiceCounts,
      payroll,
      renewals,
    ] = await Promise.all([
      q<RowDataPacket>("SELECT status, COUNT(*) AS cnt FROM clients GROUP BY status"),
      q<RowDataPacket>("SELECT status, COUNT(*) AS cnt FROM employees GROUP BY status"),
      q<RowDataPacket>("SELECT status, COUNT(*) AS cnt FROM tasks WHERE parent_task_id IS NULL GROUP BY status"),
      q<RowDataPacket>("SELECT status, COUNT(*) AS cnt FROM todo_tasks GROUP BY status"),
      q<RowDataPacket>(`SELECT COALESCE(SUM(total),0) AS total FROM invoices WHERE issue_date LIKE ? AND status != 'CANCELLED'`, [`${monthStr}%`]),
      q<RowDataPacket>("SELECT status, COUNT(*) AS cnt FROM invoices GROUP BY status"),
      q<RowDataPacket>("SELECT status, COUNT(*) AS cnt FROM payroll_records WHERE month = ? AND year = ? GROUP BY status", [m, y]),
      q<RowDataPacket>(
        "SELECT id, uuid, company_name AS companyName, contract_end AS contractEnd FROM clients WHERE contract_end >= ? AND contract_end <= ? AND status = 'ACTIVE' ORDER BY contract_end ASC LIMIT 10",
        [todayStr, in30days]
      ),
    ]);

    const byStatus = (rows: RowDataPacket[]) =>
      rows.reduce((acc, r) => { acc[String(r["status"])] = Number(r["cnt"]); return acc; }, {} as Record<string, number>);

    const cl = byStatus(clients);
    const em = byStatus(employees);
    const tk = byStatus(tasks);
    const td = byStatus(todos);
    const iv = byStatus(invoiceCounts);
    const pr = byStatus(payroll);

    res.json({
      success: true, message: "OK",
      data: {
        clients:   { total: clients.reduce((s,r) => s+Number(r["cnt"]),0), active: cl["ACTIVE"]??0, prospect: cl["PROSPECT"]??0 },
        employees: { total: employees.reduce((s,r) => s+Number(r["cnt"]),0), active: em["ACTIVE"]??0 },
        tasks:     { total: tasks.reduce((s,r) => s+Number(r["cnt"]),0), todo: tk["TODO"]??0, inProgress: tk["IN_PROGRESS"]??0, done: tk["DONE"]??0 },
        todos:     { total: todos.reduce((s,r) => s+Number(r["cnt"]),0), pending: td["pending"]??0, completed: td["completed"]??0 },
        invoices:  { thisMonthTotal: Number(invoiceMonth[0]?.["total"]??0), paid: iv["PAID"]??0, pending: iv["SENT"]??0, overdue: 0 },
        payroll:   { thisMonth: payroll.reduce((s,r) => s+Number(r["cnt"]),0), paid: pr["PAID"]??0, draft: pr["DRAFT"]??0 },
        renewals:  { count: renewals.length, list: renewals },
      },
    });
  } catch (err) {
    console.error("[dashboard/stats]", err);
    res.status(500).json({ success: false, message: "Failed to load stats" });
  }
}

export async function getRevenueChart(_req: Request, res: Response) {
  try {
    const now = new Date();
    const months: { month: string; amount: number }[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const prefix = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const rows = await q<RowDataPacket>(
        "SELECT COALESCE(SUM(total),0) AS total FROM invoices WHERE status = 'PAID' AND issue_date LIKE ?",
        [`${prefix}%`]
      );
      months.push({ month: d.toLocaleString("en-US", { month: "short", year: "numeric" }), amount: Number(rows[0]?.["total"] ?? 0) });
    }
    res.json({ success: true, data: months, message: "OK" });
  } catch (err) {
    console.error("[dashboard/revenue-chart]", err);
    res.status(500).json({ success: false, message: "Failed" });
  }
}

export async function getTaskChart(_req: Request, res: Response) {
  try {
    const rows = await q<RowDataPacket>("SELECT status, COUNT(*) AS cnt FROM tasks WHERE parent_task_id IS NULL GROUP BY status");
    const byStatus: Record<string, number> = {};
    rows.forEach(r => { byStatus[String(r["status"])] = Number(r["cnt"]); });
    const data = ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"].map(s => ({ status: s, count: byStatus[s] ?? 0 }));
    res.json({ success: true, data, message: "OK" });
  } catch (err) {
    console.error("[dashboard/task-chart]", err);
    res.status(500).json({ success: false, message: "Failed" });
  }
}

export async function getAttendanceSummary(_req: Request, res: Response) {
  try {
    const today = new Date().toISOString().split("T")[0];
    const [logs, empCount] = await Promise.all([
      q<RowDataPacket>("SELECT type, COUNT(*) AS cnt FROM attendance_logs WHERE date = ? GROUP BY type", [today]),
      q<RowDataPacket>("SELECT COUNT(*) AS cnt FROM employees WHERE status = 'ACTIVE'"),
    ]);
    const byType: Record<string, number> = {};
    logs.forEach(r => { byType[String(r["type"])] = Number(r["cnt"]); });
    const present = byType["PRESENT"] ?? 0;
    const halfDay = byType["HALF_DAY"] ?? 0;
    const onLeave = byType["LEAVE"] ?? 0;
    const activeEmps = Number(empCount[0]?.["cnt"] ?? 0);
    const absent = Math.max(0, activeEmps - present - halfDay - onLeave);
    res.json({ success: true, data: { present, halfDay, onLeave, absent, total: activeEmps }, message: "OK" });
  } catch (err) {
    console.error("[dashboard/attendance]", err);
    res.status(500).json({ success: false, message: "Failed" });
  }
}

export async function getActivityLogs(req: Request, res: Response) {
  try {
    const { entityType, action, userId, page = "1", limit = "50" } = req.query as Record<string, string>;
    let sql = `SELECT al.id, al.user_id AS userId, al.action, al.entity_type AS entityType, al.entity_id AS entityId,
               al.before_data AS beforeData, al.after_data AS afterData, al.ip_address AS ipAddress, al.created_at AS createdAt,
               u.name AS userName, u.email AS userEmail
               FROM activity_logs al LEFT JOIN users u ON al.user_id = u.id WHERE 1=1`;
    const p: unknown[] = [];
    if (entityType) { sql += " AND al.entity_type = ?"; p.push(entityType); }
    if (action)     { sql += " AND al.action LIKE ?";   p.push(`%${action}%`); }
    if (userId)     { sql += " AND al.user_id = ?";     p.push(Number(userId)); }

    const countSql = sql.replace(/SELECT.*?FROM activity_logs/s, "SELECT COUNT(*) AS cnt FROM activity_logs");
    const [countRows, dataRows] = await Promise.all([
      q<RowDataPacket>(countSql, p as string[]),
      (async () => {
        const skip = (Number(page) - 1) * Number(limit);
        return q<RowDataPacket>(sql + ` ORDER BY al.created_at DESC LIMIT ${Number(limit)} OFFSET ${skip}`, p as string[]);
      })(),
    ]);

    const total = Number(countRows[0]?.["cnt"] ?? 0);
    const logs = dataRows.map(l => ({
      ...l,
      id: String(l["id"]),  // BIGINT → string
      user: l["userId"] ? { id: l["userId"], name: l["userName"], email: l["userEmail"] } : null,
    }));
    res.json({ success: true, data: { logs, total, page: Number(page), limit: Number(limit) }, message: "OK" });
  } catch (err) {
    console.error("[activity-logs]", err);
    res.status(500).json({ success: false, message: "Failed" });
  }
}
