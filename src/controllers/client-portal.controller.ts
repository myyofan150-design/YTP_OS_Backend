// src/controllers/client-portal.controller.ts
// All endpoints are scoped to the authenticated CLIENT user's linked client record.
import { Request, Response } from "express";
import { q, RowDataPacket } from "../lib/db";
import { generateInvoicePdf } from "./invoices.controller";

async function getClientId(userId: number): Promise<number | null> {
  const rows = await q<RowDataPacket>("SELECT client_id AS clientId FROM users WHERE id = ? AND role = 'CLIENT'", [userId]);
  return rows[0]?.["clientId"] ?? null;
}

// GET /api/client-portal/profile
export async function profile(req: Request, res: Response): Promise<void> {
  try {
    const clientId = await getClientId(req.user!.id);
    if (!clientId) { res.status(403).json({ success: false, message: "No client linked to this account" }); return; }

    const rows = await q<RowDataPacket>(
      `SELECT id, uuid, company_name AS companyName, contact_person AS contactPerson,
              email, phone, address, gst_number AS gstNumber,
              status, contract_type AS contractType, monthly_fee AS monthlyFee,
              contract_start AS contractStart, contract_end AS contractEnd,
              services, logo_url AS logoUrl, notes
       FROM clients WHERE id = ?`,
      [clientId]
    );
    if (!rows[0]) { res.status(404).json({ success: false, message: "Client not found" }); return; }

    const c = rows[0];
    let services: unknown[] = [];
    try { services = typeof c["services"] === "string" ? JSON.parse(c["services"]) : (c["services"] ?? []); } catch { /* ignore */ }

    res.json({ success: true, message: "OK", data: { ...c, services } });
  } catch (err) {
    console.error("[client-portal/profile]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// GET /api/client-portal/dashboard
export async function dashboard(req: Request, res: Response): Promise<void> {
  try {
    const clientId = await getClientId(req.user!.id);
    if (!clientId) { res.status(403).json({ success: false, message: "No client linked to this account" }); return; }

    const [clientRows, taskRows, invoiceRows] = await Promise.all([
      q<RowDataPacket>(
        `SELECT company_name AS companyName, status, contract_type AS contractType,
                monthly_fee AS monthlyFee, contract_start AS contractStart, contract_end AS contractEnd
         FROM clients WHERE id = ?`,
        [clientId]
      ),
      q<RowDataPacket>(
        `SELECT status, COUNT(*) AS cnt FROM tasks WHERE client_id = ? AND status != 'CANCELLED' GROUP BY status`,
        [clientId]
      ),
      q<RowDataPacket>(
        `SELECT status, SUM(total) AS total FROM invoices WHERE client_id = ? GROUP BY status`,
        [clientId]
      ),
    ]);

    const client = clientRows[0] ?? null;

    const taskCounts: Record<string, number> = {};
    for (const r of taskRows) taskCounts[String(r["status"])] = Number(r["cnt"]);

    const invoiceTotals: Record<string, number> = {};
    for (const r of invoiceRows) invoiceTotals[String(r["status"])] = Number(r["total"] ?? 0);

    // Days until contract renewal
    let daysUntilRenewal: number | null = null;
    if (client?.["contractEnd"]) {
      const end = new Date(String(client["contractEnd"]));
      daysUntilRenewal = Math.ceil((end.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    }

    // Recent task activity (last 5 updated tasks)
    const recentTasks = await q<RowDataPacket>(
      `SELECT t.id, t.uuid, t.title, t.status, t.priority, t.due_date AS dueDate, t.updated_at AS updatedAt,
              u.name AS assigneeName
       FROM tasks t
       LEFT JOIN users u ON t.assigned_to_id = u.id
       WHERE t.client_id = ? AND t.status != 'CANCELLED'
       ORDER BY t.updated_at DESC LIMIT 5`,
      [clientId]
    );

    res.json({
      success: true, message: "OK",
      data: {
        client,
        daysUntilRenewal,
        tasks: {
          todo:       taskCounts["TODO"]        ?? 0,
          inProgress: taskCounts["IN_PROGRESS"] ?? 0,
          inReview:   taskCounts["IN_REVIEW"]   ?? 0,
          done:       taskCounts["DONE"]        ?? 0,
          total: Object.values(taskCounts).reduce((a, b) => a + b, 0),
        },
        invoices: {
          paid:    invoiceTotals["PAID"]    ?? 0,
          pending: invoiceTotals["SENT"]    ?? 0,
          overdue: invoiceTotals["OVERDUE"] ?? 0,
          draft:   invoiceTotals["DRAFT"]   ?? 0,
        },
        recentTasks,
      },
    });
  } catch (err) {
    console.error("[client-portal/dashboard]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// GET /api/client-portal/tasks
export async function tasks(req: Request, res: Response): Promise<void> {
  try {
    const clientId = await getClientId(req.user!.id);
    if (!clientId) { res.status(403).json({ success: false, message: "No client linked to this account" }); return; }

    const { status, priority, search, overdue } = req.query as Record<string, string>;

    const clauses: string[] = ["t.client_id = ?"];
    const params: unknown[] = [clientId];

    if (status)            { clauses.push("t.status = ?");                               params.push(status); }
    if (priority)          { clauses.push("t.priority = ?");                             params.push(priority); }
    if (search)            { clauses.push("t.title LIKE ?");                             params.push(`%${search}%`); }
    if (overdue === "true"){ clauses.push("t.due_date < CURDATE() AND t.status != 'DONE'"); }

    const rows = await q<RowDataPacket>(
      `SELECT t.id, t.uuid, t.title, t.description, t.status, t.priority,
              t.due_date AS dueDate, t.created_at AS createdAt, t.updated_at AS updatedAt,
              u.name AS assigneeName,
              COALESCE(emp.photo_url, u.avatar_url) AS assigneeAvatar,
              (SELECT COUNT(*) FROM task_comments tc WHERE tc.task_id = t.id) AS commentCount,
              (SELECT COUNT(*) FROM task_attachments ta WHERE ta.task_id = t.id) AS attachmentCount,
              (SELECT COUNT(*) FROM task_subtasks st WHERE st.task_id = t.id) AS subTaskCount,
              (SELECT COUNT(*) FROM task_subtasks st WHERE st.task_id = t.id AND st.status = 'DONE') AS doneSubTaskCount,
              svc.id AS svcId, svc.label AS svcLabel, svc.color AS svcColor
       FROM tasks t
       LEFT JOIN users u ON t.assigned_to_id = u.id
       LEFT JOIN employees emp ON emp.user_id = u.id
       LEFT JOIN client_meta_options svc ON t.service_id = svc.id AND svc.type = 'service'
       WHERE ${clauses.join(" AND ")}
       ORDER BY
         CASE t.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
         t.due_date ASC, t.updated_at DESC`,
      params
    );

    const data = rows.map(r => ({
      ...r,
      subTaskCount:  Number(r.subTaskCount),
      subTasksDone:  Number(r.doneSubTaskCount),
      service: r.svcId ? { id: Number(r.svcId), label: String(r.svcLabel), color: String(r.svcColor) } : null,
      svcId: undefined, svcLabel: undefined, svcColor: undefined, doneSubTaskCount: undefined,
    }));

    res.json({ success: true, message: "OK", data });
  } catch (err) {
    console.error("[client-portal/tasks]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// GET /api/client-portal/tasks/:uuid
export async function taskDetail(req: Request, res: Response): Promise<void> {
  try {
    const clientId = await getClientId(req.user!.id);
    if (!clientId) { res.status(403).json({ success: false, message: "No client linked to this account" }); return; }

    const { uuid } = req.params;
    const rows = await q<RowDataPacket>(
      `SELECT t.id, t.uuid, t.title, t.description, t.status, t.priority,
              t.due_date AS dueDate, t.created_at AS createdAt, t.updated_at AS updatedAt,
              u.name AS assigneeName, COALESCE(emp.photo_url, u.avatar_url) AS assigneeAvatar
       FROM tasks t
       LEFT JOIN users u ON t.assigned_to_id = u.id
       LEFT JOIN employees emp ON emp.user_id = u.id
       WHERE t.uuid = ? AND t.client_id = ?`,
      [uuid, clientId]
    );
    if (!rows[0]) { res.status(404).json({ success: false, message: "Task not found" }); return; }

    const task = rows[0];

    const [comments, attachments] = await Promise.all([
      q<RowDataPacket>(
        `SELECT tc.id, tc.body, tc.created_at AS createdAt, u.name AS authorName, u.avatar_url AS authorAvatar
         FROM task_comments tc JOIN users u ON tc.user_id = u.id
         WHERE tc.task_id = ? ORDER BY tc.created_at ASC`,
        [task["id"]]
      ),
      q<RowDataPacket>(
        `SELECT id, file_name AS fileName, file_url AS fileUrl, created_at AS createdAt
         FROM task_attachments WHERE task_id = ? ORDER BY created_at ASC`,
        [task["id"]]
      ),
    ]);

    res.json({ success: true, message: "OK", data: { ...task, comments, attachments } });
  } catch (err) {
    console.error("[client-portal/task-detail]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// GET /api/client-portal/invoices
export async function invoices(req: Request, res: Response): Promise<void> {
  try {
    const clientId = await getClientId(req.user!.id);
    if (!clientId) { res.status(403).json({ success: false, message: "No client linked to this account" }); return; }

    const rows = await q<RowDataPacket>(
      `SELECT id, uuid, invoice_number AS invoiceNumber, issue_date AS issueDate,
              due_date AS dueDate, subtotal, gst_rate AS gstRate, gst_amount AS gstAmount,
              total, status, paid_at AS paidDate, pdf_path AS pdfUrl,
              created_at AS createdAt
       FROM invoices WHERE client_id = ?
       ORDER BY created_at DESC`,
      [clientId]
    );

    res.json({ success: true, message: "OK", data: rows });
  } catch (err) {
    console.error("[client-portal/invoices]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// GET /api/client-portal/invoices/:id/pdf
export async function invoicePdf(req: Request, res: Response): Promise<void> {
  try {
    const clientId = await getClientId(req.user!.id);
    if (!clientId) { res.status(403).json({ success: false, message: "No client linked to this account" }); return; }

    const invoiceId = Number(req.params["id"]);
    const rows = await q<RowDataPacket>(
      `SELECT i.id, i.invoice_number AS invoiceNumber, i.issue_date AS issueDate,
              i.due_date AS dueDate, i.subtotal, i.gst_rate AS gstRate,
              i.gst_amount AS gstAmount, i.total, i.status, i.notes, i.milestone,
              c.company_name AS companyName, c.contact_person AS contactPerson,
              c.email AS clEmail, c.address, c.gst_number AS gstNumber
       FROM invoices i JOIN clients c ON i.client_id = c.id
       WHERE i.id = ? AND i.client_id = ? AND i.status != 'DRAFT'`,
      [invoiceId, clientId]
    );
    if (!rows[0]) { res.status(404).json({ success: false, message: "Invoice not found" }); return; }

    const r = rows[0];
    const items = await q<RowDataPacket>(
      "SELECT description, quantity, unit_price AS unitPrice, amount FROM invoice_items WHERE invoice_id = ?",
      [invoiceId]
    );

    const fileName = `${String(r["invoiceNumber"]).replace(/\//g, "-")}.pdf`;
    const pdfBuffer = await generateInvoicePdf({
      id: invoiceId,
      invoiceNumber: String(r["invoiceNumber"]),
      issueDate:     r["issueDate"] as string,
      dueDate:       r["dueDate"] as string,
      subtotal:      Number(r["subtotal"]),
      gstRate:       Number(r["gstRate"]),
      gstAmount:     Number(r["gstAmount"]),
      total:         Number(r["total"]),
      notes:         r["notes"] as string | null,
      milestone:     r["milestone"] as string | null,
      client: {
        companyName:    String(r["companyName"]),
        contactPerson:  String(r["contactPerson"]),
        email:          r["clEmail"] as string | null,
        address:        r["address"] as string | null,
        gstNumber:      r["gstNumber"] as string | null,
      },
      lineItems: items.map(i => ({
        description: String(i["description"]),
        quantity:    Number(i["quantity"]),
        unitPrice:   Number(i["unitPrice"]),
        amount:      Number(i["amount"]),
      })),
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
    res.setHeader("Content-Length", pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("[client-portal/invoices/pdf]", err);
    res.status(500).json({ success: false, message: "Failed to generate PDF" });
  }
}

// GET /api/client-portal/documents
export async function documents(req: Request, res: Response): Promise<void> {
  try {
    const clientId = await getClientId(req.user!.id);
    if (!clientId) { res.status(403).json({ success: false, message: "No client linked to this account" }); return; }

    const rows = await q<RowDataPacket>(
      `SELECT id, name, file_path AS filePath, file_type AS fileType, created_at AS createdAt
       FROM client_documents WHERE client_id = ?
       ORDER BY created_at DESC`,
      [clientId]
    );

    res.json({ success: true, message: "OK", data: rows });
  } catch (err) {
    console.error("[client-portal/documents]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
