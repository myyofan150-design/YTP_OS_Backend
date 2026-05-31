// src/controllers/clients.controller.ts
import { Request, Response } from "express";
import path from "path";
import fs from "fs";
import { q, run, RowDataPacket } from "../lib/db";
import { encrypt, decrypt } from "../lib/encryption";
import { logActivity } from "../lib/logger";

const ALLOWED_DOC_TYPES = [".pdf", ".png", ".jpg", ".jpeg", ".docx", ".xlsx"];

function daysUntil(dateVal: unknown): number | null {
  if (!dateVal) return null;
  const d = dateVal instanceof Date ? dateVal : new Date(String(dateVal));
  return Math.ceil((d.getTime() - Date.now()) / 86_400_000);
}

function parseServices(raw: unknown): string[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw as string[];
  try { const p = JSON.parse(String(raw)); return Array.isArray(p) ? p : null; } catch { return null; }
}

// ─── SELECT fragment ──────────────────────────────────────────────────────────

const CLIENT_SEL = `id, uuid, company_name AS companyName, logo_url AS logoUrl, contact_person AS contactPerson,
  email, phone, whatsapp, website, client_tag AS clientTag,
  address, gst_number AS gstNumber, status, contract_type AS contractType,
  monthly_fee AS monthlyFee, total_contract_value AS totalContractValue,
  contract_start AS contractStart, contract_end AS contractEnd,
  services, notes, on_hold_reason AS onHoldReason,
  country, city, source, converted_from_lead_id AS convertedFromLeadId,
  last_contacted AS lastContacted, next_followup AS nextFollowup,
  meeting_datetime AS meetingDatetime,
  assigned_to AS assignedTo, created_by AS createdBy,
  created_at AS createdAt, updated_at AS updatedAt`;

// ─── listClients ──────────────────────────────────────────────────────────────

export async function listClients(req: Request, res: Response): Promise<void> {
  try {
    const { status, search, service, contractType, outstanding, taskSort } =
      req.query as Record<string, string | undefined>;

    // LEFT JOIN paid invoice totals — matches the client detail "Paid" figure
    let sql = `SELECT ${CLIENT_SEL},
      COALESCE(inv.totalPaid, 0) AS totalPaid
    FROM clients c
    LEFT JOIN (
      SELECT client_id, SUM(total) AS totalPaid
      FROM invoices
      WHERE status = 'PAID'
      GROUP BY client_id
    ) inv ON inv.client_id = c.id
    WHERE 1=1`;
    const p: unknown[] = [];

    if (status) { sql += " AND c.status = ?"; p.push(status); }
    if (search) {
      sql += " AND (c.company_name LIKE ? OR c.contact_person LIKE ? OR c.email LIKE ?)";
      p.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (service) {
      sql += " AND c.services IS NOT NULL AND JSON_CONTAINS(c.services, JSON_QUOTE(?))";
      p.push(service);
    }
    if (contractType) { sql += " AND c.contract_type = ?"; p.push(contractType); }
    if (outstanding === "1") {
      sql += " AND c.total_contract_value > 0 AND COALESCE(inv.totalPaid, 0) < c.total_contract_value";
    }

    sql += " ORDER BY c.company_name ASC";
    const clients = await q<RowDataPacket>(sql, p as string[]);

    const ids = clients.map(c => Number(c["id"]));
    const taskCounts: Record<number, number> = {};
    if (ids.length > 0) {
      const ph = ids.map(() => "?").join(",");
      const taskRows = await q<RowDataPacket>(
        `SELECT client_id, COUNT(*) AS cnt FROM tasks WHERE client_id IN (${ph}) AND status IN ('TODO','IN_PROGRESS','IN_REVIEW') AND parent_task_id IS NULL GROUP BY client_id`,
        ids
      );
      taskRows.forEach(r => { taskCounts[Number(r["client_id"])] = Number(r["cnt"]); });
    }

    const assignedIds = [...new Set(clients.map(c => c["assignedTo"]).filter(Boolean))] as number[];
    const userMap: Record<number, string> = {};
    if (assignedIds.length > 0) {
      const ph = assignedIds.map(() => "?").join(",");
      const uRows = await q<RowDataPacket>(`SELECT id, name FROM users WHERE id IN (${ph})`, assignedIds);
      uRows.forEach(u => { userMap[Number(u["id"])] = String(u["name"]); });
    }

    let mapped = clients.map(c => ({
      ...c,
      services:         parseServices(c["services"]),
      totalPaid:        Number(c["totalPaid"] ?? 0),  // sum of PAID invoices
      assignedToName:   c["assignedTo"] ? (userMap[Number(c["assignedTo"])] ?? null) : null,
      activeTasks:      taskCounts[Number(c["id"])] ?? 0,
      daysUntilRenewal: daysUntil(c["contractEnd"]),
    }));

    // Sort by active task count if requested
    if (taskSort === "asc") {
      mapped = mapped.sort((a, b) => (a.activeTasks ?? 0) - (b.activeTasks ?? 0));
    } else if (taskSort === "desc") {
      mapped = mapped.sort((a, b) => (b.activeTasks ?? 0) - (a.activeTasks ?? 0));
    }

    res.json({ success: true, message: "OK", data: mapped });
  } catch (err) {
    console.error("[clients/list]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── createClient ─────────────────────────────────────────────────────────────

export async function createClient(req: Request, res: Response): Promise<void> {
  try {
    const {
      companyName, contactPerson, email, phone, whatsapp, website,
      clientTag, address, gstNumber, status, contractType, monthlyFee,
      totalContractValue, contractStart, contractEnd, services, notes,
      onHoldReason, country, city, source, assignedTo,
    } = req.body as Record<string, unknown>;

    if (!contactPerson) {
      res.status(400).json({ success: false, message: "contactPerson is required" }); return;
    }

    const result = await run(
      `INSERT INTO clients (
        company_name, contact_person, email, phone, whatsapp, website,
        client_tag, address, gst_number, status, contract_type,
        monthly_fee, total_contract_value, contract_start, contract_end,
        services, notes, on_hold_reason, country, city, source,
        assigned_to, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(companyName), String(contactPerson),
        email              ? String(email)              : null,
        phone              ? String(phone)              : null,
        whatsapp           ? String(whatsapp)           : null,
        website            ? String(website)            : null,
        clientTag          ? String(clientTag)          : null,
        address            ? String(address)            : null,
        gstNumber          ? String(gstNumber)          : null,
        status             ?? "ACTIVE",
        contractType       ?? "MONTHLY",
        monthlyFee         ? Number(monthlyFee)         : null,
        totalContractValue ? Number(totalContractValue) : null,
        contractStart      ? String(contractStart)      : null,
        contractEnd        ? String(contractEnd)        : null,
        Array.isArray(services) ? JSON.stringify(services) : null,
        notes              ? String(notes)              : null,
        onHoldReason       ? String(onHoldReason)       : null,
        country            ? String(country)            : null,
        city               ? String(city)               : null,
        source             ?? "Manual",
        assignedTo         ? Number(assignedTo)         : null,
        req.user!.id,
      ]
    );
    const rows = await q<RowDataPacket>(`SELECT ${CLIENT_SEL} FROM clients WHERE id = ?`, [result.insertId]);
    await logActivity(req.user!.id, "client.created", "Client", result.insertId, undefined, { companyName }, req.ip);
    res.status(201).json({ success: true, message: "Client created", data: { ...rows[0], services: parseServices(rows[0]["services"]) } });
  } catch (err) {
    console.error("[clients/create]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── upcomingRenewals ─────────────────────────────────────────────────────────

export async function upcomingRenewals(_req: Request, res: Response): Promise<void> {
  try {
    const now    = new Date().toISOString().split("T")[0];
    const cutoff = new Date(Date.now() + 30 * 86_400_000).toISOString().split("T")[0];
    const clients = await q<RowDataPacket>(
      `SELECT ${CLIENT_SEL} FROM clients WHERE contract_end >= ? AND contract_end <= ? AND status != 'CHURNED' ORDER BY contract_end ASC`,
      [now, cutoff]
    );
    res.json({ success: true, message: "OK", data: clients.map(c => ({ ...c, services: parseServices(c["services"]), daysUntilRenewal: daysUntil(c["contractEnd"]) })) });
  } catch (err) {
    console.error("[clients/renewals]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── getClient ────────────────────────────────────────────────────────────────

export async function getClient(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const rows = await q<RowDataPacket>(`SELECT ${CLIENT_SEL} FROM clients WHERE uuid = ?`, [uuid]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Client not found" }); return; }
    const client = rows[0];

    const [creds, docs, tasks, contacts, payments] = await Promise.all([
      q<RowDataPacket>(
        "SELECT id, platform, username, password AS passwordEncrypted, url, notes, created_at AS createdAt FROM client_credentials WHERE client_id = ?",
        [client["id"]]
      ),
      q<RowDataPacket>(
        "SELECT id, name, file_path AS filePath, file_type AS fileType, uploaded_by AS uploadedBy, created_at AS createdAt FROM client_documents WHERE client_id = ?",
        [client["id"]]
      ),
      q<RowDataPacket>(
        `SELECT t.id, t.uuid, t.title, t.status, t.priority, t.due_date AS dueDate, t.created_at AS createdAt,
                u.id AS assignedToId, u.name AS assignedToName
         FROM tasks t LEFT JOIN users u ON t.assigned_to_id = u.id
         WHERE t.client_id = ? ORDER BY t.created_at DESC LIMIT 5`,
        [client["id"]]
      ),
      q<RowDataPacket>(
        `SELECT id, uuid, name, email, phone, whatsapp, role, is_primary AS isPrimary, created_at AS createdAt
         FROM client_contacts WHERE client_id = ? ORDER BY is_primary DESC, created_at ASC`,
        [client["id"]]
      ),
      q<RowDataPacket>(
        `SELECT id, uuid, amount, payment_mode AS paymentMode, payment_date AS paymentDate,
                milestone, notes, recorded_by AS recordedBy, created_at AS createdAt
         FROM client_payments WHERE client_id = ? ORDER BY payment_date DESC`,
        [client["id"]]
      ),
    ]);

    const credentials = creds.map(c => ({
      id: c["id"], platform: c["platform"], username: c["username"],
      url: c["url"], notes: c["notes"], createdAt: c["createdAt"],
      password: c["passwordEncrypted"]
        ? (() => { try { return decrypt(String(c["passwordEncrypted"])); } catch { return null; } })()
        : null,
    }));

    const tasksFormatted = tasks.map(t => ({
      id: t["id"], uuid: t["uuid"], title: t["title"], status: t["status"],
      priority: t["priority"], dueDate: t["dueDate"], createdAt: t["createdAt"],
      assignedTo: t["assignedToId"] ? { id: t["assignedToId"], name: t["assignedToName"] } : null,
    }));

    const totalReceived      = payments.reduce((sum, p) => sum + Number(p["amount"]), 0);
    const totalContractValue = client["totalContractValue"] != null ? Number(client["totalContractValue"]) : null;
    const balancePending     = totalContractValue != null ? totalContractValue - totalReceived : null;

    let assignedUser: RowDataPacket | null = null;
    if (client["assignedTo"]) {
      const uRows = await q<RowDataPacket>("SELECT id, name, email FROM users WHERE id = ?", [client["assignedTo"]]);
      assignedUser = uRows[0] ?? null;
    }

    res.json({
      success: true, message: "OK",
      data: {
        ...client,
        services: parseServices(client["services"]),
        credentials,
        documents: docs,
        tasks: tasksFormatted,
        contacts,
        payments: { records: payments, totalReceived, balancePending },
        assignedUser,
        daysUntilRenewal: daysUntil(client["contractEnd"]),
      },
    });
  } catch (err) {
    console.error("[clients/get]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── updateClient ─────────────────────────────────────────────────────────────

export async function updateClient(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const existRows = await q<RowDataPacket>(`SELECT ${CLIENT_SEL} FROM clients WHERE uuid = ?`, [uuid]);
    if (!existRows[0]) { res.status(404).json({ success: false, message: "Client not found" }); return; }

    const {
      companyName, contactPerson, email, phone, whatsapp, website,
      clientTag, address, gstNumber, status, contractType, monthlyFee,
      totalContractValue, contractStart, contractEnd, services, notes,
      onHoldReason, country, city, source, assignedTo,
    } = req.body as Record<string, unknown>;

    const sets: string[] = [];
    const p: unknown[] = [];
    if (companyName        != null) { sets.push("company_name = ?");          p.push(String(companyName)); }
    if (contactPerson      != null) { sets.push("contact_person = ?");        p.push(String(contactPerson)); }
    if (email              != null) { sets.push("email = ?");                 p.push(email || null); }
    if (phone              != null) { sets.push("phone = ?");                 p.push(phone || null); }
    if (whatsapp           != null) { sets.push("whatsapp = ?");              p.push(whatsapp || null); }
    if (website            != null) { sets.push("website = ?");               p.push(website || null); }
    if (clientTag          != null) { sets.push("client_tag = ?");            p.push(clientTag || null); }
    if (address            != null) { sets.push("address = ?");               p.push(address || null); }
    if (gstNumber          != null) { sets.push("gst_number = ?");            p.push(gstNumber || null); }
    if (status             != null) { sets.push("status = ?");                p.push(String(status)); }
    if (contractType       != null) { sets.push("contract_type = ?");         p.push(String(contractType)); }
    if (monthlyFee         != null) { sets.push("monthly_fee = ?");           p.push(monthlyFee ? Number(monthlyFee) : null); }
    if (totalContractValue != null) { sets.push("total_contract_value = ?");  p.push(totalContractValue ? Number(totalContractValue) : null); }
    if (contractStart      != null) { sets.push("contract_start = ?");        p.push(contractStart || null); }
    if (contractEnd        != null) { sets.push("contract_end = ?");          p.push(contractEnd || null); }
    if (services           != null) { sets.push("services = ?");              p.push(Array.isArray(services) ? JSON.stringify(services) : null); }
    if (notes              != null) { sets.push("notes = ?");                 p.push(notes || null); }
    if (onHoldReason       != null) { sets.push("on_hold_reason = ?");        p.push(onHoldReason || null); }
    if (country            != null) { sets.push("country = ?");               p.push(country || null); }
    if (city               != null) { sets.push("city = ?");                  p.push(city || null); }
    if (source             != null) { sets.push("source = ?");                p.push(String(source)); }
    if (assignedTo         !== undefined) { sets.push("assigned_to = ?");     p.push(assignedTo ? Number(assignedTo) : null); }

    if (sets.length > 0) {
      p.push(existRows[0]["id"]);
      await run(`UPDATE clients SET ${sets.join(", ")} WHERE id = ?`, p as string[]);
    }
    const updRows = await q<RowDataPacket>(`SELECT ${CLIENT_SEL} FROM clients WHERE id = ?`, [existRows[0]["id"]]);
    await logActivity(req.user!.id, "client.updated", "Client", Number(existRows[0]["id"]), existRows[0], updRows[0], req.ip);
    res.json({ success: true, message: "Client updated", data: { ...updRows[0], services: parseServices(updRows[0]["services"]) } });
  } catch (err) {
    console.error("[clients/update]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── deleteClient ─────────────────────────────────────────────────────────────

export async function deleteClient(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const rows = await q<RowDataPacket>("SELECT id FROM clients WHERE uuid = ?", [uuid]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Client not found" }); return; }
    await run("UPDATE clients SET status = 'CHURNED' WHERE id = ?", [rows[0]["id"]]);
    await logActivity(req.user!.id, "client.deleted", "Client", Number(rows[0]["id"]), undefined, { status: "CHURNED" }, req.ip);
    res.json({ success: true, message: "Client marked as churned", data: null });
  } catch (err) {
    console.error("[clients/delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Logo Upload ──────────────────────────────────────────────────────────────

export async function uploadClientLogo(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const rows = await q<RowDataPacket>("SELECT id FROM clients WHERE uuid = ?", [uuid]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Client not found" }); return; }
    if (!req.file) { res.status(400).json({ success: false, message: "No file uploaded" }); return; }
    const relativePath = `uploads/client-logos/${req.file.filename}`;
    await run("UPDATE clients SET logo_url = ? WHERE id = ?", [relativePath, rows[0]["id"]]);
    await logActivity(req.user!.id, "client.logo_uploaded", "Client", Number(rows[0]["id"]), undefined, undefined, req.ip);
    res.json({ success: true, message: "Logo uploaded", data: { logoUrl: relativePath } });
  } catch (err) {
    console.error("[clients/logo]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Credentials ──────────────────────────────────────────────────────────────

export async function addCredential(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const rows = await q<RowDataPacket>("SELECT id FROM clients WHERE uuid = ?", [uuid]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Client not found" }); return; }

    const { platform, username, password, url, notes } = req.body as Record<string, string | undefined>;
    if (!platform) { res.status(400).json({ success: false, message: "platform is required" }); return; }

    let encPassword: string | null = null;
    if (password) {
      try {
        encPassword = encrypt(password);
      } catch (encErr) {
        console.error("[clients/credentials/encrypt]", encErr);
        res.status(500).json({ success: false, message: "Encryption configuration error — check ENCRYPTION_KEY in server .env" }); return;
      }
    }

    const result = await run(
      "INSERT INTO client_credentials (client_id, platform, username, password, url, notes) VALUES (?, ?, ?, ?, ?, ?)",
      [rows[0]["id"], platform, username ?? null, encPassword, url ?? null, notes ?? null]
    );
    await logActivity(req.user!.id, "client.credential_added", "ClientCredential", result.insertId, undefined, { platform }, req.ip);
    res.status(201).json({
      success: true, message: "Credential added",
      data: { id: result.insertId, platform, username: username ?? null, password: password ?? null, url: url ?? null, notes: notes ?? null },
    });
  } catch (err) {
    console.error("[clients/credentials/add]", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    res.status(500).json({ success: false, message });
  }
}

export async function deleteCredential(req: Request, res: Response): Promise<void> {
  try {
    const credId = parseInt(String(req.params["credId"] ?? "0"), 10);
    const rows = await q<RowDataPacket>("SELECT id FROM client_credentials WHERE id = ?", [credId]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Credential not found" }); return; }
    await run("DELETE FROM client_credentials WHERE id = ?", [credId]);
    await logActivity(req.user!.id, "client.credential_deleted", "ClientCredential", credId, undefined, undefined, req.ip);
    res.json({ success: true, message: "Credential deleted", data: null });
  } catch (err) {
    console.error("[clients/credentials/delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Documents ────────────────────────────────────────────────────────────────

export async function uploadDocument(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const rows = await q<RowDataPacket>("SELECT id FROM clients WHERE uuid = ?", [uuid]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Client not found" }); return; }
    if (!req.file) { res.status(400).json({ success: false, message: "No file uploaded" }); return; }

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!ALLOWED_DOC_TYPES.includes(ext)) {
      fs.unlinkSync(req.file.path);
      res.status(400).json({ success: false, message: `File type not allowed. Allowed: ${ALLOWED_DOC_TYPES.join(", ")}` }); return;
    }

    const docName = (req.body as Record<string, string>)["name"] || req.file.originalname;
    const relativePath = `uploads/client-docs/${req.file.filename}`;
    const result = await run(
      "INSERT INTO client_documents (client_id, name, file_path, file_type, uploaded_by) VALUES (?, ?, ?, ?, ?)",
      [rows[0]["id"], docName, relativePath, ext.replace(".", ""), req.user!.id]
    );
    res.status(201).json({ success: true, message: "Document uploaded", data: { id: result.insertId, name: docName, filePath: relativePath } });
  } catch (err) {
    console.error("[clients/documents/upload]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function deleteDocument(req: Request, res: Response): Promise<void> {
  try {
    const docId = parseInt(String(req.params["docId"] ?? "0"), 10);
    const rows = await q<RowDataPacket>("SELECT id, file_path AS filePath FROM client_documents WHERE id = ?", [docId]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Document not found" }); return; }
    try { fs.unlinkSync(path.join(process.cwd(), String(rows[0]["filePath"]))); } catch { /* gone */ }
    await run("DELETE FROM client_documents WHERE id = ?", [docId]);
    await logActivity(req.user!.id, "client.document_deleted", "ClientDocument", docId, undefined, undefined, req.ip);
    res.json({ success: true, message: "Document deleted", data: null });
  } catch (err) {
    console.error("[clients/documents/delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Contacts ─────────────────────────────────────────────────────────────────

export async function listContacts(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const rows = await q<RowDataPacket>("SELECT id FROM clients WHERE uuid = ?", [uuid]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Client not found" }); return; }
    const contacts = await q<RowDataPacket>(
      `SELECT id, uuid, name, email, phone, whatsapp, role, is_primary AS isPrimary, created_at AS createdAt
       FROM client_contacts WHERE client_id = ? ORDER BY is_primary DESC, created_at ASC`,
      [rows[0]["id"]]
    );
    res.json({ success: true, message: "OK", data: contacts });
  } catch (err) {
    console.error("[clients/contacts/list]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function addContact(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const rows = await q<RowDataPacket>("SELECT id FROM clients WHERE uuid = ?", [uuid]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Client not found" }); return; }
    const clientId = Number(rows[0]["id"]);

    const { name, email, phone, whatsapp, role, isPrimary } = req.body as Record<string, unknown>;
    if (!name) { res.status(400).json({ success: false, message: "name is required" }); return; }

    if (isPrimary) {
      await run("UPDATE client_contacts SET is_primary = 0 WHERE client_id = ?", [clientId]);
    }

    const result = await run(
      `INSERT INTO client_contacts (client_id, name, email, phone, whatsapp, role, is_primary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        clientId, String(name),
        email    ? String(email)    : null,
        phone    ? String(phone)    : null,
        whatsapp ? String(whatsapp) : null,
        role     ? String(role)     : null,
        isPrimary ? 1 : 0,
      ]
    );
    await logActivity(req.user!.id, "client.contact_added", "ClientContact", result.insertId, undefined, { name }, req.ip);
    const contact = await q<RowDataPacket>(
      "SELECT id, uuid, name, email, phone, whatsapp, role, is_primary AS isPrimary, created_at AS createdAt FROM client_contacts WHERE id = ?",
      [result.insertId]
    );
    res.status(201).json({ success: true, message: "Contact added", data: contact[0] });
  } catch (err) {
    console.error("[clients/contacts/add]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function updateContact(req: Request, res: Response): Promise<void> {
  try {
    const { uuid, contactId } = req.params as Record<string, string>;
    const clientRows = await q<RowDataPacket>("SELECT id FROM clients WHERE uuid = ?", [uuid]);
    if (!clientRows[0]) { res.status(404).json({ success: false, message: "Client not found" }); return; }
    const clientId = Number(clientRows[0]["id"]);

    const contactRows = await q<RowDataPacket>(
      "SELECT id FROM client_contacts WHERE id = ? AND client_id = ?",
      [contactId, clientId]
    );
    if (!contactRows[0]) { res.status(404).json({ success: false, message: "Contact not found" }); return; }

    const { name, email, phone, whatsapp, role, isPrimary } = req.body as Record<string, unknown>;

    if (isPrimary) {
      await run("UPDATE client_contacts SET is_primary = 0 WHERE client_id = ?", [clientId]);
    }

    const sets: string[] = [];
    const p: unknown[] = [];
    if (name      != null) { sets.push("name = ?");       p.push(String(name)); }
    if (email     != null) { sets.push("email = ?");      p.push(email || null); }
    if (phone     != null) { sets.push("phone = ?");      p.push(phone || null); }
    if (whatsapp  != null) { sets.push("whatsapp = ?");   p.push(whatsapp || null); }
    if (role      != null) { sets.push("role = ?");       p.push(role || null); }
    if (isPrimary != null) { sets.push("is_primary = ?"); p.push(isPrimary ? 1 : 0); }

    if (sets.length > 0) {
      p.push(contactRows[0]["id"]);
      await run(`UPDATE client_contacts SET ${sets.join(", ")} WHERE id = ?`, p as string[]);
    }
    const updated = await q<RowDataPacket>(
      "SELECT id, uuid, name, email, phone, whatsapp, role, is_primary AS isPrimary, created_at AS createdAt FROM client_contacts WHERE id = ?",
      [contactRows[0]["id"]]
    );
    res.json({ success: true, message: "Contact updated", data: updated[0] });
  } catch (err) {
    console.error("[clients/contacts/update]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function deleteContact(req: Request, res: Response): Promise<void> {
  try {
    const { uuid, contactId } = req.params as Record<string, string>;
    const clientRows = await q<RowDataPacket>("SELECT id FROM clients WHERE uuid = ?", [uuid]);
    if (!clientRows[0]) { res.status(404).json({ success: false, message: "Client not found" }); return; }
    const clientId = Number(clientRows[0]["id"]);

    const contactRows = await q<RowDataPacket>(
      "SELECT id FROM client_contacts WHERE id = ? AND client_id = ?",
      [contactId, clientId]
    );
    if (!contactRows[0]) { res.status(404).json({ success: false, message: "Contact not found" }); return; }

    const countRows = await q<RowDataPacket>(
      "SELECT COUNT(*) AS cnt FROM client_contacts WHERE client_id = ?",
      [clientId]
    );
    if (Number(countRows[0]?.["cnt"]) <= 1) {
      res.status(400).json({ success: false, message: "Cannot delete the only contact" }); return;
    }

    await run("DELETE FROM client_contacts WHERE id = ?", [contactRows[0]["id"]]);
    res.json({ success: true, message: "Contact deleted", data: null });
  } catch (err) {
    console.error("[clients/contacts/delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Payments ─────────────────────────────────────────────────────────────────

export async function listPayments(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const rows = await q<RowDataPacket>(
      "SELECT id, total_contract_value AS totalContractValue FROM clients WHERE uuid = ?",
      [uuid]
    );
    if (!rows[0]) { res.status(404).json({ success: false, message: "Client not found" }); return; }

    const payments = await q<RowDataPacket>(
      `SELECT id, uuid, amount, payment_mode AS paymentMode, payment_date AS paymentDate,
              milestone, notes, recorded_by AS recordedBy, created_at AS createdAt
       FROM client_payments WHERE client_id = ? ORDER BY payment_date DESC`,
      [rows[0]["id"]]
    );

    const totalReceived      = payments.reduce((sum, p) => sum + Number(p["amount"]), 0);
    const totalContractValue = rows[0]["totalContractValue"] != null ? Number(rows[0]["totalContractValue"]) : null;
    const balancePending     = totalContractValue != null ? totalContractValue - totalReceived : null;

    res.json({ success: true, message: "OK", data: { records: payments, totalReceived, balancePending } });
  } catch (err) {
    console.error("[clients/payments/list]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function addPayment(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const rows = await q<RowDataPacket>("SELECT id FROM clients WHERE uuid = ?", [uuid]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Client not found" }); return; }

    const { amount, paymentMode, paymentDate, milestone, notes } = req.body as Record<string, unknown>;
    if (!amount || !paymentMode || !paymentDate) {
      res.status(400).json({ success: false, message: "amount, paymentMode and paymentDate are required" }); return;
    }

    const result = await run(
      `INSERT INTO client_payments (client_id, amount, payment_mode, payment_date, milestone, notes, recorded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        rows[0]["id"], Number(amount), String(paymentMode), String(paymentDate),
        milestone ? String(milestone) : null,
        notes     ? String(notes)     : null,
        req.user!.id,
      ]
    );
    await logActivity(req.user!.id, "client.payment_recorded", "ClientPayment", result.insertId, undefined, { amount, paymentMode }, req.ip);
    const payment = await q<RowDataPacket>(
      `SELECT id, uuid, amount, payment_mode AS paymentMode, payment_date AS paymentDate,
              milestone, notes, recorded_by AS recordedBy, created_at AS createdAt
       FROM client_payments WHERE id = ?`,
      [result.insertId]
    );
    res.status(201).json({ success: true, message: "Payment recorded", data: payment[0] });
  } catch (err) {
    console.error("[clients/payments/add]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function deletePayment(req: Request, res: Response): Promise<void> {
  try {
    const { uuid, paymentId } = req.params as Record<string, string>;
    const clientRows = await q<RowDataPacket>("SELECT id FROM clients WHERE uuid = ?", [uuid]);
    if (!clientRows[0]) { res.status(404).json({ success: false, message: "Client not found" }); return; }

    const payRows = await q<RowDataPacket>(
      "SELECT id FROM client_payments WHERE id = ? AND client_id = ?",
      [paymentId, clientRows[0]["id"]]
    );
    if (!payRows[0]) { res.status(404).json({ success: false, message: "Payment not found" }); return; }

    await run("DELETE FROM client_payments WHERE id = ?", [payRows[0]["id"]]);
    await logActivity(req.user!.id, "client.payment_deleted", "ClientPayment", Number(payRows[0]["id"]), undefined, undefined, req.ip);
    res.json({ success: true, message: "Payment deleted", data: null });
  } catch (err) {
    console.error("[clients/payments/delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Tracking ─────────────────────────────────────────────────────────────────

export async function updateTracking(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const rows = await q<RowDataPacket>("SELECT id, assigned_to AS assignedTo FROM clients WHERE uuid = ?", [uuid]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Client not found" }); return; }

    const role       = req.user!.role;
    const isAssigned = Number(rows[0]["assignedTo"]) === req.user!.id;
    if (!["SUPER_ADMIN", "ADMIN", "TEAM_LEAD"].includes(role) && !isAssigned) {
      res.status(403).json({ success: false, message: "Forbidden" }); return;
    }

    const { lastContacted, nextFollowup, meetingDatetime } = req.body as Record<string, unknown>;

    const sets: string[] = [];
    const p: unknown[] = [];
    if (lastContacted   != null) { sets.push("last_contacted = ?");   p.push(lastContacted   || null); }
    if (nextFollowup    != null) { sets.push("next_followup = ?");    p.push(nextFollowup    || null); }
    if (meetingDatetime != null) { sets.push("meeting_datetime = ?"); p.push(meetingDatetime || null); }

    if (sets.length > 0) {
      p.push(rows[0]["id"]);
      await run(`UPDATE clients SET ${sets.join(", ")} WHERE id = ?`, p as string[]);
    }
    await logActivity(req.user!.id, "client.tracking_updated", "Client", Number(rows[0]["id"]), undefined, { lastContacted, nextFollowup, meetingDatetime }, req.ip);
    res.json({ success: true, message: "Tracking updated", data: null });
  } catch (err) {
    console.error("[clients/tracking]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Notes ────────────────────────────────────────────────────────────────────

export async function updateNotes(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const rows = await q<RowDataPacket>("SELECT id FROM clients WHERE uuid = ?", [uuid]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Client not found" }); return; }
    const { notes } = req.body as Record<string, unknown>;
    await run("UPDATE clients SET notes = ? WHERE id = ?", [notes ?? null, rows[0]["id"]]);
    await logActivity(req.user!.id, "client.notes_updated", "Client", Number(rows[0]["id"]), undefined, { notes }, req.ip);
    res.json({ success: true, message: "Notes updated", data: null });
  } catch (err) {
    console.error("[clients/notes]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── hardDeleteClient ─────────────────────────────────────────────────────────

export async function hardDeleteClient(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const rows = await q<RowDataPacket>("SELECT id, company_name AS companyName FROM clients WHERE uuid = ?", [uuid]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Client not found" }); return; }
    const clientId   = Number(rows[0]["id"]);
    const companyName = rows[0]["companyName"];

    await run("DELETE FROM client_credentials WHERE client_id = ?", [clientId]);
    await run("DELETE FROM client_documents WHERE client_id = ?",   [clientId]);
    await run("DELETE FROM client_contacts WHERE client_id = ?",    [clientId]);
    await run("DELETE FROM client_payments WHERE client_id = ?",    [clientId]);
    await run("DELETE FROM tasks WHERE client_id = ?",              [clientId]);
    await run("DELETE FROM clients WHERE id = ?",                   [clientId]);

    await logActivity(req.user!.id, "client.hard_deleted", "Client", clientId, { companyName }, undefined, req.ip);
    res.json({ success: true, message: "Client permanently deleted", data: null });
  } catch (err) {
    console.error("[clients/hard-delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Timeline ─────────────────────────────────────────────────────────────────

export async function getTimeline(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const rows = await q<RowDataPacket>("SELECT id FROM clients WHERE uuid = ?", [uuid]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Client not found" }); return; }

    const logs = await q<RowDataPacket>(
      `SELECT al.id, al.action, al.before_data AS beforeData, al.after_data AS afterData,
              al.ip_address AS ipAddress, al.created_at AS createdAt,
              u.id AS actorId, u.name AS actorName
       FROM activity_logs al
       JOIN users u ON al.user_id = u.id
       WHERE al.entity_type = 'Client' AND al.entity_id = ?
       ORDER BY al.created_at DESC
       LIMIT 20`,
      [rows[0]["id"]]
    );

    res.json({ success: true, message: "OK", data: logs });
  } catch (err) {
    console.error("[clients/timeline]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
