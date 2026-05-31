// src/controllers/payroll.controller.ts
import { Request, Response } from "express";
import fs from "fs";
import path from "path";
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

// ─── PDF Payslip ───────────────────────────────────────────────────────────

async function generatePayslipPdf(record: {
  id: number; month: number; year: number;
  baseSalary: number; grossSalary: number; netSalary: number;
  overtimeAmount: number; bonus: number; lateDeduction: number;
  otherDeduction: number; lopDays: number; presentDays: number; workingDays: number;
  employee: { employeeCode: string; department?: string | null; designation?: string | null; user: { name: string; email: string } };
}): Promise<string> {
  const dir = path.join(process.cwd(), "uploads", "payslips");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const monthName = new Date(record.year, record.month - 1).toLocaleString("en-US", { month: "long" });
  const filename  = `${record.employee.employeeCode}-${record.month}-${record.year}.pdf`;
  const filepath  = path.join(dir, filename);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const out  = fs.createWriteStream(filepath);
    doc.pipe(out);
    const w = 495;
    doc.fontSize(20).font("Helvetica-Bold").text("AGENCY OS", 50, 50);
    doc.fontSize(10).font("Helvetica").fillColor("#555").text("Your Digital Growth Partner", 50, 74);
    doc.fontSize(16).font("Helvetica-Bold").fillColor("#000").text("PAYSLIP", 400, 50, { align: "right", width: 145 });
    doc.fontSize(10).font("Helvetica").fillColor("#555").text(`${monthName} ${record.year}`, 400, 74, { align: "right", width: 145 });
    doc.moveTo(50, 95).lineTo(545, 95).strokeColor("#ddd").lineWidth(1).stroke();
    doc.y = 110;
    doc.fillColor("#000").fontSize(10).font("Helvetica-Bold").text("Employee Details", 50);
    doc.y += 4;
    [["Name", record.employee.user.name], ["Code", record.employee.employeeCode],
      ["Designation", record.employee.designation ?? "—"], ["Department", record.employee.department ?? "—"],
      ["Email", record.employee.user.email]].forEach(([k, v]) => {
      const y = doc.y;
      doc.font("Helvetica").fillColor("#555").text(String(k), 50, y, { width: 120 });
      doc.fillColor("#000").text(String(v), 180, y);
      doc.y += 2;
    });
    doc.moveTo(50, doc.y + 8).lineTo(545, doc.y + 8).strokeColor("#ddd").stroke();
    doc.y += 20;
    doc.font("Helvetica-Bold").fillColor("#000").text("Attendance Summary", 50);
    doc.y += 4;
    [["Working Days", String(record.workingDays)], ["Present Days", record.presentDays.toFixed(1)],
      ["Leave Days", (record.grossSalary > 0 ? record.presentDays : 0).toFixed(1)],
      ["LOP Days", record.lopDays.toFixed(1)]].forEach(([k, v]) => {
      const y = doc.y;
      doc.font("Helvetica").fillColor("#555").text(String(k), 50, y, { width: 120 });
      doc.fillColor("#000").text(String(v), 180, y);
      doc.y += 2;
    });
    doc.moveTo(50, doc.y + 8).lineTo(545, doc.y + 8).strokeColor("#ddd").stroke();
    doc.y += 20;
    const col = [50, 350, 545];
    const tableTop = doc.y;
    doc.font("Helvetica-Bold").text("Earnings", col[0]!, tableTop);
    doc.font("Helvetica-Bold").text("Amount (₹)", col[1]!, tableTop);
    doc.y = tableTop + 16;
    ([["Base Salary", record.baseSalary], ["Overtime Pay", record.overtimeAmount], ["Bonus", record.bonus]] as [string, number][])
      .forEach(([k, v]) => { const y = doc.y; doc.font("Helvetica").fillColor("#555").text(k, col[0]!, y); doc.fillColor("#000").text(`₹${v.toFixed(2)}`, col[1]!, y); doc.y += 2; });
    doc.y += 10;
    doc.font("Helvetica-Bold").fillColor("#000").text("Deductions", col[0]!);
    doc.y += 4;
    ([["LOP Deduction", record.lateDeduction], ["Other Deduction", record.otherDeduction]] as [string, number][])
      .forEach(([k, v]) => { const y = doc.y; doc.font("Helvetica").fillColor("#555").text(k, col[0]!, y); doc.fillColor("#c00").text(`-₹${v.toFixed(2)}`, col[1]!, y); doc.y += 2; });
    doc.y += 12;
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#aaa").stroke();
    doc.y += 8;
    doc.font("Helvetica-Bold").fontSize(13).fillColor("#000").text("NET SALARY", 50, doc.y).text(`₹${record.netSalary.toFixed(2)}`, col[1]!, doc.y);
    doc.y = 750;
    doc.fontSize(8).font("Helvetica").fillColor("#999").text("This is a computer-generated payslip. No signature required.", 50, 750, { align: "center", width: w });
    doc.end();
    out.on("finish", () => resolve(`uploads/payslips/${filename}`));
    out.on("error", reject);
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

    let payslipPath: string | null = null;
    try {
      payslipPath = await generatePayslipPdf({
        id: Number(r["id"]), month: Number(r["month"]), year: Number(r["year"]),
        baseSalary: Number(r["baseSalary"]), grossSalary: Number(r["grossSalary"]),
        netSalary: Number(r["netSalary"]), overtimeAmount: Number(r["overtimeAmount"]),
        bonus: Number(r["bonus"]), lateDeduction: Number(r["lateDeduction"]),
        otherDeduction: Number(r["otherDeduction"]),
        lopDays: Number(r["lopDays"]), presentDays: Number(r["presentDays"]), workingDays: Number(r["workingDays"]),
        employee: { employeeCode: String(r["empCode"]), department: r["department"] as string | null, designation: r["designation"] as string | null, user: { name: String(r["uName"]), email: String(r["uEmail"]) } },
      });
    } catch (pdfErr) { console.error("[payroll/approve] PDF failed:", pdfErr); }

    await run("UPDATE payroll_records SET status = 'APPROVED', payslip_path = ? WHERE id = ?", [payslipPath, id]);
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

export async function downloadPayslip(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"), 10);
    const rows = await q<RowDataPacket>("SELECT id, employee_id AS employeeId, payslip_path AS payslipPath FROM payroll_records WHERE id = ?", [id]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Not found" }); return; }

    if (req.user!.role === "EMPLOYEE") {
      const empRows = await q<RowDataPacket>("SELECT id FROM employees WHERE user_id = ?", [req.user!.id]);
      if (!empRows[0] || Number(empRows[0]["id"]) !== Number(rows[0]["employeeId"])) {
        res.status(403).json({ success: false, message: "Access denied" }); return;
      }
    }

    if (!rows[0]["payslipPath"]) { res.status(404).json({ success: false, message: "Payslip not yet generated" }); return; }
    const filepath = path.join(process.cwd(), String(rows[0]["payslipPath"]));
    if (!fs.existsSync(filepath)) { res.status(404).json({ success: false, message: "Payslip file not found" }); return; }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(filepath)}"`);
    fs.createReadStream(filepath).pipe(res);
  } catch (err) {
    console.error("[payroll/payslip]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
