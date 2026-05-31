import { q, run } from '../lib/db';
import type { RowDataPacket } from 'mysql2';

// ─── Types ────────────────────────────────────────────────────────────────────

export type EmpStatus = 'ACTIVE' | 'INACTIVE' | 'TERMINATED';
export type DocType   = 'OFFER_LETTER' | 'CONTRACT' | 'ID_PROOF' | 'APPRAISAL' | 'OTHER';

export interface EmployeeRow extends RowDataPacket {
  id: number;
  uuid: string;
  userId: number;
  employeeCode: string;
  department: string | null;
  designation: string | null;
  joiningDate: Date;
  shiftStart: string;
  shiftEnd: string;
  baseSalary: number;
  bankName: string | null;
  bankAccount: string | null;
  bankIfsc: string | null;
  panNumber: string | null;
  emergencyContact: string | null;
  emergencyPhone: string | null;
  status: EmpStatus;
  createdAt: Date;
  updatedAt: Date;
  // joined from users
  uId: number;
  uName: string;
  uEmail: string;
  uAvatarUrl: string | null;
  uRole?: string;
  uStatus?: string;
}

export interface EmployeeDocumentRow extends RowDataPacket {
  id: number;
  employeeId: number;
  docType: DocType;
  name: string;
  filePath: string;
  uploadedBy: number;
  createdAt: Date;
}

export interface LeaveBalanceRow extends RowDataPacket {
  id: number;
  employeeId: number;
  year: number;
  casualTotal: number;
  casualUsed: number;
  sickTotal: number;
  sickUsed: number;
  paidTotal: number;
  paidUsed: number;
  compOff: number;
}

export interface CreateEmployeeInput {
  userId: number;
  employeeCode: string;
  department?: string;
  designation?: string;
  joiningDate: string;
  shiftStart?: string;
  shiftEnd?: string;
  baseSalary: number;
  bankName?: string;
  bankAccount?: string;
  bankIfsc?: string;
  panNumber?: string;
  emergencyContact?: string;
  emergencyPhone?: string;
}

export interface UpdateEmployeeInput {
  department?: string;
  designation?: string;
  joiningDate?: string;
  shiftStart?: string;
  shiftEnd?: string;
  baseSalary?: number;
  bankName?: string;
  bankAccount?: string;
  bankIfsc?: string;
  panNumber?: string;
  emergencyContact?: string;
  emergencyPhone?: string;
  status?: EmpStatus;
}

export interface ListEmployeesFilter {
  status?: EmpStatus;
  department?: string;
  search?: string;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

const SELECT_EMPLOYEE = `
  SELECT e.id, e.uuid, e.user_id AS userId, e.employee_code AS employeeCode,
         e.department, e.designation, e.joining_date AS joiningDate,
         e.shift_start AS shiftStart, e.shift_end AS shiftEnd,
         e.base_salary AS baseSalary, e.bank_name AS bankName,
         e.bank_account AS bankAccount, e.bank_ifsc AS bankIfsc,
         e.pan_number AS panNumber, e.emergency_contact AS emergencyContact,
         e.emergency_phone AS emergencyPhone, e.status,
         e.created_at AS createdAt, e.updated_at AS updatedAt,
         u.id AS uId, u.name AS uName, u.email AS uEmail,
         COALESCE(e.photo_url, u.avatar_url) AS uAvatarUrl
  FROM employees e JOIN users u ON e.user_id = u.id
`;

export async function list(filter: ListEmployeesFilter = {}): Promise<EmployeeRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.status)     { clauses.push('e.status = ?');       params.push(filter.status); }
  if (filter.department) { clauses.push('e.department = ?');   params.push(filter.department); }
  if (filter.search)     { clauses.push('(u.name LIKE ? OR e.employee_code LIKE ?)'); params.push(`%${filter.search}%`, `%${filter.search}%`); }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return q<EmployeeRow>(`${SELECT_EMPLOYEE} ${where} ORDER BY u.name ASC`, params);
}

export async function findByUuid(uuid: string): Promise<EmployeeRow | null> {
  const rows = await q<EmployeeRow>(
    `${SELECT_EMPLOYEE}, u.role AS uRole, u.status AS uStatus WHERE e.uuid = ?`,
    [uuid]
  );
  return rows[0] ?? null;
}

export async function findById(id: number): Promise<EmployeeRow | null> {
  const rows = await q<EmployeeRow>(`${SELECT_EMPLOYEE} WHERE e.id = ?`, [id]);
  return rows[0] ?? null;
}

export async function findByUserId(userId: number): Promise<RowDataPacket & { id: number; userId: number } | null> {
  const rows = await q<RowDataPacket & { id: number; userId: number }>(
    `SELECT id, user_id AS userId FROM employees WHERE user_id = ?`,
    [userId]
  );
  return rows[0] ?? null;
}

export async function findShiftByUserId(userId: number): Promise<RowDataPacket & { id: number; shiftStart: string; shiftEnd: string } | null> {
  const rows = await q<RowDataPacket & { id: number; shiftStart: string; shiftEnd: string }>(
    `SELECT id, shift_start AS shiftStart, shift_end AS shiftEnd FROM employees WHERE user_id = ?`,
    [userId]
  );
  return rows[0] ?? null;
}

export async function lastEmployeeCode(): Promise<string | null> {
  const rows = await q<RowDataPacket & { employeeCode: string }>(
    `SELECT employee_code AS employeeCode FROM employees ORDER BY employee_code DESC LIMIT 1`
  );
  return rows[0]?.employeeCode ?? null;
}

export async function activeList(): Promise<Array<RowDataPacket & { id: number; baseSalary: number; employeeCode: string }>> {
  return q(
    `SELECT id, base_salary AS baseSalary, employee_code AS employeeCode FROM employees WHERE status = 'ACTIVE'`
  );
}

export async function create(data: CreateEmployeeInput): Promise<number> {
  const result = await run(
    `INSERT INTO employees
       (user_id, employee_code, department, designation, joining_date,
        shift_start, shift_end, base_salary, bank_name, bank_account,
        bank_ifsc, pan_number, emergency_contact, emergency_phone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.userId, data.employeeCode,
      data.department ?? null, data.designation ?? null,
      data.joiningDate,
      data.shiftStart ?? '09:00:00', data.shiftEnd ?? '18:00:00',
      data.baseSalary,
      data.bankName ?? null, data.bankAccount ?? null,
      data.bankIfsc ?? null, data.panNumber ?? null,
      data.emergencyContact ?? null, data.emergencyPhone ?? null,
    ]
  );
  return result.insertId;
}

export async function update(id: number, data: UpdateEmployeeInput): Promise<void> {
  const fieldMap: Record<string, string> = {
    department:       'department',
    designation:      'designation',
    joiningDate:      'joining_date',
    shiftStart:       'shift_start',
    shiftEnd:         'shift_end',
    baseSalary:       'base_salary',
    bankName:         'bank_name',
    bankAccount:      'bank_account',
    bankIfsc:         'bank_ifsc',
    panNumber:        'pan_number',
    emergencyContact: 'emergency_contact',
    emergencyPhone:   'emergency_phone',
    status:           'status',
  };

  const fields: string[] = [];
  const params: unknown[] = [];

  for (const [key, col] of Object.entries(fieldMap)) {
    const val = (data as Record<string, unknown>)[key];
    if (val !== undefined) { fields.push(`${col} = ?`); params.push(val); }
  }

  if (!fields.length) return;
  params.push(id);
  await run(`UPDATE employees SET ${fields.join(', ')} WHERE id = ?`, params);
}

export async function statusCounts(): Promise<Array<RowDataPacket & { status: EmpStatus; cnt: number }>> {
  return q(`SELECT status, COUNT(*) AS cnt FROM employees GROUP BY status`);
}

export async function activeCount(): Promise<number> {
  const rows = await q<RowDataPacket & { cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM employees WHERE status = 'ACTIVE'`
  );
  return rows[0]?.cnt ?? 0;
}

// ─── Documents ────────────────────────────────────────────────────────────────

export async function listDocuments(employeeId: number): Promise<EmployeeDocumentRow[]> {
  return q<EmployeeDocumentRow>(
    `SELECT id, employee_id AS employeeId, doc_type AS docType, name,
            file_path AS filePath, uploaded_by AS uploadedBy, created_at AS createdAt
     FROM employee_documents WHERE employee_id = ? ORDER BY created_at DESC`,
    [employeeId]
  );
}

export async function addDocument(data: {
  employeeId: number;
  docType: DocType;
  name: string;
  filePath: string;
  uploadedBy: number;
}): Promise<number> {
  const result = await run(
    `INSERT INTO employee_documents (employee_id, doc_type, name, file_path, uploaded_by)
     VALUES (?, ?, ?, ?, ?)`,
    [data.employeeId, data.docType, data.name, data.filePath, data.uploadedBy]
  );
  return result.insertId;
}

export async function findDocumentById(id: number): Promise<RowDataPacket & { id: number; filePath: string } | null> {
  const rows = await q<RowDataPacket & { id: number; filePath: string }>(
    `SELECT id, file_path AS filePath FROM employee_documents WHERE id = ?`,
    [id]
  );
  return rows[0] ?? null;
}

export async function deleteDocument(id: number): Promise<void> {
  await run(`DELETE FROM employee_documents WHERE id = ?`, [id]);
}

// ─── Leave Balance ────────────────────────────────────────────────────────────

export async function getLeaveBalance(employeeId: number, year: number): Promise<LeaveBalanceRow | null> {
  const rows = await q<LeaveBalanceRow>(
    `SELECT id, employee_id AS employeeId, year,
            casual_total AS casualTotal, casual_used AS casualUsed,
            sick_total AS sickTotal, sick_used AS sickUsed,
            paid_total AS paidTotal, paid_used AS paidUsed,
            comp_off AS compOff
     FROM leave_balances WHERE employee_id = ? AND year = ?`,
    [employeeId, year]
  );
  return rows[0] ?? null;
}

export async function createLeaveBalance(employeeId: number, year: number): Promise<void> {
  await run(
    `INSERT INTO leave_balances (employee_id, year, casual_total, sick_total, paid_total)
     VALUES (?, ?, 12, 6, 15)`,
    [employeeId, year]
  );
}

export async function incrementLeaveUsed(
  employeeId: number,
  year: number,
  field: 'casual_used' | 'sick_used' | 'paid_used' | 'comp_off',
  amount: number
): Promise<void> {
  await run(
    `UPDATE leave_balances SET ${field} = ${field} + ? WHERE employee_id = ? AND year = ?`,
    [amount, employeeId, year]
  );
}
