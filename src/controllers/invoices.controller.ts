// src/controllers/invoices.controller.ts
import { Request, Response } from "express";
import path from "path";
import fs from "fs";
import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";
import { q, run, pool, RowDataPacket } from "../lib/db";
import { logActivity } from "../lib/logger";

// ─── PDF Generation ────────────────────────────────────────────────────────


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

async function generateInvoicePdf(invoice: {
  id: number; invoiceNumber: string; issueDate: Date | string; dueDate: Date | string;
  subtotal: number; gstRate: number; gstAmount: number; total: number; notes: string | null;
  milestone?: string | null;
  client: { companyName: string; contactPerson: string; email: string | null; address: string | null; gstNumber: string | null };
  lineItems: { description: string; quantity: number; unitPrice: number; amount: number }[];
}): Promise<string> {
  const dir = path.join(process.cwd(), "uploads", "invoices");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const fileName = `${invoice.invoiceNumber.replace(/\//g, "-")}.pdf`;
  const filePath = path.join(dir, fileName);
  const relativePath = `uploads/invoices/${fileName}`;

  const company = await getCompanySettings();

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const pageBg  = "#DFF2EE";
    const teal    = "#2AB5A2";
    const dark    = "#1C1C2E";
    const muted   = "#64748B";
    const white   = "#FFFFFF";
    const lightBx = "#EEF2F5";
    const altRow  = "#F1F5F9";

    const fmtDate = (d: Date | string) =>
      (d instanceof Date ? d : new Date(String(d)))
        .toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
    const fmtAmt = (n: number) => `\u20B9${n.toFixed(2)}`;

    // \u2500 Page background \u2500
    doc.rect(0, 0, 595, 842).fill(pageBg);

    // \u2500 Header (y: ~22\u201380) \u2500
    const logoAbsPath = company.logoUrl ? path.join(process.cwd(), company.logoUrl) : null;
    let logoRendered = false;
    if (logoAbsPath && fs.existsSync(logoAbsPath)) {
      try { doc.image(logoAbsPath, 30, 22, { height: 44, fit: [44, 44] }); logoRendered = true; }
      catch { /* skip */ }
    }
    const nameX = logoRendered ? 82 : 30;
    doc.fillColor(dark).fontSize(14).font("Helvetica-Bold")
       .text(company.name, nameX, logoRendered ? 24 : 32, { width: 230, lineBreak: false });
    if (company.tagline) {
      doc.fillColor(muted).fontSize(8.5).font("Helvetica")
         .text(company.tagline, nameX, logoRendered ? 44 : 50, { width: 230, lineBreak: false });
    }
    doc.fillColor(teal).fontSize(32).font("Helvetica-Bold")
       .text("Invoice.", 330, 18, { width: 235, align: "right", lineBreak: false });
    doc.fillColor(muted).fontSize(8).font("Helvetica")
       .text("Document Payment Information", 330, 58, { width: 235, align: "right", lineBreak: false });

    // \u2500 White metadata card \u2500
    const cX = 30, cY = 88, cW = 535;
    const cardH = 178 + (invoice.milestone ? 22 : 0) + (invoice.notes ? 22 : 0);
    doc.roundedRect(cX, cY, cW, cardH, 10).fill(white);

    // Date / Due Date (top-left of card)
    doc.fillColor(muted).fontSize(7.5).font("Helvetica-Bold")
       .text("DATE", cX + 18, cY + 16, { lineBreak: false });
    doc.fillColor(dark).fontSize(9.5).font("Helvetica")
       .text(fmtDate(invoice.issueDate), cX + 18, cY + 27, { lineBreak: false });
    doc.fillColor(muted).fontSize(7.5).font("Helvetica-Bold")
       .text("DUE DATE", cX + 18, cY + 50, { lineBreak: false });
    doc.fillColor(dark).fontSize(9.5).font("Helvetica")
       .text(fmtDate(invoice.dueDate), cX + 18, cY + 61, { lineBreak: false });

    // Invoice number + Total Amount boxes (top-right of card)
    const bx = cX + cW - 198;
    doc.roundedRect(bx, cY + 10, 188, 27, 5).fill(lightBx);
    doc.fillColor(muted).fontSize(7).font("Helvetica-Bold")
       .text("INVOICE NUMBER", bx + 8, cY + 14, { lineBreak: false });
    doc.fillColor(dark).fontSize(9.5).font("Helvetica-Bold")
       .text(invoice.invoiceNumber, bx + 8, cY + 24, { lineBreak: false });

    doc.roundedRect(bx, cY + 45, 188, 38, 5).fill(teal);
    doc.fillColor(white).fontSize(7.5).font("Helvetica")
       .text("TOTAL AMOUNT", bx, cY + 50, { width: 188, align: "center", lineBreak: false });
    doc.fontSize(15).font("Helvetica-Bold")
       .text(fmtAmt(invoice.total), bx, cY + 63, { width: 188, align: "center", lineBreak: false });

    // Divider
    doc.moveTo(cX + 15, cY + 92).lineTo(cX + cW - 15, cY + 92)
       .strokeColor("#E2E8F0").lineWidth(0.5).stroke();

    // "Invoice To:" pill + client info
    doc.roundedRect(cX + 18, cY + 100, 72, 16, 8).fill(teal);
    doc.fillColor(white).fontSize(7.5).font("Helvetica-Bold")
       .text("Invoice To:", cX + 23, cY + 104, { lineBreak: false });

    doc.fillColor(dark).fontSize(12).font("Helvetica-Bold")
       .text(invoice.client.companyName, cX + 18, cY + 121, { lineBreak: false });
    let cInfoY = cY + 138;
    if (invoice.client.contactPerson) {
      doc.fillColor(muted).fontSize(8.5).font("Helvetica")
         .text(invoice.client.contactPerson, cX + 18, cInfoY, { lineBreak: false });
      cInfoY += 13;
    }
    if (invoice.client.email) {
      doc.fillColor(muted).fontSize(8.5)
         .text(invoice.client.email, cX + 18, cInfoY, { lineBreak: false });
      cInfoY += 13;
    }
    if (invoice.client.gstNumber) {
      doc.fillColor(muted).fontSize(7.5)
         .text(`GSTIN: ${invoice.client.gstNumber}`, cX + 18, cInfoY, { lineBreak: false });
    }

    // Milestone / Notes (right side, below the boxes)
    let noteY = cY + 100;
    if (invoice.milestone) {
      doc.fillColor(muted).fontSize(7).font("Helvetica-Bold")
         .text("MILESTONE", bx, noteY, { lineBreak: false }); noteY += 12;
      doc.fillColor(dark).fontSize(8.5).font("Helvetica")
         .text(invoice.milestone, bx, noteY, { width: 188 }); noteY += 26;
    }
    if (invoice.notes) {
      doc.fillColor(muted).fontSize(7).font("Helvetica-Bold")
         .text("NOTES", bx, noteY, { lineBreak: false }); noteY += 12;
      doc.fillColor(dark).fontSize(8.5).font("Helvetica")
         .text(invoice.notes, bx, noteY, { width: 188 });
    }

    // \u2500 Two-column section \u2500
    const colY = cY + cardH + 12;
    const colH = 800 - colY;
    const leftW = 120;
    const rightX = cX + leftW + 14;
    const rightW = cW - leftW - 14;

    // Left teal column
    doc.roundedRect(cX, colY, leftW, colH, 8).fill(teal);

    // "Thank You!" rotated -90\u00B0
    const tyAreaH = colH - 150;
    doc.save();
    doc.translate(cX + leftW / 2, colY + tyAreaH / 2);
    doc.rotate(-90);
    doc.fillColor(white).fontSize(20).font("Helvetica-Bold")
       .text("Thank You!", -60, -10, { width: 120, align: "center", lineBreak: false });
    doc.restore();

    // Company email
    if (company.email) {
      doc.fillColor(white).fontSize(5.5).font("Helvetica")
         .text(company.email, cX + 4, colY + tyAreaH + 6, { width: leftW - 8, align: "center", lineBreak: false });
    }

    // White T&C box at the bottom of left column
    const tcBoxY = colY + colH - 140;
    doc.roundedRect(cX + 6, tcBoxY, leftW - 12, 132, 5).fill(white);
    doc.fillColor(teal).fontSize(6.5).font("Helvetica-Bold")
       .text("T&C", cX + 11, tcBoxY + 6, { lineBreak: false });
    const shortTerms = [
      "1. Payment due within the specified period.",
      "2. Late payments: 2% penalty/month.",
      "3. Disputes within 7 days of receipt.",
      "4. Services non-refundable unless agreed.",
      "5. Subject to applicable taxes.",
      "6. Bank charges borne by client.",
    ].join("\n");
    doc.fillColor(muted).fontSize(5).font("Helvetica")
       .text(shortTerms, cX + 11, tcBoxY + 17, { width: leftW - 22 });

    // Right column: white background + table
    doc.roundedRect(rightX, colY, rightW, colH, 8).fill(white);

    const tX = rightX + 5;
    const tW = rightW - 10;
    let tblY = colY + 8;

    const d1 = tW * 0.44;
    const d2 = tW * 0.20;
    const d3 = tW * 0.15;
    const d4 = tW - d1 - d2 - d3;

    // Table header (teal)
    doc.roundedRect(tX, tblY, tW, 22, 3).fill(teal);
    doc.fillColor(white).fontSize(7.5).font("Helvetica-Bold");
    doc.text("ITEM DESCRIPTION", tX + 5, tblY + 7, { width: d1 - 5, lineBreak: false });
    doc.text("RATE",     tX + d1,           tblY + 7, { width: d2,      align: "right", lineBreak: false });
    doc.text("UNIT",     tX + d1 + d2,      tblY + 7, { width: d3,      align: "right", lineBreak: false });
    doc.text("SUBTOTAL", tX + d1 + d2 + d3, tblY + 7, { width: d4 - 5, align: "right", lineBreak: false });
    tblY += 22;

    invoice.lineItems.forEach((item, i) => {
      if (i % 2 === 1) doc.rect(tX, tblY, tW, 20).fill(altRow);
      doc.fillColor(dark).fontSize(8).font("Helvetica");
      doc.text(item.description,          tX + 5,           tblY + 6, { width: d1 - 5, lineBreak: false });
      doc.text(fmtAmt(item.unitPrice),    tX + d1,          tblY + 6, { width: d2,      align: "right", lineBreak: false });
      doc.text(String(item.quantity),     tX + d1 + d2,     tblY + 6, { width: d3,      align: "right", lineBreak: false });
      doc.text(fmtAmt(item.amount),       tX + d1 + d2 + d3, tblY + 6, { width: d4 - 5, align: "right", lineBreak: false });
      tblY += 20;
    });

    doc.moveTo(tX, tblY + 4).lineTo(tX + tW, tblY + 4)
       .strokeColor("#CBD5E1").lineWidth(0.5).stroke();
    tblY += 14;

    doc.fillColor(muted).fontSize(8).font("Helvetica");
    doc.text("Subtotal:",             tX + d1,           tblY, { width: d2 + d3, align: "right", lineBreak: false });
    doc.text(fmtAmt(invoice.subtotal), tX + d1 + d2 + d3, tblY, { width: d4 - 5, align: "right", lineBreak: false });
    tblY += 16;

    if (invoice.gstRate > 0) {
      doc.text(`GST (${invoice.gstRate}%):`,    tX + d1,           tblY, { width: d2 + d3, align: "right", lineBreak: false });
      doc.text(fmtAmt(invoice.gstAmount), tX + d1 + d2 + d3, tblY, { width: d4 - 5, align: "right", lineBreak: false });
      tblY += 16;
    }

    tblY += 6;
    doc.roundedRect(tX, tblY, tW, 26, 3).fill(teal);
    doc.fillColor(white).fontSize(10).font("Helvetica-Bold");
    doc.text("TOTAL:",              tX + d1,           tblY + 8, { width: d2 + d3, align: "right", lineBreak: false });
    doc.text(fmtAmt(invoice.total), tX + d1 + d2 + d3, tblY + 8, { width: d4 - 5, align: "right", lineBreak: false });

    // \u2500 Footer \u2500
    doc.fillColor(muted).fontSize(7).font("Helvetica")
       .text(
         "This is a computer-generated invoice and does not require a physical signature.",
         30, 820, { width: 535, align: "center", lineBreak: false }
       );

    doc.end();
    stream.on("finish", () => resolve(relativePath));
    stream.on("error", reject);
  });
}

async function sendInvoiceEmail(to: string, clientName: string, invoiceNumber: string, total: number, dueDate: string, pdfPath: string) {
  if (!process.env["SMTP_HOST"]) return;
  const transporter = nodemailer.createTransport({
    host: process.env["SMTP_HOST"],
    port: parseInt(process.env["SMTP_PORT"] || "587", 10),
    secure: process.env["SMTP_SECURE"] === "true",
    auth: { user: process.env["SMTP_USER"], pass: process.env["SMTP_PASS"] },
  });
  await transporter.sendMail({
    from: `"Agency OS" <${process.env["SMTP_FROM"] || process.env["SMTP_USER"]}>`,
    to, subject: `Invoice ${invoiceNumber} \u2014 \u20B9${total.toFixed(2)} due by ${new Date(dueDate).toLocaleDateString("en-IN")}`,
    html: `<p>Dear ${clientName},</p><p>Please find attached invoice <strong>${invoiceNumber}</strong> for <strong>\u20B9${total.toFixed(2)}</strong>.</p><p>Payment is due by <strong>${new Date(dueDate).toLocaleDateString("en-IN")}</strong>.</p><p>Regards,<br/>Agency OS Team</p>`,
    attachments: [{ filename: `${invoiceNumber.replace(/\//g, "-")}.pdf`, path: path.join(process.cwd(), pdfPath) }],
  });
}

async function nextInvoiceNumber(year: number, month: number): Promise<string> {
  const prefix = `INV/${year}/${String(month).padStart(2, "0")}/`;
  const rows = await q<RowDataPacket>("SELECT invoice_number AS invoiceNumber FROM invoices WHERE invoice_number LIKE ? ORDER BY invoice_number DESC LIMIT 1", [`${prefix}%`]);
  const seq = rows[0] ? parseInt(String(rows[0]["invoiceNumber"]).split("/").pop() ?? "0", 10) + 1 : 1;
  return `${prefix}${String(seq).padStart(3, "0")}`;
}

const INV_SEL = `i.id, i.uuid, i.invoice_number AS invoiceNumber, i.client_id AS clientId,
  i.issue_date AS issueDate, i.due_date AS dueDate, i.subtotal, i.gst_rate AS gstRate,
  i.gst_amount AS gstAmount, i.total, i.status, i.paid_at AS paidAt,
  i.pdf_path AS pdfPath, i.notes, i.milestone, i.created_by AS createdBy, i.created_at AS createdAt`;

export async function createInvoice(req: Request, res: Response) {
  try {
    const { clientId, issueDate, dueDate, gstRate = 0, notes, milestone, lineItems: rawItems, sendEmail = false } = req.body as {
      clientId: number; issueDate: string; dueDate: string; gstRate?: number; notes?: string; milestone?: string;
      lineItems: { description: string; quantity: number; unitPrice: number }[]; sendEmail?: boolean;
    };
    if (!clientId || !issueDate || !dueDate || !Array.isArray(rawItems) || rawItems.length === 0) {
      return res.status(400).json({ success: false, message: "clientId, issueDate, dueDate and at least one line item are required" });
    }
    const clientRows = await q<RowDataPacket>("SELECT id, company_name AS companyName, contact_person AS contactPerson, email, address, gst_number AS gstNumber FROM clients WHERE id = ?", [Number(clientId)]);
    if (!clientRows[0]) return res.status(404).json({ success: false, message: "Client not found" });
    const client = clientRows[0];

    const issue = new Date(issueDate);
    const invNumber = await nextInvoiceNumber(issue.getFullYear(), issue.getMonth() + 1);
    const items = rawItems.map(i => ({ description: i.description, quantity: Number(i.quantity), unitPrice: Number(i.unitPrice), amount: Number(i.quantity) * Number(i.unitPrice) }));
    const subtotal = items.reduce((s, i) => s + i.amount, 0);
    const gstAmt   = subtotal * (Number(gstRate) / 100);
    const total    = subtotal + gstAmt;

    const conn = await pool.getConnection();
    let invoiceId: number;
    try {
      await conn.beginTransaction();
      const [iRes] = await conn.execute(
        "INSERT INTO invoices (invoice_number, client_id, issue_date, due_date, subtotal, gst_rate, gst_amount, total, status, notes, milestone, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?)",
        [invNumber, Number(clientId), issueDate, dueDate, subtotal, Number(gstRate), gstAmt, total, notes ?? null, milestone ?? null, req.user!.id]
      );
      invoiceId = (iRes as unknown as { insertId: number }).insertId;
      for (const item of items) {
        await conn.execute("INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount) VALUES (?, ?, ?, ?, ?)", [invoiceId, item.description, item.quantity, item.unitPrice, item.amount]);
      }
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }

    await logActivity(req.user!.id, "CREATE", "INVOICE", invoiceId, undefined, { invoiceNumber: invNumber, total }, req.ip);

    if (sendEmail && client["email"]) {
      const lineItems = items;
      const pdfPath = await generateInvoicePdf({
        id: invoiceId, invoiceNumber: invNumber, issueDate, dueDate,
        subtotal, gstRate: Number(gstRate), gstAmount: gstAmt, total, notes: notes ?? null,
        milestone: milestone ?? null,
        client: { companyName: String(client["companyName"]), contactPerson: String(client["contactPerson"]), email: String(client["email"]), address: client["address"] as string | null, gstNumber: client["gstNumber"] as string | null },
        lineItems,
      });
      await run("UPDATE invoices SET pdf_path = ?, status = 'SENT' WHERE id = ?", [pdfPath, invoiceId]);
      await sendInvoiceEmail(String(client["email"]), String(client["companyName"]), invNumber, total, dueDate, pdfPath).catch(() => {});
      return res.status(201).json({ success: true, data: { id: invoiceId, invoiceNumber: invNumber, status: "SENT", pdfPath }, message: "Invoice created and sent" });
    }

    const invRows = await q<RowDataPacket>(`SELECT ${INV_SEL} FROM invoices i WHERE i.id = ?`, [invoiceId]);
    res.status(201).json({ success: true, data: invRows[0], message: "Invoice created" });
  } catch (err) {
    console.error("[invoices/create]", err);
    res.status(500).json({ success: false, message: "Failed to create invoice" });
  }
}

export async function listInvoices(req: Request, res: Response) {
  try {
    const { clientId, status, month, year, page = "1", limit = "20" } = req.query as Record<string, string>;
    let sql = `SELECT ${INV_SEL}, c.uuid AS clUuid, c.company_name AS companyName, c.email AS clEmail,
               (SELECT COUNT(*) FROM invoice_items ii WHERE ii.invoice_id = i.id) AS itemCount
               FROM invoices i JOIN clients c ON i.client_id = c.id WHERE 1=1`;
    const p: unknown[] = [];
    if (clientId) { sql += " AND i.client_id = ?"; p.push(Number(clientId)); }
    if (status)   { sql += " AND i.status = ?";    p.push(status); }
    if (year && month) { sql += " AND i.issue_date >= ? AND i.issue_date < ?"; p.push(`${year}-${String(month).padStart(2,"0")}-01`, `${year}-${String(Number(month)+1).padStart(2,"0")}-01`); }
    else if (year)     { sql += " AND i.issue_date >= ? AND i.issue_date < ?"; p.push(`${year}-01-01`, `${Number(year)+1}-01-01`); }
    sql += " ORDER BY i.issue_date DESC";
    const countSql = sql.replace(/SELECT.*?FROM invoices/s, "SELECT COUNT(*) AS cnt FROM invoices");
    const allRows = await q<RowDataPacket>(countSql, p as string[]);
    const total = Number(allRows[0]?.["cnt"] ?? 0);
    const skip = (Number(page) - 1) * Number(limit);
    sql += ` LIMIT ${Number(limit)} OFFSET ${skip}`;
    const rows = await q<RowDataPacket>(sql, p as string[]);
    const invoices = rows.map(r => ({ ...r, client: { id: r["clientId"], uuid: r["clUuid"], companyName: r["companyName"], email: r["clEmail"] }, _count: { lineItems: r["itemCount"] } }));
    res.json({ success: true, data: { invoices, total, page: Number(page), limit: Number(limit) }, message: "OK" });
  } catch (err) {
    console.error("[invoices/list]", err);
    res.status(500).json({ success: false, message: "Failed to fetch invoices" });
  }
}

function invoiceWhere(param: string): { clause: string; val: string | number } {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(param)
    ? { clause: "i.uuid = ?", val: param }
    : { clause: "i.id = ?",   val: Number(param) };
}

export async function getInvoice(req: Request, res: Response) {
  try {
    const { clause, val } = invoiceWhere(String(req.params["id"]));
    const rows = await q<RowDataPacket>(`SELECT ${INV_SEL}, c.company_name AS companyName, c.contact_person AS contactPerson, c.email AS clEmail, c.address, c.gst_number AS gstNumber FROM invoices i JOIN clients c ON i.client_id = c.id WHERE ${clause}`, [val]);
    if (!rows[0]) return res.status(404).json({ success: false, message: "Invoice not found" });
    const id = Number(rows[0]["id"]);
    const items = await q<RowDataPacket>("SELECT id, description, quantity, unit_price AS unitPrice, amount FROM invoice_items WHERE invoice_id = ?", [id]);
    const r = rows[0];
    res.json({ success: true, data: { ...r, client: { id: r["clientId"], companyName: r["companyName"], contactPerson: r["contactPerson"], email: r["clEmail"], address: r["address"], gstNumber: r["gstNumber"] }, lineItems: items }, message: "OK" });
  } catch (err) {
    console.error("[invoices/get]", err);
    res.status(500).json({ success: false, message: "Failed to fetch invoice" });
  }
}

export async function updateInvoice(req: Request, res: Response) {
  try {
    const { clause: wClause, val: wVal } = invoiceWhere(String(req.params["id"]));
    const rows = await q<RowDataPacket>(`SELECT id, status, gst_rate AS gstRate FROM invoices i WHERE ${wClause}`, [wVal]);
    if (!rows[0]) return res.status(404).json({ success: false, message: "Invoice not found" });
    if (rows[0]["status"] !== "DRAFT") return res.status(409).json({ success: false, message: "Only DRAFT invoices can be edited" });
    const id = Number(rows[0]["id"]);

    const { issueDate, dueDate, gstRate, notes, milestone, lineItems: rawItems } = req.body as { issueDate?: string; dueDate?: string; gstRate?: number; notes?: string; milestone?: string; lineItems?: { description: string; quantity: number; unitPrice: number }[] };

    if (rawItems && Array.isArray(rawItems)) {
      const items = rawItems.map(i => ({ description: i.description, quantity: Number(i.quantity), unitPrice: Number(i.unitPrice), amount: Number(i.quantity) * Number(i.unitPrice) }));
      const subtotal = items.reduce((s, i) => s + i.amount, 0);
      const rate = gstRate != null ? Number(gstRate) : Number(rows[0]["gstRate"]);
      const gst  = subtotal * (rate / 100);
      await run("DELETE FROM invoice_items WHERE invoice_id = ?", [id]);
      const sets: string[] = ["subtotal = ?", "gst_amount = ?", "total = ?"];
      const p: unknown[] = [subtotal, gst, subtotal + gst];
      if (issueDate) { sets.push("issue_date = ?"); p.push(issueDate); }
      if (dueDate)   { sets.push("due_date = ?");   p.push(dueDate); }
      if (gstRate != null) { sets.push("gst_rate = ?"); p.push(Number(gstRate)); }
      if (notes != null)     { sets.push("notes = ?");     p.push(notes); }
      if (milestone != null) { sets.push("milestone = ?"); p.push(milestone); }
      p.push(id);
      await run(`UPDATE invoices SET ${sets.join(", ")} WHERE id = ?`, p as string[]);
      for (const item of items) {
        await run("INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount) VALUES (?, ?, ?, ?, ?)", [id, item.description, item.quantity, item.unitPrice, item.amount]);
      }
    } else {
      const sets: string[] = [];
      const p: unknown[] = [];
      if (issueDate) { sets.push("issue_date = ?"); p.push(issueDate); }
      if (dueDate)   { sets.push("due_date = ?");   p.push(dueDate); }
      if (gstRate != null) { sets.push("gst_rate = ?"); p.push(Number(gstRate)); }
      if (notes != null)     { sets.push("notes = ?");     p.push(notes); }
      if (milestone != null) { sets.push("milestone = ?"); p.push(milestone); }
      if (sets.length > 0) { p.push(id); await run(`UPDATE invoices SET ${sets.join(", ")} WHERE id = ?`, p as string[]); }
    }

    await logActivity(req.user!.id, "UPDATE", "INVOICE", id, rows[0], undefined, req.ip);
    const updRows = await q<RowDataPacket>(`SELECT ${INV_SEL} FROM invoices i WHERE i.id = ?`, [id]);
    res.json({ success: true, data: updRows[0], message: "Invoice updated" });
  } catch (err) {
    console.error("[invoices/update]", err);
    res.status(500).json({ success: false, message: "Failed to update invoice" });
  }
}

export async function sendInvoice(req: Request, res: Response) {
  try {
    const { clause, val } = invoiceWhere(String(req.params["id"]));
    const rows = await q<RowDataPacket>(`SELECT ${INV_SEL}, c.company_name AS companyName, c.contact_person AS contactPerson, c.email AS clEmail, c.address, c.gst_number AS gstNumber FROM invoices i JOIN clients c ON i.client_id = c.id WHERE ${clause}`, [val]);
    const id = rows[0] ? Number(rows[0]["id"]) : NaN;
    if (!rows[0]) return res.status(404).json({ success: false, message: "Invoice not found" });
    const items = await q<RowDataPacket>("SELECT description, quantity, unit_price AS unitPrice, amount FROM invoice_items WHERE invoice_id = ?", [id]);
    const r = rows[0];

    const pdfPath = await generateInvoicePdf({
      id, invoiceNumber: String(r["invoiceNumber"]), issueDate: r["issueDate"] as string,
      dueDate: r["dueDate"] as string, subtotal: Number(r["subtotal"]),
      gstRate: Number(r["gstRate"]), gstAmount: Number(r["gstAmount"]), total: Number(r["total"]),
      notes: r["notes"] as string | null,
      milestone: r["milestone"] as string | null,
      client: { companyName: String(r["companyName"]), contactPerson: String(r["contactPerson"]), email: r["clEmail"] as string | null, address: r["address"] as string | null, gstNumber: r["gstNumber"] as string | null },
      lineItems: items.map(i => ({ description: String(i["description"]), quantity: Number(i["quantity"]), unitPrice: Number(i["unitPrice"]), amount: Number(i["amount"]) })),
    });

    await run("UPDATE invoices SET pdf_path = ?, status = 'SENT' WHERE id = ?", [pdfPath, id]);
    if (r["clEmail"]) {
      await sendInvoiceEmail(String(r["clEmail"]), String(r["companyName"]), String(r["invoiceNumber"]), Number(r["total"]), String(r["dueDate"]), pdfPath).catch(e => console.error("[invoices/email]", e));
    }
    await logActivity(req.user!.id, "UPDATE", "INVOICE", id, { status: r["status"] }, { status: "SENT" }, req.ip);
    res.json({ success: true, data: { pdfPath }, message: "Invoice sent" });
  } catch (err) {
    console.error("[invoices/send]", err);
    res.status(500).json({ success: false, message: "Failed to send invoice" });
  }
}

export async function markInvoicePaid(req: Request, res: Response) {
  try {
    const { clause, val } = invoiceWhere(String(req.params["id"]));
    const rows = await q<RowDataPacket>(`SELECT id, status FROM invoices i WHERE ${clause}`, [val]);
    const id = rows[0] ? Number(rows[0]["id"]) : NaN;
    if (!rows[0]) return res.status(404).json({ success: false, message: "Invoice not found" });
    if (rows[0]["status"] === "PAID") return res.status(409).json({ success: false, message: "Already paid" });
    await run("UPDATE invoices SET status = 'PAID', paid_at = NOW() WHERE id = ?", [id]);
    await logActivity(req.user!.id, "UPDATE", "INVOICE", id, { status: rows[0]["status"] }, { status: "PAID" }, req.ip);
    const updRows = await q<RowDataPacket>(`SELECT ${INV_SEL} FROM invoices i WHERE i.id = ?`, [id]);
    res.json({ success: true, data: updRows[0], message: "Invoice marked as paid" });
  } catch (err) {
    console.error("[invoices/mark-paid]", err);
    res.status(500).json({ success: false, message: "Failed to mark invoice as paid" });
  }
}

export async function deleteInvoice(req: Request, res: Response) {
  try {
    const id = Number(req.params["id"]);
    const rows = await q<RowDataPacket>("SELECT id, status FROM invoices WHERE id = ?", [id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: "Invoice not found" });
    if (rows[0]["status"] !== "DRAFT") return res.status(409).json({ success: false, message: "Only DRAFT invoices can be deleted" });
    await run("DELETE FROM invoice_items WHERE invoice_id = ?", [id]);
    await run("DELETE FROM invoices WHERE id = ?", [id]);
    await logActivity(req.user!.id, "DELETE", "INVOICE", id, rows[0], undefined, req.ip);
    res.json({ success: true, data: null, message: "Invoice deleted" });
  } catch (err) {
    console.error("[invoices/delete]", err);
    res.status(500).json({ success: false, message: "Failed to delete invoice" });
  }
}

export async function downloadInvoicePdf(req: Request, res: Response) {
  try {
    const { clause, val } = invoiceWhere(String(req.params["id"]));
    const rows = await q<RowDataPacket>(`SELECT ${INV_SEL}, c.company_name AS companyName, c.contact_person AS contactPerson, c.email AS clEmail, c.address, c.gst_number AS gstNumber FROM invoices i JOIN clients c ON i.client_id = c.id WHERE ${clause}`, [val]);
    const id = rows[0] ? Number(rows[0]["id"]) : NaN;
    if (!rows[0]) return res.status(404).json({ success: false, message: "Invoice not found" });
    const r = rows[0];
    const items = await q<RowDataPacket>("SELECT description, quantity, unit_price AS unitPrice, amount FROM invoice_items WHERE invoice_id = ?", [id]);
    const pdfPath = await generateInvoicePdf({
      id, invoiceNumber: String(r["invoiceNumber"]), issueDate: r["issueDate"] as string,
      dueDate: r["dueDate"] as string, subtotal: Number(r["subtotal"]),
      gstRate: Number(r["gstRate"]), gstAmount: Number(r["gstAmount"]), total: Number(r["total"]),
      notes: r["notes"] as string | null,
      milestone: r["milestone"] as string | null,
      client: { companyName: String(r["companyName"]), contactPerson: String(r["contactPerson"]), email: r["clEmail"] as string | null, address: r["address"] as string | null, gstNumber: r["gstNumber"] as string | null },
      lineItems: items.map(i => ({ description: String(i["description"]), quantity: Number(i["quantity"]), unitPrice: Number(i["unitPrice"]), amount: Number(i["amount"]) })),
    });
    await run("UPDATE invoices SET pdf_path = ? WHERE id = ?", [pdfPath, id]);

    const absPath = path.join(process.cwd(), pdfPath!);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${String(r["invoiceNumber"]).replace(/\//g, "-")}.pdf"`);
    fs.createReadStream(absPath).pipe(res);
  } catch (err) {
    console.error("[invoices/download]", err);
    res.status(500).json({ success: false, message: "Failed to download invoice" });
  }
}

export async function getInvoiceStats(_req: Request, res: Response) {
  try {
    const now = new Date().toISOString().split("T")[0];
    const [totals, overdue, collected] = await Promise.all([
      q<RowDataPacket>("SELECT status, COUNT(*) AS cnt FROM invoices GROUP BY status"),
      q<RowDataPacket>("SELECT COUNT(*) AS cnt FROM invoices WHERE status = 'SENT' AND due_date < ?", [now]),
      q<RowDataPacket>("SELECT COALESCE(SUM(total), 0) AS total FROM invoices WHERE status = 'PAID'"),
    ]);
    const byStatus: Record<string, number> = {};
    totals.forEach(r => { byStatus[String(r["status"])] = Number(r["cnt"]); });
    res.json({
      success: true, message: "OK",
      data: {
        total:  totals.reduce((s, r) => s + Number(r["cnt"]), 0),
        draft:  byStatus["DRAFT"]  ?? 0,
        sent:   byStatus["SENT"]   ?? 0,
        paid:   byStatus["PAID"]   ?? 0,
        overdue: Number(overdue[0]?.["cnt"] ?? 0),
        totalCollected: Number(collected[0]?.["total"] ?? 0),
      },
    });
  } catch (err) {
    console.error("[invoices/stats]", err);
    res.status(500).json({ success: false, message: "Failed to fetch stats" });
  }
}

// Returns the remaining balance (totalContractValue - total invoiced so far) for a client
export async function getClientInvoiceBalance(req: Request, res: Response) {
  try {
    const { clientId } = req.params as Record<string, string>;
    const clientRows = await q<RowDataPacket>(
      "SELECT id, total_contract_value AS totalContractValue FROM clients WHERE id = ?",
      [Number(clientId)]
    );
    if (!clientRows[0]) return res.status(404).json({ success: false, message: "Client not found" });
    const totalContractValue = clientRows[0]["totalContractValue"] != null ? Number(clientRows[0]["totalContractValue"]) : null;

    const [invoicedRow, paidRow] = await Promise.all([
      q<RowDataPacket>(
        "SELECT COALESCE(SUM(total), 0) AS v FROM invoices WHERE client_id = ? AND status != 'CANCELLED'",
        [Number(clientId)]
      ),
      q<RowDataPacket>(
        "SELECT COALESCE(SUM(total), 0) AS v FROM invoices WHERE client_id = ? AND status = 'PAID'",
        [Number(clientId)]
      ),
    ]);

    const totalInvoiced    = Number(invoicedRow[0]?.["v"] ?? 0);
    const totalPaid        = Number(paidRow[0]?.["v"] ?? 0);
    const totalOutstanding = totalContractValue != null
      ? totalContractValue - totalPaid
      : totalInvoiced - totalPaid;
    const balance          = totalContractValue != null ? totalContractValue - totalInvoiced : null;

    res.json({ success: true, message: "OK", data: { totalContractValue, totalInvoiced, totalPaid, totalOutstanding, balance } });
  } catch (err) {
    console.error("[invoices/balance]", err);
    res.status(500).json({ success: false, message: "Failed to fetch balance" });
  }
}
