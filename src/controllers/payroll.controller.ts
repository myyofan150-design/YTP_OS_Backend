// src/controllers/payroll.controller.ts
import { Request, Response } from "express";
import https from "https";
import http from "http";
import fs from "fs";
import PDFDocument from "pdfkit";
import { q, run, RowDataPacket } from "../lib/db";
import { logActivity } from "../lib/logger";

// ─── Helpers ──────────────────────────────────────────────────────────────

function workingDaysInMonth(month: number, year: number): number {
  const days = new Date(year, month, 0).getDate();
  let count = 0;
  for (let d = 1; d <= days; d++) {
    if (new Date(year, month - 1, d).getDay() !== 0) count++;
  }
  return count;
}

function monthDateRange(month: number, year: number) {
  const gte = `${year}-${String(month).padStart(2, "0")}-01`;
  const last = new Date(year, month, 0).getDate();
  const lte  = `${year}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  return { gte, lte };
}

interface PayrollCalc {
  workingDays: number; presentDays: number; leaveDays: number;
  lopDays: number; overtimeMinutes: number; grossSalary: number;
  overtimeAmount: number; netSalary: number;
}

async function calcPayroll(employeeId: number, month: number, year: number, baseSalary: number): Promise<PayrollCalc> {
  const workingDays = workingDaysInMonth(month, year);
  const { gte, lte } = monthDateRange(month, year);

  const logs = await q<RowDataPacket>(
    "SELECT type, overtime_minutes AS overtimeMinutes FROM attendance_logs WHERE employee_id = ? AND date >= ? AND date <= ?",
    [employeeId, gte, lte]
  );
  const presentDays = logs.reduce((s, l) => {
    if (l["type"] === "PRESENT" || l["type"] === "COMP_OFF") return s + 1;
    if (l["type"] === "HALF_DAY") return s + 0.5;
    return s;
  }, 0);
  const overtimeMinutes = logs.reduce((s, l) => s + Number(l["overtimeMinutes"]), 0);

  const leaves = await q<RowDataPacket>(
    "SELECT days FROM leave_requests WHERE employee_id = ? AND status = 'APPROVED' AND from_date <= ? AND to_date >= ?",
    [employeeId, lte, gte]
  );
  const leaveDays = leaves.reduce((s, l) => s + Number(l["days"]), 0);
  const lopDays   = Math.max(0, workingDays - presentDays - leaveDays);

  const perDay      = baseSalary / workingDays;
  const hourlyRate  = baseSalary / (workingDays * 9);
  const grossSalary = perDay * (presentDays + leaveDays);
  const overtimeAmount = (overtimeMinutes / 60) * hourlyRate;
  const netSalary   = grossSalary + overtimeAmount;

  return { workingDays, presentDays, leaveDays, lopDays, overtimeMinutes, grossSalary, overtimeAmount, netSalary };
}

// ─── Company settings + logo fetch (shared with invoices) ──────────────────

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

async function getCompanySettings(): Promise<{ name: string; tagline: string; logoUrl: string | null }> {
  try {
    const rows = await q<RowDataPacket>(
      "SELECT `key`, value FROM system_settings WHERE `key` IN ('company_name','company_tagline','company_logo_url')"
    );
    const map: Record<string, string | null> = {};
    rows.forEach(r => { map[String(r["key"])] = r["value"] ? String(r["value"]) : null; });
    return {
      name:    map["company_name"]    ?? "Agency OS",
      tagline: map["company_tagline"] ?? "",
      logoUrl: map["company_logo_url"] ?? null,
    };
  } catch {
    return { name: "Agency OS", tagline: "", logoUrl: null };
  }
}

// ─── PDF Payslip ───────────────────────────────────────────────────────────

async function generatePayslipPdf(record: {
  id: number; month: number; year: number; status: string;
  baseSalary: number; grossSalary: number; netSalary: number;
  overtimeAmount: number; bonus: number; lateDeduction: number;
  otherDeduction: number; lopDays: number; presentDays: number; workingDays: number;
  leaveDays: number; notes?: string | null;
  employee: { employeeCode: string; department?: string | null; designation?: string | null; user: { name: string; email: string } };
}): Promise<Buffer> {
  const monthName  = new Date(record.year, record.month - 1).toLocaleString("en-US", { month: "long" });
  const company    = await getCompanySettings();
  const logoBuffer = company.logoUrl ? await fetchUrlBuffer(company.logoUrl) : null;
  const fmtINR     = (n: number) => `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

  // Find a system font that supports the ₹ (U+20B9) character.
  // PDFKit's built-in Helvetica uses WinAnsi encoding which lacks ₹.
  const unicodeFontPairs = [
    { r: "C:/Windows/Fonts/arial.ttf",   b: "C:/Windows/Fonts/arialbd.ttf"   },
    { r: "C:/Windows/Fonts/segoeui.ttf", b: "C:/Windows/Fonts/segoeuib.ttf"  },
    { r: "C:/Windows/Fonts/calibri.ttf", b: "C:/Windows/Fonts/calibrib.ttf"  },
    { r: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", b: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" },
    { r: "/usr/share/fonts/TTF/DejaVuSans.ttf",             b: "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf"             },
  ];
  const fontPair = unicodeFontPairs.find(p => fs.existsSync(p.r) && fs.existsSync(p.b)) ?? null;

  return new Promise<Buffer>((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 0, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    let fontR = "Helvetica";
    let fontB = "Helvetica-Bold";
    if (fontPair) {
      doc.registerFont("__R", fontPair.r);
      doc.registerFont("__B", fontPair.b);
      fontR = "__R";
      fontB = "__B";
    }

    const teal   = "#0f766e";
    const tealLt = "#99f6e4";
    const white  = "#ffffff";
    const sl800  = "#1e293b";
    const sl700  = "#334155";
    const sl500  = "#64748b";
    const sl400  = "#94a3b8";
    const sl50   = "#f8fafc";
    const divClr = "#e2e8f0";
    const red    = "#ef4444";
    const L = 40, R = 555, W = 515;

    // ── HEADER ────────────────────────────────────────────────────────────
    doc.rect(0, 0, 595, 92).fill(teal);

    let nameX = L;
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, L, 22, { height: 44, fit: [44, 44] });
        nameX = L + 52;
      } catch { /* skip */ }
    }
    doc.fillColor(white).fontSize(18).font(fontB)
       .text(company.name, nameX, 27, { lineBreak: false, width: 250 });
    if (company.tagline) {
      doc.fillColor(tealLt).fontSize(8.5).font(fontR)
         .text(company.tagline, nameX, 50, { lineBreak: false, width: 250 });
    }

    doc.fillColor(white).fontSize(22).font(fontB)
       .text("PAYSLIP", 300, 21, { width: 255, align: "right", lineBreak: false });
    doc.fillColor(tealLt).fontSize(8.5).font(fontR)
       .text(`${monthName} ${record.year}`, 300, 48, { width: 255, align: "right", lineBreak: false });

    // Status badge — outline pill
    const badgeW = 72, badgeH = 16, badgeX = R - badgeW, badgeY = 65;
    doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 8)
       .strokeColor(tealLt).lineWidth(0.5).stroke();
    doc.fillColor(white).fontSize(7).font(fontB)
       .text(record.status, badgeX, badgeY + 4.5, { width: badgeW, align: "center", lineBreak: false });

    // ── EMPLOYEE / PERIOD ──────────────────────────────────────────────────
    let y = 92;
    const pad = 16;

    doc.fillColor(sl400).fontSize(6.5).font(fontB)
       .text("EMPLOYEE", L, y + pad, { characterSpacing: 0.8, lineBreak: false });
    doc.fillColor(sl800).fontSize(12).font(fontB)
       .text(record.employee.user.name, L, y + pad + 14, { lineBreak: false, width: 240 });
    doc.fillColor(sl500).fontSize(8).font(fontR)
       .text(record.employee.employeeCode, L, y + pad + 30, { lineBreak: false });
    let empEndY = y + pad + 44;
    if (record.employee.designation) {
      doc.fillColor(sl500).fontSize(8.5).font(fontR).text(record.employee.designation, L, empEndY, { lineBreak: false });
      empEndY += 13;
    }
    if (record.employee.department) {
      doc.fillColor(sl400).fontSize(8.5).font(fontR).text(record.employee.department, L, empEndY, { lineBreak: false });
      empEndY += 13;
    }

    doc.fillColor(sl400).fontSize(6.5).font(fontB)
       .text("PERIOD", 310, y + pad, { width: 245, align: "right", characterSpacing: 0.8, lineBreak: false });
    doc.fillColor(sl700).fontSize(11).font(fontB)
       .text(`${monthName} ${record.year}`, 310, y + pad + 14, { width: 245, align: "right", lineBreak: false });
    doc.fillColor(sl500).fontSize(8.5).font(fontR)
       .text(`Base Salary: ${fmtINR(record.baseSalary)}`, 310, y + pad + 30, { width: 245, align: "right", lineBreak: false });

    y = Math.max(empEndY, y + pad + 50) + pad;
    doc.moveTo(L, y).lineTo(R, y).strokeColor(divClr).lineWidth(0.5).stroke();
    y += 1;

    // ── ATTENDANCE SUMMARY ────────────────────────────────────────────────
    doc.fillColor(sl400).fontSize(6.5).font(fontB)
       .text("ATTENDANCE SUMMARY", L, y + pad, { characterSpacing: 0.8, lineBreak: false });

    const boxTop = y + pad + 14;
    const gap    = 11;
    const boxW   = Math.floor((W - 3 * gap) / 4);
    const attBoxes = [
      { label: "Working Days", value: String(record.workingDays),              red: false },
      { label: "Present Days", value: Number(record.presentDays).toFixed(1),  red: false },
      { label: "Leave Days",   value: Number(record.leaveDays).toFixed(1),    red: false },
      { label: "LOP Days",     value: Number(record.lopDays).toFixed(1),      red: Number(record.lopDays) > 0 },
    ];
    attBoxes.forEach((b, i) => {
      const bx = L + i * (boxW + gap);
      doc.roundedRect(bx, boxTop, boxW, 46, 6).fill(sl50);
      doc.fillColor(b.red ? red : sl800).fontSize(16).font(fontB)
         .text(b.value, bx, boxTop + 7, { width: boxW, align: "center", lineBreak: false });
      doc.fillColor(sl400).fontSize(7.5).font(fontR)
         .text(b.label, bx, boxTop + 29, { width: boxW, align: "center", lineBreak: false });
    });

    y = boxTop + 46 + pad;
    doc.moveTo(L, y).lineTo(R, y).strokeColor(divClr).lineWidth(0.5).stroke();
    y += 1;

    // ── EARNINGS & DEDUCTIONS ─────────────────────────────────────────────
    const colMid = L + Math.floor(W / 2) + 12;
    const halfW  = R - colMid;
    const earnW  = colMid - L - 16;

    doc.fillColor(sl400).fontSize(6.5).font(fontB)
       .text("EARNINGS", L, y + pad, { characterSpacing: 0.8, lineBreak: false });
    doc.fillColor(sl400).fontSize(6.5).font(fontB)
       .text("DEDUCTIONS", colMid, y + pad, { characterSpacing: 0.8, lineBreak: false });

    let earnY = y + pad + 14;
    const earnings: [string, number][] = [
      ["Gross Salary", record.grossSalary],
      ...(record.overtimeAmount > 0 ? [["Overtime Pay", record.overtimeAmount] as [string, number]] : []),
      ...(record.bonus > 0         ? [["Bonus",         record.bonus]          as [string, number]] : []),
    ];
    earnings.forEach(([k, v]) => {
      doc.fillColor(sl700).fontSize(9).font(fontR)
         .text(k, L, earnY, { lineBreak: false, width: earnW });
      doc.fillColor(sl700).fontSize(9).font(fontB)
         .text(fmtINR(v), L, earnY, { width: earnW, align: "right", lineBreak: false });
      earnY += 16;
    });

    let dedY = y + pad + 14;
    const deductions: [string, number][] = [
      ...(record.lateDeduction  > 0 ? [["LOP Deduction",   record.lateDeduction]  as [string, number]] : []),
      ...(record.otherDeduction > 0 ? [["Other Deduction", record.otherDeduction] as [string, number]] : []),
    ];
    if (deductions.length === 0) {
      doc.fillColor(sl400).fontSize(9).font(fontR).text("No deductions", colMid, dedY, { lineBreak: false });
      dedY += 16;
    } else {
      deductions.forEach(([k, v]) => {
        doc.fillColor(sl700).fontSize(9).font(fontR)
           .text(k, colMid, dedY, { lineBreak: false, width: halfW - 5 });
        doc.fillColor(red).fontSize(9).font(fontB)
           .text(`-${fmtINR(v)}`, colMid, dedY, { width: halfW, align: "right", lineBreak: false });
        dedY += 16;
      });
    }

    y = Math.max(earnY, dedY) + pad;
    doc.moveTo(L, y).lineTo(R, y).strokeColor(divClr).lineWidth(0.5).stroke();
    y += 1;

    // ── NET SALARY ────────────────────────────────────────────────────────
    const netBarY = y + pad;
    doc.roundedRect(L, netBarY, W, 46, 8).fill(teal);
    doc.fillColor(white).fontSize(12).font(fontB)
       .text("Net Salary", L + 16, netBarY + 15, { lineBreak: false });
    doc.fillColor(white).fontSize(18).font(fontB)
       .text(fmtINR(record.netSalary), L, netBarY + 12, { width: W - 16, align: "right", lineBreak: false });
    y = netBarY + 46;

    // ── NOTES ─────────────────────────────────────────────────────────────
    if (record.notes) {
      y += pad;
      doc.moveTo(L, y).lineTo(R, y).strokeColor(divClr).lineWidth(0.5).stroke();
      y += pad;
      doc.fillColor(sl400).fontSize(6.5).font(fontB)
         .text("NOTES", L, y, { characterSpacing: 0.8, lineBreak: false });
      doc.fillColor(sl700).fontSize(9).font(fontR)
         .text(record.notes, L, y + 14, { width: W });
    }

    // ── FOOTER ────────────────────────────────────────────────────────────
    doc.fillColor(sl400).fontSize(7.5).font(fontR)
       .text("This is a computer-generated payslip. No signature required.", L, 812, { width: W, align: "center", lineBreak: false });

    doc.end();
  });
}

const PAY_SEL = `pr.id, pr.employee_id AS employeeId, pr.month, pr.year,
  pr.base_salary AS baseSalary, pr.working_days AS workingDays,
  pr.present_days AS presentDays, pr.leave_days AS leaveDays, pr.lop_days AS lopDays,
  pr.late_deduction AS lateDeduction, pr.overtime_amount AS overtimeAmount,
  pr.bonus, pr.other_deduction AS otherDeduction,
  pr.gross_salary AS grossSalary, pr.net_salary AS netSalary,
  pr.status, pr.paid_at AS paidAt, pr.payslip_path AS payslipPath,
  pr.notes, pr.generated_by AS generatedBy, pr.created_at AS createdAt`;

// ─── Controllers ──────────────────────────────────────────────────────────

export async function generatePayroll(req: Request, res: Response): Promise<void> {
  try {
    const { employeeId, month, year } = req.body as Record<string, unknown>;
    if (!employeeId || !month || !year) {
      res.status(400).json({ success: false, message: "employeeId, month and year are required" }); return;
    }
    const empId = Number(employeeId), m = Number(month), y = Number(year);

    const existing = await q<RowDataPacket>("SELECT id FROM payroll_records WHERE employee_id = ? AND month = ? AND year = ?", [empId, m, y]);
    if (existing[0]) { res.status(409).json({ success: false, message: "Payroll already generated for this period" }); return; }

    const empRows = await q<RowDataPacket>(
      "SELECT e.id, e.base_salary AS baseSalary, e.employee_code AS employeeCode, u.name, u.email FROM employees e JOIN users u ON e.user_id = u.id WHERE e.id = ?",
      [empId]
    );
    if (!empRows[0]) { res.status(404).json({ success: false, message: "Employee not found" }); return; }

    const baseSalary = Number(empRows[0]["baseSalary"]);
    const calc = await calcPayroll(empId, m, y, baseSalary);

    const result = await run(
      `INSERT INTO payroll_records (employee_id, month, year, base_salary, working_days, present_days, leave_days, lop_days, overtime_amount, gross_salary, net_salary, generated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [empId, m, y, baseSalary, calc.workingDays, calc.presentDays, calc.leaveDays, calc.lopDays, calc.overtimeAmount, calc.grossSalary, calc.netSalary, req.user!.id]
    );
    const rows = await q<RowDataPacket>(`SELECT ${PAY_SEL} FROM payroll_records pr WHERE pr.id = ?`, [result.insertId]);
    await logActivity(req.user!.id, "payroll.generated", "PayrollRecord", result.insertId, undefined, { employeeId: empId, month: m, year: y }, req.ip);
    res.status(201).json({ success: true, message: "Payroll generated", data: rows[0] });
  } catch (err) {
    console.error("[payroll/generate]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function generateBatch(req: Request, res: Response): Promise<void> {
  try {
    const { month, year } = req.body as Record<string, unknown>;
    if (!month || !year) { res.status(400).json({ success: false, message: "month and year are required" }); return; }
    const m = Number(month), y = Number(year);

    const employees = await q<RowDataPacket>("SELECT id, base_salary AS baseSalary, employee_code AS employeeCode FROM employees WHERE status = 'ACTIVE'");
    let generated = 0, skipped = 0;
    const errors: string[] = [];

    for (const emp of employees) {
      const exists = await q<RowDataPacket>("SELECT id FROM payroll_records WHERE employee_id = ? AND month = ? AND year = ?", [emp["id"], m, y]);
      if (exists[0]) { skipped++; continue; }
      try {
        const baseSalary = Number(emp["baseSalary"]);
        const calc = await calcPayroll(Number(emp["id"]), m, y, baseSalary);
        await run(
          "INSERT INTO payroll_records (employee_id, month, year, base_salary, working_days, present_days, leave_days, lop_days, overtime_amount, gross_salary, net_salary, generated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [emp["id"], m, y, baseSalary, calc.workingDays, calc.presentDays, calc.leaveDays, calc.lopDays, calc.overtimeAmount, calc.grossSalary, calc.netSalary, req.user!.id]
        );
        generated++;
      } catch (e) { errors.push(`${emp["employeeCode"]}: ${String(e)}`); }
    }
    await logActivity(req.user!.id, "payroll.batch_generated", "PayrollRecord", 0, undefined, { month: m, year: y, generated, skipped }, req.ip);
    res.json({ success: true, message: "Batch complete", data: { generated, skipped, errors } });
  } catch (err) {
    console.error("[payroll/generate-batch]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function listPayroll(req: Request, res: Response): Promise<void> {
  try {
    const now = new Date();
    const { month, year, status, employeeId } = req.query as Record<string, string | undefined>;
    const m = month ? Number(month) : now.getMonth() + 1;
    const y = year  ? Number(year)  : now.getFullYear();
    const isEmployee = req.user!.role === "EMPLOYEE";

    let empId: number | null = null;
    if (isEmployee) {
      const empRows = await q<RowDataPacket>("SELECT id FROM employees WHERE user_id = ?", [req.user!.id]);
      if (!empRows[0]) { res.json({ success: true, message: "OK", data: [] }); return; }
      empId = Number(empRows[0]["id"]);
    } else if (employeeId) {
      empId = Number(employeeId);
    }

    let sql = `SELECT ${PAY_SEL}, e.employee_code AS empCode, u.name AS uName, u.avatar_url AS uAvatar
               FROM payroll_records pr
               JOIN employees e ON pr.employee_id = e.id
               JOIN users u ON e.user_id = u.id
               WHERE pr.month = ? AND pr.year = ?`;
    const p: unknown[] = [m, y];
    if (status) { sql += " AND pr.status = ?"; p.push(status); }
    if (empId)  { sql += " AND pr.employee_id = ?"; p.push(empId); }
    sql += " ORDER BY u.name ASC";

    const rows = await q<RowDataPacket>(sql, p as string[]);
    const data = rows.map(r => ({
      ...r,
      employee: { employeeCode: r["empCode"], user: { name: r["uName"], avatarUrl: r["uAvatar"] } },
    }));
    res.json({ success: true, message: "OK", data });
  } catch (err) {
    console.error("[payroll/list]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function getPayroll(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"), 10);
    const rows = await q<RowDataPacket>(
      `SELECT ${PAY_SEL}, e.employee_code AS empCode, e.department, e.designation, u.name AS uName, u.email AS uEmail
       FROM payroll_records pr JOIN employees e ON pr.employee_id = e.id JOIN users u ON e.user_id = u.id WHERE pr.id = ?`,
      [id]
    );
    if (!rows[0]) { res.status(404).json({ success: false, message: "Payroll record not found" }); return; }

    if (req.user!.role === "EMPLOYEE") {
      const empRows = await q<RowDataPacket>("SELECT id FROM employees WHERE user_id = ?", [req.user!.id]);
      if (!empRows[0] || Number(empRows[0]["id"]) !== Number(rows[0]["employeeId"])) {
        res.status(403).json({ success: false, message: "Access denied" }); return;
      }
    }

    const r = rows[0];
    res.json({ success: true, message: "OK", data: { ...r, employee: { employeeCode: r["empCode"], department: r["department"], designation: r["designation"], user: { name: r["uName"], email: r["uEmail"] } } } });
  } catch (err) {
    console.error("[payroll/get]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function updatePayroll(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"), 10);
    const rows = await q<RowDataPacket>(`SELECT ${PAY_SEL} FROM payroll_records pr WHERE pr.id = ?`, [id]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Not found" }); return; }
    if (rows[0]["status"] !== "DRAFT") { res.status(409).json({ success: false, message: "Only DRAFT records can be adjusted" }); return; }

    const { bonus, otherDeduction, notes } = req.body as Record<string, unknown>;
    const newBonus = bonus != null ? Number(bonus) : Number(rows[0]["bonus"]);
    const newOther = otherDeduction != null ? Number(otherDeduction) : Number(rows[0]["otherDeduction"]);
    const newNet   = Number(rows[0]["grossSalary"]) + Number(rows[0]["overtimeAmount"]) + newBonus - Number(rows[0]["lateDeduction"]) - newOther;

    const sets = ["bonus = ?", "other_deduction = ?", "net_salary = ?"];
    const p: unknown[] = [newBonus, newOther, newNet];
    if (notes != null) { sets.push("notes = ?"); p.push(String(notes)); }
    p.push(id);
    await run(`UPDATE payroll_records SET ${sets.join(", ")} WHERE id = ?`, p as string[]);

    const updRows = await q<RowDataPacket>(`SELECT ${PAY_SEL} FROM payroll_records pr WHERE pr.id = ?`, [id]);
    res.json({ success: true, message: "Payroll updated", data: updRows[0] });
  } catch (err) {
    console.error("[payroll/update]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function approvePayroll(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"), 10);
    const rows = await q<RowDataPacket>(
      `SELECT ${PAY_SEL}, e.employee_code AS empCode, e.department, e.designation,
              e.user_id AS eUserId, u.name AS uName, u.email AS uEmail
       FROM payroll_records pr JOIN employees e ON pr.employee_id = e.id JOIN users u ON e.user_id = u.id WHERE pr.id = ?`,
      [id]
    );
    if (!rows[0]) { res.status(404).json({ success: false, message: "Not found" }); return; }
    if (rows[0]["status"] !== "DRAFT") { res.status(409).json({ success: false, message: "Already approved" }); return; }
    const r = rows[0];

    await run("UPDATE payroll_records SET status = 'APPROVED' WHERE id = ?", [id]);
    await run(
      "INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, 'PAYROLL', 'Payslip ready', ?, '/payroll')",
      [r["eUserId"], `Your payslip for ${new Date(Number(r["year"]), Number(r["month"]) - 1).toLocaleString("en-US", { month: "long" })} ${r["year"]} has been approved`]
    );
    await logActivity(req.user!.id, "payroll.approved", "PayrollRecord", id, undefined, undefined, req.ip);

    const updRows = await q<RowDataPacket>(`SELECT ${PAY_SEL} FROM payroll_records pr WHERE pr.id = ?`, [id]);
    res.json({ success: true, message: "Payroll approved", data: updRows[0] });
  } catch (err) {
    console.error("[payroll/approve]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function markPayrollPaid(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"), 10);
    const rows = await q<RowDataPacket>("SELECT id, status FROM payroll_records WHERE id = ?", [id]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Not found" }); return; }
    if (rows[0]["status"] === "PAID") { res.status(409).json({ success: false, message: "Already marked as paid" }); return; }
    await run("UPDATE payroll_records SET status = 'PAID', paid_at = NOW() WHERE id = ?", [id]);
    await logActivity(req.user!.id, "payroll.paid", "PayrollRecord", id, undefined, undefined, req.ip);
    const updRows = await q<RowDataPacket>(`SELECT ${PAY_SEL} FROM payroll_records pr WHERE pr.id = ?`, [id]);
    res.json({ success: true, message: "Marked as paid", data: updRows[0] });
  } catch (err) {
    console.error("[payroll/mark-paid]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function deletePayrollRecord(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"), 10);
    const rows = await q<RowDataPacket>("SELECT id, status FROM payroll_records WHERE id = ?", [id]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Payroll record not found" }); return; }
    await run("DELETE FROM payroll_records WHERE id = ?", [id]);
    await logActivity(req.user!.id, "payroll.deleted", "PayrollRecord", id, { status: rows[0]["status"] }, undefined, req.ip);
    res.json({ success: true, message: "Payroll record deleted", data: null });
  } catch (err) {
    console.error("[payroll/delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function downloadPayslip(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"), 10);
    const rows = await q<RowDataPacket>(
      `SELECT ${PAY_SEL}, e.employee_code AS empCode, e.department, e.designation,
              pr.employee_id AS employeeId, u.name AS uName, u.email AS uEmail
       FROM payroll_records pr
       JOIN employees e ON pr.employee_id = e.id
       JOIN users u ON e.user_id = u.id
       WHERE pr.id = ?`,
      [id]
    );
    if (!rows[0]) { res.status(404).json({ success: false, message: "Not found" }); return; }

    if (req.user!.role === "EMPLOYEE") {
      const empRows = await q<RowDataPacket>("SELECT id FROM employees WHERE user_id = ?", [req.user!.id]);
      if (!empRows[0] || Number(empRows[0]["id"]) !== Number(rows[0]["employeeId"])) {
        res.status(403).json({ success: false, message: "Access denied" }); return;
      }
    }

    const r = rows[0];
    if (r["status"] === "DRAFT") { res.status(409).json({ success: false, message: "Payslip not available for DRAFT records" }); return; }

    const filename  = `${r["empCode"]}-${r["month"]}-${r["year"]}.pdf`;
    const pdfBuffer = await generatePayslipPdf({
      id: Number(r["id"]), month: Number(r["month"]), year: Number(r["year"]),
      status: String(r["status"]),
      baseSalary: Number(r["baseSalary"]), grossSalary: Number(r["grossSalary"]),
      netSalary: Number(r["netSalary"]), overtimeAmount: Number(r["overtimeAmount"]),
      bonus: Number(r["bonus"]), lateDeduction: Number(r["lateDeduction"]),
      otherDeduction: Number(r["otherDeduction"]),
      lopDays: Number(r["lopDays"]), presentDays: Number(r["presentDays"]), workingDays: Number(r["workingDays"]),
      leaveDays: Number(r["leaveDays"]),
      notes: r["notes"] as string | null,
      employee: {
        employeeCode: String(r["empCode"]),
        department:   r["department"] as string | null,
        designation:  r["designation"] as string | null,
        user: { name: String(r["uName"]), email: String(r["uEmail"]) },
      },
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.setHeader("Content-Length", pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("[payroll/payslip]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
