import { q, run } from '../lib/db';
import type { RowDataPacket } from 'mysql2';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PayrollStatus = 'DRAFT' | 'APPROVED' | 'PAID';

export interface PayrollRow extends RowDataPacket {
  id: number;
  employeeId: number;
  month: number;
  year: number;
  baseSalary: number;
  workingDays: number;
  presentDays: number;
  leaveDays: number;
  lopDays: number;
  lateDeduction: number;
  overtimeAmount: number;
  bonus: number;
  otherDeduction: number;
  grossSalary: number;
  netSalary: number;
  status: PayrollStatus;
  paidAt: Date | null;
  payslipPath: string | null;
  notes: string | null;
  generatedBy: number;
  createdAt: Date;
}

export interface PayrollWithEmployee extends PayrollRow {
  empCode: string;
  uName: string;
  uAvatar: string | null;
}

export interface CreatePayrollInput {
  employeeId: number;
  month: number;
  year: number;
  baseSalary: number;
  workingDays: number;
  presentDays: number;
  leaveDays: number;
  lopDays: number;
  overtimeAmount: number;
  grossSalary: number;
  netSalary: number;
  generatedBy: number;
}

export interface ListPayrollFilter {
  month: number;
  year: number;
  employeeId?: number;
  status?: PayrollStatus;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

const SELECT_PAYROLL = `
  SELECT pr.id, pr.employee_id AS employeeId, pr.month, pr.year,
         pr.base_salary AS baseSalary, pr.working_days AS workingDays,
         pr.present_days AS presentDays, pr.leave_days AS leaveDays,
         pr.lop_days AS lopDays, pr.late_deduction AS lateDeduction,
         pr.overtime_amount AS overtimeAmount, pr.bonus,
         pr.other_deduction AS otherDeduction,
         pr.gross_salary AS grossSalary, pr.net_salary AS netSalary,
         pr.status, pr.paid_at AS paidAt, pr.payslip_path AS payslipPath,
         pr.notes, pr.generated_by AS generatedBy, pr.created_at AS createdAt
  FROM payroll_records pr
`;

export async function findById(id: number): Promise<PayrollRow | null> {
  const rows = await q<PayrollRow>(`${SELECT_PAYROLL} WHERE pr.id = ?`, [id]);
  return rows[0] ?? null;
}

export async function findByEmployeeMonthYear(employeeId: number, month: number, year: number): Promise<RowDataPacket & { id: number } | null> {
  const rows = await q<RowDataPacket & { id: number }>(
    `SELECT id FROM payroll_records WHERE employee_id = ? AND month = ? AND year = ?`,
    [employeeId, month, year]
  );
  return rows[0] ?? null;
}

export async function findPayslipPath(id: number): Promise<RowDataPacket & { id: number; employeeId: number; payslipPath: string | null } | null> {
  const rows = await q<RowDataPacket & { id: number; employeeId: number; payslipPath: string | null }>(
    `SELECT id, employee_id AS employeeId, payslip_path AS payslipPath FROM payroll_records WHERE id = ?`,
    [id]
  );
  return rows[0] ?? null;
}

export async function list(filter: ListPayrollFilter): Promise<PayrollWithEmployee[]> {
  const clauses = ['pr.month = ?', 'pr.year = ?'];
  const params: unknown[] = [filter.month, filter.year];

  if (filter.employeeId) { clauses.push('pr.employee_id = ?'); params.push(filter.employeeId); }
  if (filter.status)     { clauses.push('pr.status = ?');      params.push(filter.status); }

  return q<PayrollWithEmployee>(
    `${SELECT_PAYROLL}
     JOIN employees e ON pr.employee_id = e.id
     JOIN users u ON e.user_id = u.id
     WHERE ${clauses.join(' AND ')}
     ORDER BY u.name ASC`,
    params
  );
}

export async function create(data: CreatePayrollInput): Promise<number> {
  const result = await run(
    `INSERT INTO payroll_records
       (employee_id, month, year, base_salary, working_days, present_days,
        leave_days, lop_days, overtime_amount, gross_salary, net_salary, generated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.employeeId, data.month, data.year,
      data.baseSalary, data.workingDays, data.presentDays,
      data.leaveDays, data.lopDays, data.overtimeAmount,
      data.grossSalary, data.netSalary, data.generatedBy,
    ]
  );
  return result.insertId;
}

export async function updateAdjustments(id: number, data: {
  bonus: number;
  otherDeduction: number;
  netSalary: number;
  notes?: string;
}): Promise<void> {
  await run(
    `UPDATE payroll_records SET bonus = ?, other_deduction = ?, net_salary = ?, notes = ? WHERE id = ?`,
    [data.bonus, data.otherDeduction, data.netSalary, data.notes ?? null, id]
  );
}

export async function approve(id: number, payslipPath: string): Promise<void> {
  await run(
    `UPDATE payroll_records SET status = 'APPROVED', payslip_path = ? WHERE id = ?`,
    [payslipPath, id]
  );
}

export async function markPaid(id: number): Promise<void> {
  await run(`UPDATE payroll_records SET status = 'PAID', paid_at = NOW() WHERE id = ?`, [id]);
}

// ─── Attendance data for calculation ─────────────────────────────────────────

export async function attendanceForPeriod(employeeId: number, from: string, to: string): Promise<Array<RowDataPacket & {
  type: string;
  overtimeMinutes: number;
}>> {
  return q(
    `SELECT type, overtime_minutes AS overtimeMinutes
     FROM attendance_logs WHERE employee_id = ? AND date >= ? AND date <= ?`,
    [employeeId, from, to]
  );
}
