// src/controllers/clients.controller.ts
import { Request, Response } from "express";
import https from "https";
import http from "http";
import path from "path";
import PDFDocument from "pdfkit";
import { q, run, RowDataPacket } from "../lib/db";
import { encrypt, decrypt } from "../lib/encryption";
import { logActivity } from "../lib/logger";
import { uploadFile, deleteFile } from "../lib/storage";

// ─── PDF helpers ──────────────────────────────────────────────────────────────

function fetchUrlBuffer(url: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const get = url.startsWith("https") ? https.get : http.get;
    get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", () => resolve(null));
    }).on("error", () => resolve(null));
  });
}

async function getCompanySettings(): Promise<{ name: string; tagline: string; email: string; logoUrl: string | null }> {
  try {
    const rows = await q<RowDataPacket>(
      "SELECT `key`, value FROM system_settings WHERE `key` IN ('company_name','company_tagline','company_email','company_logo_url')"
    );
    const map: Record<string, string | null> = {};
    rows.forEach(r => { map[String(r["key"])] = r["value"] ? String(r["value"]) : null; });
    return {
      name:    map["company_name"]     ?? "Agency OS",
      tagline: map["company_tagline"]  ?? "Digital Marketing Agency",
      email:   map["company_email"]    ?? "contact@agencyos.in",
      logoUrl: map["company_logo_url"] ?? null,
    };
  } catch {
    return { name: "Agency OS", tagline: "Digital Marketing Agency", email: "contact@agencyos.in", logoUrl: null };
  }
}

type ClientPdfData = {
  companyName: string | null;
  contactPerson: string;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  website: string | null;
  gstNumber: string | null;
  address: string | null;
  country: string | null;
  city: string | null;
  status: string;
  contractType: string | null;
  clientTag: string | null;
  totalContractValue: number | null;
  contractStart: unknown;
  contractEnd: unknown;
  source: string | null;
  daysUntilRenewal: number | null;
  onHoldReason: string | null;
  nextFollowup: unknown;
  meetingDatetime: unknown;
  services: string[] | null;
  notes: string | null;
  logoUrl: string | null;
  assignedUser: { name: string; email: string } | null;
  contacts: { name: string; role: string | null; email: string | null; phone: string | null; isPrimary: boolean }[];
  payments: { totalReceived: number; balancePending: number | null };
};

async function generateClientProfilePdf(data: ClientPdfData): Promise<Buffer> {
  const company = await getCompanySettings();
  const logoBuffer = company.logoUrl ? await fetchUrlBuffer(company.logoUrl) : null;
  const clientLogoBuffer = data.logoUrl ? await fetchUrlBuffer(data.logoUrl) : null;

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageBg      = "#DFF2EE";
    const teal        = "#2AB5A2";
    const dark        = "#1C1C2E";
    const muted       = "#64748B";
    const white       = "#FFFFFF";
    const lightBx     = "#EEF2F5";
    const borderColor = "#E2E8F0";
    const PAGE_W = 595;
    const M  = 30;
    const CW = PAGE_W - M * 2; // 535

    const fmtDate = (d: unknown): string => {
      if (!d) return "—";
      const clean = String(d).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
        const [yr, mo, dy] = clean.split("-").map(Number);
        return new Date(yr, mo - 1, dy).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
      }
      const dt = new Date(String(d));
      return isNaN(dt.getTime()) ? "—" : dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
    };
    const fmtDatetime = (d: unknown): string => {
      if (!d) return "—";
      const dt = new Date(String(d));
      return isNaN(dt.getTime()) ? "—" : dt.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    };
    const fmtAmt = (n: number | null | undefined): string =>
      n != null ? `₹${Number(n).toLocaleString("en-IN")}` : "—";
    const str = (v: unknown): string =>
      (v != null && v !== "") ? String(v) : "—";

    // helper: draw a labeled field
    function field(label: string, value: string, fx: number, fy: number, fw: number) {
      doc.fillColor(muted).fontSize(6.5).font("Helvetica-Bold")
         .text(label.toUpperCase(), fx, fy, { width: fw, lineBreak: false });
      doc.fillColor(dark).fontSize(8.5).font("Helvetica")
         .text(value, fx, fy + 10, { width: fw, lineBreak: false });
    }

    // helper: divider line
    function divider(dx: number, dy: number, dw: number) {
      doc.moveTo(dx, dy).lineTo(dx + dw, dy).strokeColor(borderColor).lineWidth(0.5).stroke();
    }

    // helper: section heading inside a white card
    function sectionHead(label: string, hx: number, hy: number, hw: number) {
      doc.fillColor(teal).fontSize(7.5).font("Helvetica-Bold")
         .text(label, hx + 10, hy + 10, { lineBreak: false });
      divider(hx + 10, hy + 21, hw - 20);
    }

    // ── Background ──
    doc.rect(0, 0, PAGE_W, 842).fill(pageBg);

    // ── Header ──
    let agencyLogoRendered = false;
    if (logoBuffer) {
      try { doc.image(logoBuffer, M, 22, { height: 44, fit: [44, 44] }); agencyLogoRendered = true; }
      catch { /* skip */ }
    }
    const compNameX = agencyLogoRendered ? M + 52 : M;
    doc.fillColor(dark).fontSize(14).font("Helvetica-Bold")
       .text(company.name, compNameX, agencyLogoRendered ? 24 : 32, { width: 230, lineBreak: false });
    if (company.tagline) {
      doc.fillColor(muted).fontSize(8.5).font("Helvetica")
         .text(company.tagline, compNameX, agencyLogoRendered ? 44 : 50, { width: 230, lineBreak: false });
    }
    doc.fillColor(teal).fontSize(28).font("Helvetica-Bold")
       .text("Client Profile.", 330, 20, { width: 235, align: "right", lineBreak: false });
    doc.fillColor(muted).fontSize(8).font("Helvetica")
       .text(`Generated: ${fmtDate(new Date())}`, 330, 57, { width: 235, align: "right", lineBreak: false });

    // ── Client Identity Card ──
    let y = 88;
    const identH = 72;
    doc.roundedRect(M, y, CW, identH, 10).fill(white);

    // client avatar
    let clientLogoRendered = false;
    if (clientLogoBuffer) {
      try { doc.image(clientLogoBuffer, M + 12, y + 12, { height: 48, fit: [48, 48] }); clientLogoRendered = true; }
      catch { /* skip */ }
    }
    if (!clientLogoRendered) {
      const initials = (data.companyName ?? data.contactPerson).slice(0, 2).toUpperCase();
      doc.circle(M + 36, y + 36, 24).fill(teal);
      doc.fillColor(white).fontSize(12).font("Helvetica-Bold")
         .text(initials, M + 12, y + 30, { width: 48, align: "center", lineBreak: false });
    }

    // company name + subline
    const infoX = M + 68;
    const infoW = 260;
    doc.fillColor(dark).fontSize(14).font("Helvetica-Bold")
       .text(data.companyName ?? data.contactPerson, infoX, y + 12, { width: infoW, lineBreak: false });
    const subLine = [data.contactPerson, data.email, data.phone].filter(Boolean).join("  ·  ");
    doc.fillColor(muted).fontSize(7.5).font("Helvetica")
       .text(subLine, infoX, y + 33, { width: infoW, lineBreak: false });

    // status / contractType / tag badges (right-aligned)
    const badgeY  = y + 22;
    let badgeRX   = M + CW - 12;
    const statusColors: Record<string, [string, string]> = {
      ACTIVE:    ["#ECFDF5", "#059669"],
      INACTIVE:  ["#F1F5F9", "#64748B"],
      ON_HOLD:   ["#FFFBEB", "#D97706"],
      COMPLETED: ["#DBEAFE", "#1D4ED8"],
      CHURNED:   ["#FFF1F2", "#BE123C"],
    };
    const drawBadge = (label: string, bg: string, fg: string) => {
      doc.fontSize(6.5).font("Helvetica-Bold");
      const bw = Math.max(doc.widthOfString(label) + 12, 36);
      badgeRX -= bw;
      doc.roundedRect(badgeRX, badgeY, bw, 14, 7).fill(bg);
      doc.fillColor(fg).text(label, badgeRX, badgeY + 4, { width: bw, align: "center", lineBreak: false });
      badgeRX -= 5;
    };
    const [sBg, sFg] = statusColors[data.status] ?? ["#F1F5F9", "#64748B"];
    drawBadge(data.status, sBg, sFg);
    if (data.contractType) drawBadge(data.contractType, teal, white);
    if (data.clientTag)    drawBadge(data.clientTag, lightBx, muted);

    y += identH + 10;

    // ── Two-column: Contact Info | Contract Details ──
    const colGap = 10;
    const halfW  = Math.floor((CW - colGap) / 2); // 262
    const COL_L  = M;
    const COL_R  = M + halfW + colGap;
    const fHalf  = Math.floor(halfW / 2) - 14; // field half-width ≈ 117

    const cardH = 145;
    doc.roundedRect(COL_L, y, halfW, cardH, 8).fill(white);
    doc.roundedRect(COL_R, y, halfW, cardH, 8).fill(white);

    sectionHead("CONTACT INFORMATION", COL_L, y, halfW);
    field("Contact Person", str(data.contactPerson),               COL_L + 10,         y + 28, fHalf);
    field("Email",          str(data.email),                       COL_L + 10 + halfW/2, y + 28, fHalf);
    field("Phone",          str(data.phone),                       COL_L + 10,         y + 54, fHalf);
    field("GST Number",     str(data.gstNumber),                   COL_L + 10 + halfW/2, y + 54, fHalf);
    field("Country",        str(data.country),                     COL_L + 10,         y + 80, fHalf);
    field("City",           str(data.city),                        COL_L + 10 + halfW/2, y + 80, fHalf);
    field("Address",        str(data.address),                     COL_L + 10,         y + 106, halfW - 20);
    field("Website",        str(data.website),                     COL_L + 10,         y + 126, halfW - 20);

    sectionHead("CONTRACT DETAILS", COL_R, y, halfW);
    field("Contract Value", fmtAmt(data.totalContractValue),       COL_R + 10,         y + 28, fHalf);
    field("Contract Type",  str(data.contractType),                COL_R + 10 + halfW/2, y + 28, fHalf);
    field("Start Date",     fmtDate(data.contractStart),           COL_R + 10,         y + 54, fHalf);
    field("End Date",       fmtDate(data.contractEnd),             COL_R + 10 + halfW/2, y + 54, fHalf);
    field("Source",         str(data.source),                      COL_R + 10,         y + 80, fHalf);
    field("Renewal In",     data.daysUntilRenewal != null ? `${data.daysUntilRenewal} days` : "—", COL_R + 10 + halfW/2, y + 80, fHalf);
    field("Assigned To",    data.assignedUser ? `${data.assignedUser.name} (${data.assignedUser.email})` : "—", COL_R + 10, y + 106, halfW - 20);
    if (data.onHoldReason) {
      field("On Hold Reason", data.onHoldReason,                   COL_R + 10, y + 126, halfW - 20);
    }

    y += cardH + 10;

    // ── Tracking ──
    const trackH = 52;
    doc.roundedRect(M, y, CW, trackH, 8).fill(white);
    sectionHead("TRACKING", M, y, CW);
    field("Next Follow-up", fmtDate(data.nextFollowup),          M + 10,          y + 28, CW / 2 - 20);
    field("Meeting",        fmtDatetime(data.meetingDatetime),   M + 10 + CW / 2, y + 28, CW / 2 - 20);
    y += trackH + 10;

    // ── Services ──
    const services = data.services ?? [];
    const svcRows  = Math.max(1, Math.ceil((services.length || 1) / 6));
    const svcH     = 30 + svcRows * 20 + 8;
    doc.roundedRect(M, y, CW, svcH, 8).fill(white);
    sectionHead("SERVICES", M, y, CW);
    if (services.length === 0) {
      doc.fillColor(muted).fontSize(8).font("Helvetica")
         .text("No services added.", M + 10, y + 28, { lineBreak: false });
    } else {
      let sx = M + 10;
      let sy = y + 27;
      const maxX = M + CW - 10;
      services.forEach(svc => {
        doc.fontSize(7).font("Helvetica-Bold");
        const tagW = doc.widthOfString(svc) + 14;
        if (sx + tagW > maxX) { sx = M + 10; sy += 18; }
        doc.roundedRect(sx, sy, tagW, 14, 7).fill("#EEF2FF");
        doc.fillColor("#4338CA").text(svc, sx, sy + 4, { width: tagW, align: "center", lineBreak: false });
        sx += tagW + 6;
      });
    }
    y += svcH + 10;

    // ── Payments Summary ──
    const pyH = 52;
    doc.roundedRect(M, y, CW, pyH, 8).fill(white);
    sectionHead("PAYMENT SUMMARY", M, y, CW);
    const pyCol = CW / 3;
    field("Contract Value",  fmtAmt(data.totalContractValue),       M + 10,             y + 28, pyCol - 20);
    field("Total Received",  fmtAmt(data.payments.totalReceived),   M + 10 + pyCol,     y + 28, pyCol - 20);
    field("Balance Pending", data.payments.balancePending != null ? fmtAmt(data.payments.balancePending) : "—",
                                                                     M + 10 + pyCol * 2, y + 28, pyCol - 20);
    y += pyH + 10;

    // ── Contacts Table ──
    if (data.contacts.length > 0) {
      const ctRows = data.contacts.slice(0, 5);
      const ctH    = 30 + ctRows.length * 18 + 8;
      doc.roundedRect(M, y, CW, ctH, 8).fill(white);
      sectionHead("CONTACTS", M, y, CW);
      const cCols = [140, 90, 190, 115];
      let tblY = y + 27;
      doc.fillColor(muted).fontSize(6.5).font("Helvetica-Bold");
      doc.text("NAME",  M + 10,                               tblY, { width: cCols[0], lineBreak: false });
      doc.text("ROLE",  M + 10 + cCols[0],                   tblY, { width: cCols[1], lineBreak: false });
      doc.text("EMAIL", M + 10 + cCols[0] + cCols[1],        tblY, { width: cCols[2], lineBreak: false });
      doc.text("PHONE", M + 10 + cCols[0] + cCols[1] + cCols[2], tblY, { width: cCols[3], lineBreak: false });
      tblY += 12;
      ctRows.forEach(contact => {
        doc.fillColor(dark).fontSize(8).font("Helvetica");
        doc.text(contact.isPrimary ? `★ ${contact.name}` : contact.name, M + 10, tblY, { width: cCols[0], lineBreak: false });
        doc.text(contact.role  ?? "—", M + 10 + cCols[0],                   tblY, { width: cCols[1], lineBreak: false });
        doc.text(contact.email ?? "—", M + 10 + cCols[0] + cCols[1],        tblY, { width: cCols[2], lineBreak: false });
        doc.text(contact.phone ?? "—", M + 10 + cCols[0] + cCols[1] + cCols[2], tblY, { width: cCols[3], lineBreak: false });
        tblY += 18;
      });
      y += ctH + 10;
    }

    // ── Notes ──
    if (data.notes) {
      const notesText = data.notes.length > 450 ? data.notes.slice(0, 450) + "…" : data.notes;
      const lineEst   = Math.ceil(notesText.length / 85);
      const notesH    = Math.max(52, 30 + lineEst * 12 + 10);
      doc.roundedRect(M, y, CW, notesH, 8).fill(white);
      sectionHead("NOTES", M, y, CW);
      doc.fillColor(dark).fontSize(8.5).font("Helvetica")
         .text(notesText, M + 10, y + 28, { width: CW - 20 });
      y += notesH + 10;
    }

    // ── Footer ──
    doc.fillColor(muted).fontSize(7).font("Helvetica")
       .text(
         "This is a computer-generated client profile report.",
         M, 828, { width: CW, align: "center", lineBreak: false }
       );

    doc.end();
  });
}

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
    const { url } = await uploadFile(req.file.buffer, { folder: "client-logos", filename: req.file.originalname, mimetype: req.file.mimetype });
    await run("UPDATE clients SET logo_url = ? WHERE id = ?", [url, rows[0]["id"]]);
    await logActivity(req.user!.id, "client.logo_uploaded", "Client", Number(rows[0]["id"]), undefined, undefined, req.ip);
    res.json({ success: true, message: "Logo uploaded", data: { logoUrl: url } });
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
      res.status(400).json({ success: false, message: `File type not allowed. Allowed: ${ALLOWED_DOC_TYPES.join(", ")}` }); return;
    }

    const docName = (req.body as Record<string, string>)["name"] || req.file.originalname;
    const { url } = await uploadFile(req.file.buffer, { folder: "client-docs", filename: req.file.originalname, mimetype: req.file.mimetype });
    const result = await run(
      "INSERT INTO client_documents (client_id, name, file_path, file_type, uploaded_by) VALUES (?, ?, ?, ?, ?)",
      [rows[0]["id"], docName, url, ext.replace(".", ""), req.user!.id]
    );
    res.status(201).json({ success: true, message: "Document uploaded", data: { id: result.insertId, name: docName, filePath: url } });
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
    await deleteFile(String(rows[0]["filePath"]));
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

// ─── Client PDF Export ────────────────────────────────────────────────────────

export async function downloadClientPdf(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const rows = await q<RowDataPacket>(`SELECT ${CLIENT_SEL} FROM clients WHERE uuid = ?`, [uuid]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Client not found" }); return; }
    const client = rows[0];

    const [contactRows, paymentRows] = await Promise.all([
      q<RowDataPacket>(
        `SELECT name, email, phone, role, is_primary AS isPrimary
         FROM client_contacts WHERE client_id = ? ORDER BY is_primary DESC, created_at ASC`,
        [client["id"]]
      ),
      q<RowDataPacket>(
        "SELECT COALESCE(SUM(amount), 0) AS totalReceived FROM client_payments WHERE client_id = ?",
        [client["id"]]
      ),
    ]);

    let assignedUser: { name: string; email: string } | null = null;
    if (client["assignedTo"]) {
      const uRows = await q<RowDataPacket>("SELECT name, email FROM users WHERE id = ?", [client["assignedTo"]]);
      if (uRows[0]) assignedUser = { name: String(uRows[0]["name"]), email: String(uRows[0]["email"]) };
    }

    const totalReceived      = Number(paymentRows[0]?.["totalReceived"] ?? 0);
    const totalContractValue = client["totalContractValue"] != null ? Number(client["totalContractValue"]) : null;
    const balancePending     = totalContractValue != null ? totalContractValue - totalReceived : null;

    const pdfBuffer = await generateClientProfilePdf({
      companyName:        client["companyName"] as string | null,
      contactPerson:      String(client["contactPerson"]),
      email:              client["email"] as string | null,
      phone:              client["phone"] as string | null,
      whatsapp:           client["whatsapp"] as string | null,
      website:            client["website"] as string | null,
      gstNumber:          client["gstNumber"] as string | null,
      address:            client["address"] as string | null,
      country:            client["country"] as string | null,
      city:               client["city"] as string | null,
      status:             String(client["status"]),
      contractType:       client["contractType"] as string | null,
      clientTag:          client["clientTag"] as string | null,
      totalContractValue,
      contractStart:      client["contractStart"],
      contractEnd:        client["contractEnd"],
      source:             client["source"] as string | null,
      daysUntilRenewal:   daysUntil(client["contractEnd"]),
      onHoldReason:       client["onHoldReason"] as string | null,
      nextFollowup:       client["nextFollowup"],
      meetingDatetime:    client["meetingDatetime"],
      services:           parseServices(client["services"]),
      notes:              client["notes"] as string | null,
      logoUrl:            client["logoUrl"] as string | null,
      assignedUser,
      contacts: contactRows.map(c => ({
        name:      String(c["name"]),
        role:      c["role"] as string | null,
        email:     c["email"] as string | null,
        phone:     c["phone"] as string | null,
        isPrimary: Boolean(c["isPrimary"]),
      })),
      payments: { totalReceived, balancePending },
    });

    const safeName = (String(client["companyName"] ?? client["contactPerson"] ?? "client"))
      .replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").slice(0, 50);
    const filename = `${safeName}-profile.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("[clients/pdf]", err);
    res.status(500).json({ success: false, message: "Failed to generate client PDF" });
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
