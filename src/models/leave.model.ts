import { q, run } from '../lib/db';
import type { RowDataPacket } from 'mysql2';

// ─── Types ────────────────────────────────────────────────────────────────────

export type LeaveType   = 'CASUAL' | 'SICK' | 'PAID' | 'COMP_OFF' | 'EMERGENCY';
export type LeaveStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface LeaveRequestRow extends RowDataPacket {
  id: number;
  uuid: string;
  employeeId: number;
  leaveType: LeaveType;
  fromDate: Date;
  toDate: Date;
  days: number;
  reason: string | null;
  status: LeaveStatus;
  reviewedBy: number | null;
  reviewNote: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

export interface LeaveRequestWithEmployee extends LeaveRequestRow {
  eId: number;
  empCode: string;
  eUserId: number;
  uName: string;
  uEmail: string;
  uAvatar: string | null;
  // optional balance fields (pending queue)
  casualTotal?: number;
  casualUsed?: number;
  sickTotal?: number;
  sickUsed?: number;
  paidTotal?: number;
  paidUsed?: number;
}

export interface ApplyLeaveInput {
  employeeId: number;
  leaveType: LeaveType;
  fromDate: string;
  toDate: string;
  days: number;
  reason?: string;
}

export interface ListLeavesFilter {
  employeeId?: number;
  status?: LeaveStatus;
  leaveType?: LeaveType;
  year?: number;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

const SELECT_REQUEST = `
  SELECT lr.id, lr.uuid, lr.employee_id AS employeeId,
         lr.leave_type AS leaveType, lr.from_date AS fromDate, lr.to_date AS toDate,
         lr.days, lr.reason, lr.status,
         lr.reviewed_by AS reviewedBy, lr.review_note AS reviewNote,
         lr.reviewed_at AS reviewedAt, lr.created_at AS createdAt
  FROM leave_requests lr
`;

export async function apply(data: ApplyLeaveInput): Promise<number> {
  const result = await run(
    `INSERT INTO leave_requests
       (employee_id, leave_type, from_date, to_date, days, reason, status)
     VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
    [data.employeeId, data.leaveType, data.fromDate, data.toDate, data.days, data.reason ?? null]
  );
  return result.insertId;
}

export async function findByUuid(uuid: string): Promise<LeaveRequestRow | null> {
  const rows = await q<LeaveRequestRow>(`${SELECT_REQUEST} WHERE lr.uuid = ?`, [uuid]);
  return rows[0] ?? null;
}

export async function myRequests(employeeId: number): Promise<LeaveRequestRow[]> {
  return q<LeaveRequestRow>(
    `${SELECT_REQUEST} WHERE lr.employee_id = ? ORDER BY lr.created_at DESC`,
    [employeeId]
  );
}

export async function pendingQueue(): Promise<LeaveRequestWithEmployee[]> {
  return q<LeaveRequestWithEmployee>(
    `SELECT lr.id, lr.uuid, lr.employee_id AS employeeId,
            lr.leave_type AS leaveType, lr.from_date AS fromDate, lr.to_date AS toDate,
            lr.days, lr.reason, lr.status,
            lr.reviewed_by AS reviewedBy, lr.review_note AS reviewNote,
            lr.reviewed_at AS reviewedAt, lr.created_at AS createdAt,
            e.id AS eId, e.employee_code AS empCode, e.user_id AS eUserId,
            u.name AS uName, u.email AS uEmail, u.avatar_url AS uAvatar,
            lb.casual_total AS casualTotal, lb.casual_used AS casualUsed,
            lb.sick_total AS sickTotal, lb.sick_used AS sickUsed,
            lb.paid_total AS paidTotal, lb.paid_used AS paidUsed
     FROM leave_requests lr
       JOIN employees e ON lr.employee_id = e.id
       JOIN users u ON e.user_id = u.id
       LEFT JOIN leave_balances lb ON lb.employee_id = e.id AND lb.year = YEAR(NOW())
     WHERE lr.status = 'PENDING'
     ORDER BY lr.created_at ASC`
  );
}

export async function list(filter: ListLeavesFilter = {}): Promise<LeaveRequestWithEmployee[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.employeeId) { clauses.push('lr.employee_id = ?'); params.push(filter.employeeId); }
  if (filter.status)     { clauses.push('lr.status = ?');      params.push(filter.status); }
  if (filter.leaveType)  { clauses.push('lr.leave_type = ?');  params.push(filter.leaveType); }
  if (filter.year)       { clauses.push('YEAR(lr.from_date) = ?'); params.push(filter.year); }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  return q<LeaveRequestWithEmployee>(
    `SELECT lr.id, lr.uuid, lr.employee_id AS employeeId,
            lr.leave_type AS leaveType, lr.from_date AS fromDate, lr.to_date AS toDate,
            lr.days, lr.reason, lr.status,
            lr.reviewed_by AS reviewedBy, lr.review_note AS reviewNote,
            lr.reviewed_at AS reviewedAt, lr.created_at AS createdAt,
            e.id AS eId, e.employee_code AS empCode,
            u.name AS uName, u.avatar_url AS uAvatar
     FROM leave_requests lr
       JOIN employees e ON lr.employee_id = e.id
       JOIN users u ON e.user_id = u.id
     ${where} ORDER BY lr.created_at DESC`,
    params
  );
}

export async function review(uuid: string, data: {
  status: LeaveStatus;
  reviewedBy: number;
  reviewNote?: string;
}): Promise<void> {
  await run(
    `UPDATE leave_requests
     SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = NOW()
     WHERE uuid = ?`,
    [data.status, data.reviewedBy, data.reviewNote ?? null, uuid]
  );
}

export async function approvedInRange(from: string, to: string): Promise<LeaveRequestWithEmployee[]> {
  return q<LeaveRequestWithEmployee>(
    `SELECT lr.id, lr.uuid, lr.employee_id AS employeeId,
            lr.leave_type AS leaveType, lr.from_date AS fromDate, lr.to_date AS toDate,
            lr.days, lr.reason, lr.status,
            lr.reviewed_by AS reviewedBy, lr.review_note AS reviewNote,
            lr.reviewed_at AS reviewedAt, lr.created_at AS createdAt,
            e.id AS eId, u.id AS uId, u.name AS uName, u.avatar_url AS uAvatar
     FROM leave_requests lr
       JOIN employees e ON lr.employee_id = e.id
       JOIN users u ON e.user_id = u.id
     WHERE lr.status = 'APPROVED' AND lr.from_date <= ? AND lr.to_date >= ?
     ORDER BY lr.from_date ASC`,
    [to, from]
  );
}

export async function approvedDaysInPeriod(employeeId: number, from: string, to: string): Promise<Array<RowDataPacket & { days: number }>> {
  return q(
    `SELECT days FROM leave_requests
     WHERE employee_id = ? AND status = 'APPROVED' AND from_date <= ? AND to_date >= ?`,
    [employeeId, to, from]
  );
}

// ─── Leave Balance ────────────────────────────────────────────────────────────

export async function getBalance(employeeId: number, year: number): Promise<RowDataPacket & {
  id: number;
  casualTotal: number; casualUsed: number;
  sickTotal: number;   sickUsed: number;
  paidTotal: number;   paidUsed: number;
  compOff: number;
} | null> {
  const rows = await q<RowDataPacket & {
    id: number;
    casualTotal: number; casualUsed: number;
    sickTotal: number;   sickUsed: number;
    paidTotal: number;   paidUsed: number;
    compOff: number;
  }>(
    `SELECT id, casual_total AS casualTotal, casual_used AS casualUsed,
            sick_total AS sickTotal, sick_used AS sickUsed,
            paid_total AS paidTotal, paid_used AS paidUsed,
            comp_off AS compOff
     FROM leave_balances WHERE employee_id = ? AND year = ?`,
    [employeeId, year]
  );
  return rows[0] ?? null;
}

export async function incrementUsed(
  employeeId: number,
  year: number,
  col: 'casual_used' | 'sick_used' | 'paid_used' | 'comp_off',
  amount: number
): Promise<void> {
  await run(
    `UPDATE leave_balances SET ${col} = ${col} + ? WHERE employee_id = ? AND year = ?`,
    [amount, employeeId, year]
  );
}
