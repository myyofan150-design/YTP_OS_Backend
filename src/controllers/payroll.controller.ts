// src/controllers/payroll.controller.ts
import { Request, Response } from "express";
import https from "https";
import http from "http";
import PDFDocument from "pdfkit";
import { q, run, RowDataPacket } from "../lib/db";
import { logActivity } from "../lib/logger";
import { registerPdfFonts } from "../utils/pdfFont";
import * as PayrollModel from "../models/payroll.model";

// ─── PDF helpers ─────────────────────────────────────────────────────────────

function fetchUrlBuffer(url: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const get = url.startsWith("https") ? https.get : http.get;
    get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end",  () => resolve(Buffer.concat(chunks)));
      res.on("error",() => resolve(null));
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

async function generatePayslipPdf(record: {
  month: number; year: number; status: string;
  baseSalary: number; grossSalary: number; netSalary: number;
  overtimeAmount: number; bonus: number; lateDeduction: number;
  otherDeduction: number; lopDays: number; presentDays: number;
  workingDays: number; leaveDays: number; notes?: string | null;
  employee: { employeeCode: string; department?: string | null; designation?: string | null; user: { name: string } };
}): Promise<Buffer> {
  const monthName  = new Date(record.year, record.month - 1).toLocaleString("en-US", { month: "long" });
  const company    = await getCompanySettings();
  const logoBuffer = company.logoUrl ? await fetchUrlBuffer(company.logoUrl) : null;
  const fmtINR     = (n: number) => `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

  return new Promise<Buffer>((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 0, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end",  () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    registerPdfFonts(doc);
    const fontR = "R";
    const fontB = "B";

    const teal   = "#03c4a7";
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

    let logoRendered = false;
    if (logoBuffer) {
      try {
        // Fit logo within left half of header; maintain aspect ratio
        doc.image(logoBuffer, L, 18, { fit: [240, 56] });
        logoRendered = true;
      } catch { /* skip */ }
    }
    if (!logoRendered) {
      doc.fillColor(white).fontSize(18).font(fontB)
         .text(company.name, L, 27, { lineBreak: false, width: 250 });
      if (company.tagline) {
        doc.fillColor(tealLt).fontSize(8.5).font(fontR)
           .text(company.tagline, L, 50, { lineBreak: false, width: 250 });
      }
    }

    doc.fillColor(white).fontSize(22).font(fontB)
       .text("PAYSLIP", 300, 21, { width: 255, align: "right", lineBreak: false });
    doc.fillColor(tealLt).fontSize(8.5).font(fontR)
       .text(`${monthName} ${record.year}`, 300, 48, { width: 255, align: "right", lineBreak: false });

    const badgeW = 72, badgeH = 16, badgeX = R - badgeW, badgeY = 65;
    doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 8)
       .strokeColor(tealLt).lineWidth(0.5).stroke();
    doc.fillColor(white).fontSize(7).font(fontB)
       .text(record.status, badgeX, badgeY + 4.5, { width: badgeW, align: "center", lineBreak: false });

    // ── EMPLOYEE / PERIOD ─────────────────────────────────────────────────
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
      { label: "Working Days", value: String(record.workingDays),             red: false },
      { label: "Present Days", value: Number(record.presentDays).toFixed(1), red: false },
      { label: "Leave Days",   value: Number(record.leaveDays).toFixed(1),   red: false },
      { label: "LOP Days",     value: Number(record.lopDays).toFixed(1),     red: Number(record.lopDays) > 0 },
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
      ...(record.bonus > 0          ? [["Bonus",        record.bonus]          as [string, number]] : []),
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysInMonth(month: number, year: number): number {
  return new Date(year, month, 0).getDate();
}

function calcNetSalary(params: {
  baseSalary: number;
  workingDays: number;
  presentDays: number;
  lopDays: number;
  lateDeduction: number;
  overtimeAmount: number;
  bonus: number;
  otherDeduction: number;
}): { grossSalary: number; netSalary: number } {
  const perDay = params.workingDays > 0 ? params.baseSalary / params.workingDays : 0;
  const lopDeduction = perDay * params.lopDays;
  const grossSalary = params.baseSalary - lopDeduction + params.overtimeAmount + params.bonus;
  const netSalary = grossSalary - params.lateDeduction - params.otherDeduction;
  return {
    grossSalary: Math.round(grossSalary * 100) / 100,
    netSalary: Math.max(0, Math.round(netSalary * 100) / 100),
  };
}

async function calcAttendance(employeeId: number, month: number, year: number) {
  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = daysInMonth(month, year);
  const to   = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  const records = await PayrollModel.attendanceForPeriod(employeeId, from, to);

  let presentDays = 0, leaveDays = 0, lopDays = 0, totalOvertimeMinutes = 0;

  for (const r of records) {
    const type = String(r["type"]);
    if (["PRESENT", "WFH"].includes(type))      { presentDays += 1; }
    else if (type === "HALF_DAY")                { presentDays += 0.5; lopDays += 0.5; }
    else if (["LEAVE", "COMP_OFF"].includes(type)) { leaveDays += 1; }
    else if (type === "ABSENT")                  { lopDays += 1; }
    totalOvertimeMinutes += Number(r["overtimeMinutes"] ?? 0);
  }

  // Calculate late deductions from attendance_policies
  const policyRows = await q<RowDataPacket>(
    `SELECT key_name, value FROM attendance_policies WHERE key_name IN ('late_deduction_per_minute')`,
    []
  );
  const policyMap: Record<string, number> = {};
  for (const p of policyRows) policyMap[String(p["key_name"])] = Number(p["value"]);

  const lateRows = await q<RowDataPacket>(
    `SELECT COALESCE(SUM(late_minutes), 0) AS totalLate FROM attendance_logs
     WHERE employee_id = ? AND date >= ? AND date <= ?`,
    [employeeId, from, to]
  );
  const totalLateMinutes = Number(lateRows[0]?.["totalLate"] ?? 0);
  const lateDeduction = totalLateMinutes * (policyMap["late_deduction_per_minute"] ?? 0);

  // Overtime at 1.5x hourly rate — calculated at generation time using base salary
  const overtimeAmount = 0; // resolved per-employee at generation

  return { presentDays, leaveDays, lopDays, lateDeduction, overtimeMinutes: totalOvertimeMinutes, overtimeAmount };
}

// ─── Controllers ─────────────────────────────────────────────────────────────

// POST /api/payroll/generate
export async function generatePayroll(req: Request, res: Response): Promise<void> {
  try {
    const { employeeId, month, year } = req.body as { employeeId?: number; month?: number; year?: number };
    if (!employeeId || !month || !year) {
      res.status(400).json({ success: false, message: "employeeId, month and year are required" }); return;
    }

    const existing = await PayrollModel.findByEmployeeMonthYear(employeeId, month, year);
    if (existing) {
      res.status(409).json({ success: false, message: "Payroll record already exists for this employee and period" }); return;
    }

    const empRows = await q<RowDataPacket>(
      `SELECT e.id, e.base_salary AS baseSalary, u.name FROM employees e
       JOIN users u ON e.user_id = u.id WHERE e.id = ? AND e.status = 'ACTIVE'`,
      [employeeId]
    );
    if (!empRows[0]) {
      res.status(404).json({ success: false, message: "Employee not found or inactive" }); return;
    }

    const baseSalary = Number(empRows[0]["baseSalary"] ?? 0);
    const workingDays = daysInMonth(month, year);
    const att = await calcAttendance(employeeId, month, year);

    // Overtime: base_salary / workingDays / 8 * 1.5 per OT hour
    const hourlyRate = baseSalary / workingDays / 8;
    const overtimeAmount = Math.round(hourlyRate * 1.5 * (att.overtimeMinutes / 60) * 100) / 100;

    const { grossSalary, netSalary } = calcNetSalary({
      baseSalary,
      workingDays,
      presentDays: att.presentDays,
      lopDays: att.lopDays,
      lateDeduction: att.lateDeduction,
      overtimeAmount,
      bonus: 0,
      otherDeduction: 0,
    });

    const id = await PayrollModel.create({
      employeeId,
      month,
      year,
      baseSalary,
      workingDays,
      presentDays: att.presentDays,
      leaveDays: att.leaveDays,
      lopDays: att.lopDays,
      overtimeAmount,
      grossSalary,
      netSalary,
      generatedBy: req.user!.id,
    });

    await run(
      `UPDATE payroll_records SET late_deduction = ? WHERE id = ?`,
      [att.lateDeduction, id]
    );

    const record = await PayrollModel.findById(id);
    await logActivity(req.user!.id, "GENERATE_PAYROLL", "Payroll", id, undefined, { employeeId, month, year }, req.ip);

    res.status(201).json({ success: true, message: "Payroll generated successfully", data: record });
  } catch (err) {
    console.error("[payroll/generate]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// POST /api/payroll/generate-batch
export async function generateBatch(req: Request, res: Response): Promise<void> {
  try {
    const { month, year } = req.body as { month?: number; year?: number };
    if (!month || !year) {
      res.status(400).json({ success: false, message: "month and year are required" }); return;
    }

    const employees = await q<RowDataPacket>(
      `SELECT e.id, e.base_salary AS baseSalary FROM employees e WHERE e.status = 'ACTIVE'`,
      []
    );

    const results = { generated: 0, skipped: 0, errors: 0 };

    for (const emp of employees) {
      const employeeId = Number(emp["id"]);
      const baseSalary = Number(emp["baseSalary"] ?? 0);
      const existing = await PayrollModel.findByEmployeeMonthYear(employeeId, month, year);
      if (existing) { results.skipped++; continue; }

      try {
        const workingDays = daysInMonth(month, year);
        const att = await calcAttendance(employeeId, month, year);
        const hourlyRate = baseSalary / workingDays / 8;
        const overtimeAmount = Math.round(hourlyRate * 1.5 * (att.overtimeMinutes / 60) * 100) / 100;

        const { grossSalary, netSalary } = calcNetSalary({
          baseSalary, workingDays, presentDays: att.presentDays, lopDays: att.lopDays,
          lateDeduction: att.lateDeduction, overtimeAmount, bonus: 0, otherDeduction: 0,
        });

        const id = await PayrollModel.create({
          employeeId, month, year, baseSalary, workingDays,
          presentDays: att.presentDays, leaveDays: att.leaveDays, lopDays: att.lopDays,
          overtimeAmount, grossSalary, netSalary, generatedBy: req.user!.id,
        });
        await run(`UPDATE payroll_records SET late_deduction = ? WHERE id = ?`, [att.lateDeduction, id]);
        results.generated++;
      } catch { results.errors++; }
    }

    await logActivity(req.user!.id, "GENERATE_BATCH_PAYROLL", "Payroll", 0, undefined, { month, year, ...results }, req.ip);
    res.json({ success: true, message: `Batch complete: ${results.generated} generated, ${results.skipped} skipped, ${results.errors} errors`, data: results });
  } catch (err) {
    console.error("[payroll/generate-batch]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// GET /api/payroll
export async function listPayroll(req: Request, res: Response): Promise<void> {
  try {
    const { month, year, employeeId, status } = req.query as Record<string, string | undefined>;
    const m = parseInt(month ?? String(new Date().getMonth() + 1), 10);
    const y = parseInt(year  ?? String(new Date().getFullYear()),   10);

    const role = req.user!.role;

    // EMPLOYEE can only see their own payroll
    let empIdFilter: number | undefined;
    if (role === "EMPLOYEE") {
      const empRows = await q<RowDataPacket>("SELECT id FROM employees WHERE user_id = ?", [req.user!.id]);
      if (!empRows[0]) { res.json({ success: true, message: "OK", data: [] }); return; }
      empIdFilter = Number(empRows[0]["id"]);
    } else if (employeeId) {
      empIdFilter = parseInt(employeeId, 10);
    }

    const rows = await q<RowDataPacket>(
      `SELECT pr.id, pr.employee_id AS employeeId, pr.month, pr.year,
              pr.base_salary AS baseSalary, pr.working_days AS workingDays,
              pr.present_days AS presentDays, pr.leave_days AS leaveDays,
              pr.lop_days AS lopDays, pr.late_deduction AS lateDeduction,
              pr.overtime_amount AS overtimeAmount, pr.bonus,
              pr.other_deduction AS otherDeduction,
              pr.gross_salary AS grossSalary, pr.net_salary AS netSalary,
              pr.status, pr.paid_at AS paidAt, pr.payslip_path AS payslipPath,
              pr.notes, pr.generated_by AS generatedBy, pr.created_at AS createdAt,
              e.employee_code AS empCode,
              u.name AS uName, u.avatar_url AS uAvatar,
              COALESCE(emp2.photo_url, u.avatar_url) AS photoUrl
       FROM payroll_records pr
       JOIN employees e ON pr.employee_id = e.id
       JOIN users u ON e.user_id = u.id
       LEFT JOIN employees emp2 ON emp2.user_id = u.id
       WHERE pr.month = ? AND pr.year = ?
         ${empIdFilter ? "AND pr.employee_id = ?" : ""}
         ${status ? "AND pr.status = ?" : ""}
       ORDER BY u.name ASC`,
      [m, y, ...(empIdFilter ? [empIdFilter] : []), ...(status ? [status] : [])]
    );

    res.json({ success: true, message: "OK", data: rows });
  } catch (err) {
    console.error("[payroll/list]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// GET /api/payroll/:id
export async function getPayroll(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"), 10);
    const record = await PayrollModel.findById(id);
    if (!record) { res.status(404).json({ success: false, message: "Payroll record not found" }); return; }

    // EMPLOYEE can only see their own
    if (req.user!.role === "EMPLOYEE") {
      const empRows = await q<RowDataPacket>("SELECT id FROM employees WHERE user_id = ?", [req.user!.id]);
      if (!empRows[0] || Number(empRows[0]["id"]) !== record.employeeId) {
        res.status(403).json({ success: false, message: "Access denied" }); return;
      }
    }

    // Attach employee details
    const empRows = await q<RowDataPacket>(
      `SELECT e.employee_code AS employeeCode, e.designation, e.department, u.name AS userName, u.avatar_url AS avatarUrl
       FROM employees e
       JOIN users u ON e.user_id = u.id
       WHERE e.id = ?`,
      [record.employeeId]
    );
    const emp = empRows[0];
    const data = emp
      ? {
          ...record,
          employee: {
            employeeCode: String(emp["employeeCode"] ?? ""),
            designation:  emp["designation"]  ? String(emp["designation"])  : null,
            department:   emp["department"]   ? String(emp["department"])   : null,
            user: { name: String(emp["userName"] ?? ""), avatarUrl: emp["avatarUrl"] ?? null },
          },
        }
      : record;

    res.json({ success: true, message: "OK", data });
  } catch (err) {
    console.error("[payroll/get]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// PATCH /api/payroll/:id
export async function updatePayroll(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"), 10);
    const record = await PayrollModel.findById(id);
    if (!record) { res.status(404).json({ success: false, message: "Payroll record not found" }); return; }
    if (record.status !== "DRAFT") {
      res.status(400).json({ success: false, message: "Only DRAFT payroll can be updated" }); return;
    }

    const { bonus = 0, otherDeduction = 0, notes } = req.body as { bonus?: number; otherDeduction?: number; notes?: string };

    const { netSalary } = calcNetSalary({
      baseSalary:     record.baseSalary,
      workingDays:    record.workingDays,
      presentDays:    record.presentDays,
      lopDays:        record.lopDays,
      lateDeduction:  record.lateDeduction,
      overtimeAmount: record.overtimeAmount,
      bonus:          Number(bonus),
      otherDeduction: Number(otherDeduction),
    });

    await PayrollModel.updateAdjustments(id, {
      bonus: Number(bonus),
      otherDeduction: Number(otherDeduction),
      netSalary,
      notes,
    });

    const updated = await PayrollModel.findById(id);
    await logActivity(req.user!.id, "UPDATE_PAYROLL", "Payroll", id, record, updated ?? undefined, req.ip);

    res.json({ success: true, message: "Payroll updated successfully", data: updated });
  } catch (err) {
    console.error("[payroll/update]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// PATCH /api/payroll/:id/approve
export async function approvePayroll(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"), 10);
    const record = await PayrollModel.findById(id);
    if (!record) { res.status(404).json({ success: false, message: "Payroll record not found" }); return; }
    if (record.status !== "DRAFT") {
      res.status(400).json({ success: false, message: "Only DRAFT payroll can be approved" }); return;
    }

    // Mark approved without PDF generation (PDF can be added separately)
    await run(
      `UPDATE payroll_records SET status = 'APPROVED' WHERE id = ?`,
      [id]
    );

    // Notify the employee
    const empRows = await q<RowDataPacket>(
      `SELECT u.id AS userId FROM employees e JOIN users u ON e.user_id = u.id WHERE e.id = ?`,
      [record.employeeId]
    );
    if (empRows[0]) {
      const monthName = new Date(record.year, record.month - 1, 1).toLocaleString("en-IN", { month: "long" });
      await run(
        `INSERT INTO notifications (user_id, type, title, body) VALUES (?, 'PAYROLL', ?, ?)`,
        [
          empRows[0]["userId"],
          `Payslip ready — ${monthName} ${record.year}`,
          `Your payslip for ${monthName} ${record.year} has been approved. Net salary: ₹${record.netSalary.toLocaleString("en-IN")}.`,
        ]
      );
    }

    const updated = await PayrollModel.findById(id);
    await logActivity(req.user!.id, "APPROVE_PAYROLL", "Payroll", id, undefined, undefined, req.ip);

    res.json({ success: true, message: "Payroll approved successfully", data: updated });
  } catch (err) {
    console.error("[payroll/approve]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// PATCH /api/payroll/:id/mark-paid
export async function markPayrollPaid(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"), 10);
    const record = await PayrollModel.findById(id);
    if (!record) { res.status(404).json({ success: false, message: "Payroll record not found" }); return; }
    if (record.status !== "APPROVED") {
      res.status(400).json({ success: false, message: "Only APPROVED payroll can be marked as paid" }); return;
    }

    await PayrollModel.markPaid(id);
    await logActivity(req.user!.id, "MARK_PAYROLL_PAID", "Payroll", id, undefined, undefined, req.ip);

    res.json({ success: true, message: "Payroll marked as paid", data: await PayrollModel.findById(id) });
  } catch (err) {
    console.error("[payroll/mark-paid]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// GET /api/payroll/:id/payslip
export async function downloadPayslip(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"), 10);
    const record = await PayrollModel.findById(id);
    if (!record) { res.status(404).json({ success: false, message: "Payroll record not found" }); return; }

    // EMPLOYEE can only download their own
    if (req.user!.role === "EMPLOYEE") {
      const empRows = await q<RowDataPacket>("SELECT id FROM employees WHERE user_id = ?", [req.user!.id]);
      if (!empRows[0] || Number(empRows[0]["id"]) !== record.employeeId) {
        res.status(403).json({ success: false, message: "Access denied" }); return;
      }
    }

    // Fetch employee + user details for the PDF
    const empRows = await q<RowDataPacket>(
      `SELECT e.employee_code AS employeeCode, e.designation, e.department, u.name AS userName
       FROM employees e
       JOIN users u ON e.user_id = u.id
       WHERE e.id = ?`,
      [record.employeeId]
    );
    if (!empRows[0]) { res.status(404).json({ success: false, message: "Employee not found" }); return; }

    const emp = empRows[0];
    const pdfBuffer = await generatePayslipPdf({
      ...record,
      employee: {
        employeeCode: String(emp["employeeCode"] ?? ""),
        designation:  emp["designation"]  ? String(emp["designation"])  : null,
        department:   emp["department"]   ? String(emp["department"])   : null,
        user: { name: String(emp["userName"] ?? "") },
      },
    });

    const monthName = new Date(record.year, record.month - 1).toLocaleString("en-US", { month: "long" });
    const filename  = `payslip-${emp["employeeCode"] ?? id}-${monthName}-${record.year}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", pdfBuffer.length);
    res.end(pdfBuffer);
  } catch (err) {
    console.error("[payroll/payslip]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// DELETE /api/payroll/:id
export async function deletePayrollRecord(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"), 10);
    const record = await PayrollModel.findById(id);
    if (!record) { res.status(404).json({ success: false, message: "Payroll record not found" }); return; }
    if (record.status === "PAID") {
      res.status(400).json({ success: false, message: "Cannot delete a PAID payroll record" }); return;
    }

    await run("DELETE FROM payroll_records WHERE id = ?", [id]);
    await logActivity(req.user!.id, "DELETE_PAYROLL", "Payroll", id, record, undefined, req.ip);

    res.json({ success: true, message: "Payroll record deleted", data: null });
  } catch (err) {
    console.error("[payroll/delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
