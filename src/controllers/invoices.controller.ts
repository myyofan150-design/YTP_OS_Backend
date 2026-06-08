// src/controllers/invoices.controller.ts
import { Request, Response } from "express";
import https from "https";
import http from "http";
import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";
import { q, run, pool, RowDataPacket } from "../lib/db";
import { logActivity } from "../lib/logger";
import { registerPdfFonts } from "../utils/pdfFont";

// Fetches a remote URL into a Buffer (for embedding images in PDFKit)
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

// ─── PDF Generation ────────────────────────────────────────────────────────


async function getCompanySettings(): Promise<{ name: string; tagline: string; email: string; phone: string | null; address: string | null; logoUrl: string | null; sealUrl: string | null }> {
  try {
    const rows = await q<RowDataPacket>(
      "SELECT `key`, value FROM system_settings WHERE `key` IN ('company_name','company_tagline','company_email','company_logo_url','company_phone','company_address','company_seal_url')"
    );
    const map: Record<string, string | null> = {};
    rows.forEach(r => { map[String(r["key"])] = r["value"] ? String(r["value"]) : null; });
    return {
      name:    map["company_name"]     ?? "Agency OS",
      tagline: map["company_tagline"]  ?? "Digital Marketing Agency",
      email:   map["company_email"]    ?? "contact@agencyos.in",
      phone:   map["company_phone"]    ?? null,
      address: map["company_address"]  ?? null,
      logoUrl: map["company_logo_url"] ?? null,
      sealUrl: map["company_seal_url"] ?? null,
    };
  } catch {
    return { name: "Agency OS", tagline: "Digital Marketing Agency", email: "contact@agencyos.in", phone: null, address: null, logoUrl: null, sealUrl: null };
  }
}

export async function generateInvoicePdf(invoice: {
  id: number; invoiceNumber: string; issueDate: Date | string; dueDate: Date | string;
  subtotal: number; gstRate: number; gstAmount: number; total: number; notes: string | null;
  milestone?: string | null;
  client: { companyName: string; contactPerson: string; email: string | null; address: string | null; gstNumber: string | null };
  lineItems: { description: string; quantity: number; unitPrice: number; amount: number }[];
}): Promise<Buffer> {
  const fileName = `${invoice.invoiceNumber.replace(/\//g, "-")}.pdf`;
  const company  = await getCompanySettings();
  const [logoBuffer, sealBuffer] = await Promise.all([
    company.logoUrl ? fetchUrlBuffer(company.logoUrl) : Promise.resolve(null),
    company.sealUrl ? fetchUrlBuffer(company.sealUrl) : Promise.resolve(null),
  ]);

  const pdfBuffer = await new Promise<Buffer>((resolve, reject) => {
    const doc    = new PDFDocument({ size: "A4", margin: 0 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    registerPdfFonts(doc);

    const teal    = "#2AB5A2";
    const dark    = "#1C1C2E";
    const muted   = "#64748B";
    const white   = "#FFFFFF";
    const lightBg = "#F5F7F8";
    const altRow  = "#F8F9FA";
    const borderC = "#E2E8F0";

    const W = 595, H = 842;
    const ML = 40;
    const CW = W - ML * 2; // 515

    const fmtDate = (d: Date | string) =>
      (d instanceof Date ? d : new Date(String(d)))
        .toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" });
    const fmtAmt = (n: number) => `\u20B9${n.toFixed(2)}`;

    // White background
    doc.rect(0, 0, W, H).fill(white);

    // \u2500\u2500 Header \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    let y = 35;
    if (logoBuffer) {
      try { doc.image(logoBuffer, ML, y, { height: 52, fit: [220, 52] }); }
      catch {
        doc.fillColor(dark).fontSize(14).font("B").text(company.name, ML, y + 3, { width: 220, lineBreak: false });
        if (company.tagline) doc.fillColor(muted).fontSize(9).font("R").text(company.tagline, ML, y + 21, { width: 220, lineBreak: false });
      }
    } else {
      doc.fillColor(dark).fontSize(14).font("B").text(company.name, ML, y + 3, { width: 220, lineBreak: false });
      if (company.tagline) doc.fillColor(muted).fontSize(9).font("R").text(company.tagline, ML, y + 21, { width: 220, lineBreak: false });
    }
    doc.fillColor(teal).fontSize(36).font("B")
       .text("INVOICE.", ML, y + 8, { width: CW, align: "right", lineBreak: false });

    y = 97;

    // \u2500\u2500 Info bar (light gray) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const infoBarH = 95;
    doc.roundedRect(ML, y, CW, infoBarH, 6).fill(lightBg);

    // Invoice To (left)
    const invoiceToW = 175;
    doc.fillColor(muted).fontSize(8).font("R")
       .text("Invoice to :", ML + 14, y + 10, { lineBreak: false });
    doc.fillColor(dark).fontSize(13).font("B")
       .text(invoice.client.companyName, ML + 14, y + 22, { width: invoiceToW, lineBreak: false });
    let ciY = y + 40;
    if (invoice.client.contactPerson) {
      doc.fillColor(muted).fontSize(8.5).font("R")
         .text(invoice.client.contactPerson, ML + 14, ciY, { width: invoiceToW, lineBreak: false });
      ciY += 12;
    }
    if (invoice.client.email) {
      doc.fillColor(muted).fontSize(8).font("R")
         .text(invoice.client.email, ML + 14, ciY, { width: invoiceToW, lineBreak: false });
      ciY += 12;
    }
    if (invoice.client.address) {
      doc.fillColor(muted).fontSize(8).font("R")
         .text(invoice.client.address, ML + 14, ciY, { width: invoiceToW, lineBreak: false });
    }

    // Total Due (center)
    const totalDueX = ML + 195;
    const totalDueW = 145;
    doc.fillColor(muted).fontSize(8).font("R")
       .text("Total Due :", totalDueX, y + 28, { width: totalDueW, align: "center", lineBreak: false });
    doc.fillColor(teal).fontSize(18).font("B")
       .text(fmtAmt(invoice.total), totalDueX, y + 41, { width: totalDueW, align: "center", lineBreak: false });

    // Date + Invoice No (right)
    const dateX = ML + 350;
    const dateW = CW - 350;
    doc.fillColor(muted).fontSize(7.5).font("R")
       .text("Date :", dateX, y + 14, { width: dateW, lineBreak: false });
    doc.fillColor(dark).fontSize(9).font("B")
       .text(fmtDate(invoice.issueDate), dateX, y + 25, { width: dateW, lineBreak: false });
    doc.fillColor(muted).fontSize(7.5).font("R")
       .text("Invoice No :", dateX, y + 46, { width: dateW, lineBreak: false });
    doc.fillColor(dark).fontSize(9).font("B")
       .text(invoice.invoiceNumber, dateX, y + 57, { width: dateW, lineBreak: false });

    y += infoBarH + 14;

    // \u2500\u2500 Items table \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const tX = ML, tW = CW;
    const cItem  = 38;
    const cPrice = 82;
    const cQty   = 54;
    const cAmt   = 82;
    const cDesc  = tW - cItem - cPrice - cQty - cAmt;

    const rowH = 24;
    doc.roundedRect(tX, y, tW, rowH, 3).fill(teal);
    doc.fillColor(white).fontSize(7.5).font("B");
    doc.text("ITEM",         tX + 2,                                y + 8, { width: cItem,     align: "center", lineBreak: false });
    doc.text("DESCRIPTIONS", tX + cItem + 4,                       y + 8, { width: cDesc - 4,                  lineBreak: false });
    doc.text("PRICE",        tX + cItem + cDesc,                    y + 8, { width: cPrice,    align: "right",  lineBreak: false });
    doc.text("QTY",          tX + cItem + cDesc + cPrice,           y + 8, { width: cQty,      align: "right",  lineBreak: false });
    doc.text("AMOUNT",       tX + cItem + cDesc + cPrice + cQty,    y + 8, { width: cAmt - 4,  align: "right",  lineBreak: false });
    y += rowH;

    invoice.lineItems.forEach((item, i) => {
      if (i % 2 === 1) doc.rect(tX, y, tW, rowH).fill(altRow);
      doc.fillColor(muted).fontSize(8.5).font("R")
         .text(String(i + 1), tX + 2, y + 7, { width: cItem, align: "center", lineBreak: false });
      doc.fillColor(dark).fontSize(8.5).font("R")
         .text(item.description,       tX + cItem + 4,                     y + 7, { width: cDesc - 8,  lineBreak: false });
      doc.text(fmtAmt(item.unitPrice), tX + cItem + cDesc,                  y + 7, { width: cPrice,    align: "right", lineBreak: false });
      doc.text(String(item.quantity),  tX + cItem + cDesc + cPrice,         y + 7, { width: cQty,      align: "right", lineBreak: false });
      doc.text(fmtAmt(item.amount),    tX + cItem + cDesc + cPrice + cQty,  y + 7, { width: cAmt - 4,  align: "right", lineBreak: false });
      y += rowH;
    });

    y += 10;

    // \u2500\u2500 Totals \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const totStartX = ML + Math.round(CW * 0.55);
    const totW      = CW - Math.round(CW * 0.55);
    const amtColW   = 80;

    doc.moveTo(totStartX, y).lineTo(ML + CW, y).strokeColor(borderC).lineWidth(0.5).stroke();
    y += 8;

    doc.fillColor(muted).fontSize(9).font("R");
    doc.text("SUB TOTAL",              totStartX + 4, y, { width: totW - amtColW - 4, align: "right", lineBreak: false });
    doc.text(fmtAmt(invoice.subtotal), totStartX + totW - amtColW, y, { width: amtColW - 4, align: "right", lineBreak: false });
    y += 16;

    if (invoice.gstRate > 0) {
      doc.fillColor(muted).fontSize(9).font("R");
      doc.text(`TAX ${invoice.gstRate}%`,  totStartX + 4, y, { width: totW - amtColW - 4, align: "right", lineBreak: false });
      doc.text(fmtAmt(invoice.gstAmount), totStartX + totW - amtColW, y, { width: amtColW - 4, align: "right", lineBreak: false });
      y += 16;
    }

    y += 4;
    doc.roundedRect(totStartX, y, totW, 24, 3).fill(teal);
    doc.fillColor(white).fontSize(10).font("B");
    doc.text("TOTAL",           totStartX + 4, y + 7, { width: totW - amtColW - 4, align: "right", lineBreak: false });
    doc.text(fmtAmt(invoice.total), totStartX + totW - amtColW, y + 7, { width: amtColW - 4, align: "right", lineBreak: false });
    y += 34;

    // Milestone
    if (invoice.milestone) {
      doc.fillColor(muted).fontSize(7.5).font("B").text("MILESTONE:", ML, y, { lineBreak: false });
      y += 12;
      doc.fillColor(dark).fontSize(9).font("R").text(invoice.milestone, ML, y, { width: CW * 0.55 });
      y += 20;
    }

    y += 8;

    // \u2500\u2500 Terms & Conditions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    doc.moveTo(ML, y).lineTo(ML + CW, y).strokeColor(borderC).lineWidth(0.5).stroke();
    y += 12;

    doc.fillColor(dark).fontSize(11).font("B").text("Terms & Conditions", ML, y, { lineBreak: false });
    y += 18;

    const terms = [
      "Payment is due within the agreed payment period from the date of invoice issuance.",
      "A late payment charge of 2% per month may be applied to outstanding balances beyond the due date.",
      "Any disputes regarding the invoice must be raised in writing within 7 days of receipt.",
      "All services rendered are non-refundable unless otherwise agreed upon in writing by both parties.",
      "Applicable taxes, duties, or government levies will be charged as per prevailing regulations.",
      "Any bank transfer fees, transaction charges, or intermediary banking costs shall be borne by the client.",
    ];

    // Seal (right side)
    const sealSize = 84;
    const sealX = ML + CW - sealSize;
    const sealY2 = y;
    if (sealBuffer) {
      try { doc.image(sealBuffer, sealX, sealY2, { fit: [sealSize, sealSize] }); }
      catch { /* skip seal */ }
    } else if (logoBuffer) {
      // Fallback: draw double rings with logo inside
      const sealCX = sealX + sealSize / 2;
      const sealCY = sealY2 + sealSize / 2;
      const sealR  = sealSize / 2;
      doc.circle(sealCX, sealCY, sealR).strokeColor(teal).lineWidth(2).stroke();
      doc.circle(sealCX, sealCY, sealR - 5).strokeColor(teal).lineWidth(0.5).stroke();
      try { doc.image(logoBuffer, sealCX - 22, sealCY - 22, { fit: [44, 44] }); }
      catch { /* skip */ }
    }

    const termsTextW = CW - 105;
    terms.forEach((term, i) => {
      doc.fillColor(muted).fontSize(7.5).font("R")
         .text(`${i + 1}. ${term}`, ML, y, { width: termsTextW, lineBreak: false });
      y += 14;
    });

    // Notes
    if (invoice.notes) {
      y += 8;
      doc.fillColor(muted).fontSize(7.5).font("B").text("Notes:", ML, y, { lineBreak: false });
      y += 12;
      doc.fillColor(muted).fontSize(7.5).font("R").text(invoice.notes, ML, y, { width: CW });
    }

    // \u2500\u2500 Footer bar (teal) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const footerY = H - 85;
    doc.rect(0, footerY, W, 55).fill(teal);

    // Helper: draw a Lucide-style icon scaled into PDF space
    const drawFooterIcon = (type: "pin" | "phone" | "mail", ix: number, iy: number, sz: number) => {
      const sc = sz / 24;
      doc.save();
      doc.translate(ix, iy).scale(sc, sc, { origin: [0, 0] });
      if (type === "pin") {
        doc.path("M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z")
           .fillColor(white).fill();
        doc.circle(12, 10, 3).fillColor(teal).fill();
      } else if (type === "phone") {
        doc.path("M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z")
           .strokeColor(white).lineWidth(2).lineCap("round").lineJoin("round").stroke();
      } else {
        doc.roundedRect(2, 4, 20, 16, 2).strokeColor(white).lineWidth(2).stroke();
        doc.path("M22 7 13.03 12.7a1.94 1.94 0 0 1-2.06 0L2 7")
           .strokeColor(white).lineWidth(2).lineCap("round").stroke();
      }
      doc.restore();
    };

    // Footer uses full page width (teal bar spans 0→W).
    // Left pad = 20, "Thanks" block = 175pt wide, divider at x=195, contacts x=210→575
    const footerPadX = 20;
    const divX       = footerPadX + 175;          // 195
    const contactX0  = divX + 15;                 // 210
    const contactEnd = W - footerPadX;            // 575
    const barCY      = footerY + 27.5;            // vertical centre of the 55pt bar

    // Left text block — two lines centred vertically in bar
    doc.fillColor(white).fontSize(9).font("B")
       .text("Thanks for Business With Us!", footerPadX, footerY + 17, { lineBreak: false });
    doc.fillColor(white).fontSize(7.5).font("R")
       .text("We make easy for your Problems.", footerPadX, footerY + 31, { lineBreak: false });

    // Vertical divider
    doc.save();
    doc.strokeOpacity(0.4)
       .moveTo(divX, footerY + 9).lineTo(divX, footerY + 46)
       .strokeColor(white).lineWidth(1).stroke();
    doc.restore();

    // Contact details — equal slots across contactX0→contactEnd, single line each
    const contacts: Array<{ type: "pin" | "phone" | "mail"; text: string }> = [];
    if (company.address) contacts.push({ type: "pin",   text: company.address });
    if (company.phone)   contacts.push({ type: "phone", text: company.phone   });
    if (company.email)   contacts.push({ type: "mail",  text: company.email   });

    if (contacts.length > 0) {
      const iconSz  = 11;
      const textGap = 5;
      const slotW   = (contactEnd - contactX0) / contacts.length; // ≈ 122pt each
      const iconTop = barCY - iconSz / 2;
      const textY   = barCY - 4;   // 8pt font visual centre

      contacts.forEach((c, i) => {
        // const sx = contactX0 + i * slotW;
        const sx = contactX0 + i * slotW + (i > 0 ? 20 : 0);

        drawFooterIcon(c.type, sx, iconTop, iconSz);
        // No width — lineBreak:false renders the full string on one line
        doc.fillColor(white).fontSize(8).font("R")
           .text(c.text, sx + iconSz + textGap, textY, { lineBreak: false });
      });
    }

    // \u2500\u2500 Bottom note \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    doc.fillColor(muted).fontSize(7.5).font("R")
       .text(
         "This is a computer-generated invoice and does not require a physical signature.",
         ML, H - 20, { width: CW, align: "center", lineBreak: false }
       );

    doc.end();
  });

  return pdfBuffer;
}

async function sendInvoiceEmail(to: string, clientName: string, invoiceNumber: string, total: number, dueDate: string, pdfBuffer: Buffer) {
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
    attachments: [{ filename: `${invoiceNumber.replace(/\//g, "-")}.pdf`, content: pdfBuffer, contentType: "application/pdf" }],
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

    const pdfBuffer = await generateInvoicePdf({
      id, invoiceNumber: String(r["invoiceNumber"]), issueDate: r["issueDate"] as string,
      dueDate: r["dueDate"] as string, subtotal: Number(r["subtotal"]),
      gstRate: Number(r["gstRate"]), gstAmount: Number(r["gstAmount"]), total: Number(r["total"]),
      notes: r["notes"] as string | null,
      milestone: r["milestone"] as string | null,
      client: { companyName: String(r["companyName"]), contactPerson: String(r["contactPerson"]), email: r["clEmail"] as string | null, address: r["address"] as string | null, gstNumber: r["gstNumber"] as string | null },
      lineItems: items.map(i => ({ description: String(i["description"]), quantity: Number(i["quantity"]), unitPrice: Number(i["unitPrice"]), amount: Number(i["amount"]) })),
    });

    await run("UPDATE invoices SET status = 'SENT' WHERE id = ?", [id]);
    if (r["clEmail"]) {
      await sendInvoiceEmail(String(r["clEmail"]), String(r["companyName"]), String(r["invoiceNumber"]), Number(r["total"]), String(r["dueDate"]), pdfBuffer).catch(e => console.error("[invoices/email]", e));
    }
    await logActivity(req.user!.id, "UPDATE", "INVOICE", id, { status: r["status"] }, { status: "SENT" }, req.ip);
    res.json({ success: true, data: null, message: "Invoice sent" });
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
    const fileName  = `${String(r["invoiceNumber"]).replace(/\//g, "-")}.pdf`;
    const pdfBuffer = await generateInvoicePdf({
      id, invoiceNumber: String(r["invoiceNumber"]), issueDate: r["issueDate"] as string,
      dueDate: r["dueDate"] as string, subtotal: Number(r["subtotal"]),
      gstRate: Number(r["gstRate"]), gstAmount: Number(r["gstAmount"]), total: Number(r["total"]),
      notes: r["notes"] as string | null,
      milestone: r["milestone"] as string | null,
      client: { companyName: String(r["companyName"]), contactPerson: String(r["contactPerson"]), email: r["clEmail"] as string | null, address: r["address"] as string | null, gstNumber: r["gstNumber"] as string | null },
      lineItems: items.map(i => ({ description: String(i["description"]), quantity: Number(i["quantity"]), unitPrice: Number(i["unitPrice"]), amount: Number(i["amount"]) })),
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
    res.setHeader("Content-Length", pdfBuffer.length);
    res.send(pdfBuffer);
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
        "SELECT COALESCE(SUM(subtotal), 0) AS v FROM invoices WHERE client_id = ? AND status != 'CANCELLED'",
        [Number(clientId)]
      ),
      q<RowDataPacket>(
        "SELECT COALESCE(SUM(subtotal), 0) AS v FROM invoices WHERE client_id = ? AND status = 'PAID'",
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
