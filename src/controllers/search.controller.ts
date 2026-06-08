import { Request, Response } from "express";
import { q, RowDataPacket } from "../lib/db";

export async function globalSearch(req: Request, res: Response): Promise<void> {
  try {
    const term = String(req.query["q"] ?? "").trim();
    if (term.length < 2) {
      res.json({ success: true, message: "OK", data: { clients: [], tasks: [], todos: [], invoices: [], employees: [], leads: [] } });
      return;
    }

    const role       = req.user!.role;
    const userId     = req.user!.id;
    const isClient   = role === "CLIENT";
    const isEmployee = role === "EMPLOYEE";
    const isHR       = role === "HR";
    const like       = `%${term}%`;

    // ── Clients ──────────────────────────────────────────────────────────────
    let clients: RowDataPacket[] = [];
    if (!isClient && !isEmployee) {
      clients = await q<RowDataPacket>(
        `SELECT uuid, company_name AS title, CONCAT(COALESCE(status,''), ' · ', COALESCE(contract_type,'')) AS subtitle
         FROM clients WHERE company_name LIKE ? OR contact_person LIKE ? OR email LIKE ?
         LIMIT 6`,
        [like, like, like]
      );
    }

    // ── Project Tasks ─────────────────────────────────────────────────────────
    let tasks: RowDataPacket[] = [];
    if (!isClient) {
      const taskWhere = isEmployee
        ? `(t.title LIKE ? OR t.description LIKE ?) AND (t.assigned_to_id = (SELECT id FROM employees WHERE user_id = ? LIMIT 1) OR EXISTS (SELECT 1 FROM task_members tm WHERE tm.task_id = t.id AND tm.user_id = ?))`
        : `(t.title LIKE ? OR t.description LIKE ?)`;
      const taskParams = isEmployee
        ? [like, like, userId, userId]
        : [like, like];

      tasks = await q<RowDataPacket>(
        `SELECT t.uuid, t.title, CONCAT(t.status, ' · ', COALESCE(c.company_name,'No client')) AS subtitle
         FROM tasks t LEFT JOIN clients c ON t.client_id = c.id
         WHERE ${taskWhere} LIMIT 6`,
        taskParams
      );
    }

    // ── Todo Tasks ────────────────────────────────────────────────────────────
    // Returns extra = list UUID so frontend can navigate to /todo?listUuid=<extra>
    const todos = await q<RowDataPacket>(
      `SELECT t.uuid, t.title,
              CONCAT(COALESCE(l.name,''), ' · ', t.status) AS subtitle,
              l.uuid AS extra
       FROM todo_tasks t
       JOIN todo_lists l ON l.id = t.list_id
       WHERE t.title LIKE ?
         AND (t.created_by = ? OR t.assigned_to = ?
              OR EXISTS (SELECT 1 FROM todo_task_members tm WHERE tm.task_id = t.id AND tm.user_id = ?))
       LIMIT 6`,
      [like, userId, userId, userId]
    );

    // ── Invoices ──────────────────────────────────────────────────────────────
    let invoices: RowDataPacket[] = [];
    if (!isClient && !isEmployee && !isHR) {
      invoices = await q<RowDataPacket>(
        `SELECT inv.uuid, inv.invoice_number AS title,
                CONCAT(COALESCE(c.company_name,''), ' · ', inv.status) AS subtitle
         FROM invoices inv LEFT JOIN clients c ON inv.client_id = c.id
         WHERE inv.invoice_number LIKE ? OR c.company_name LIKE ?
         LIMIT 6`,
        [like, like]
      );
    }

    // ── Employees ─────────────────────────────────────────────────────────────
    let employees: RowDataPacket[] = [];
    if (!isClient && !isEmployee) {
      employees = await q<RowDataPacket>(
        `SELECT e.uuid, u.name AS title,
                CONCAT(COALESCE(e.designation,''), ' · ', e.status) AS subtitle
         FROM employees e JOIN users u ON e.user_id = u.id
         WHERE u.name LIKE ? OR e.employee_code LIKE ? OR e.designation LIKE ?
         LIMIT 6`,
        [like, like, like]
      );
    }

    // ── Leads ─────────────────────────────────────────────────────────────────
    let leads: RowDataPacket[] = [];
    if (!isClient && !isEmployee && !isHR) {
      leads = await q<RowDataPacket>(
        `SELECT l.uuid, l.contact_person AS title,
                CONCAT(COALESCE(l.company_name,''), ' · ', COALESCE(s.label,'New')) AS subtitle
         FROM leads l LEFT JOIN lead_meta_options s ON l.status_id = s.id
         WHERE l.contact_person LIKE ? OR l.company_name LIKE ? OR l.email LIKE ?
         LIMIT 6`,
        [like, like, like]
      );
    }

    res.json({
      success: true,
      message: "OK",
      data: { clients, tasks, todos, invoices, employees, leads },
    });
  } catch (err) {
    console.error("[search]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
