import { q, run } from '../lib/db';
import type { RowDataPacket } from 'mysql2';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AttendanceType = 'PRESENT' | 'HALF_DAY' | 'ABSENT' | 'LEAVE' | 'COMP_OFF' | 'HOLIDAY';

export interface AttendanceRow extends RowDataPacket {
  id: number;
  employeeId: number;
  date: Date;
  clockIn: Date | null;
  clockOut: Date | null;
  type: AttendanceType;
  lateMinutes: number;
  earlyOutMinutes: number;
  overtimeMinutes: number;
  workMinutes: number | null;
  notes: string | null;
  isManual: number;
  createdAt: Date;
}

export interface AttendanceWithEmployee extends AttendanceRow {
  eId: number;
  empCode: string;
  uId: number;
  uName: string;
  uAvatar: string | null;
}

export interface ClockInInput {
  employeeId: number;
  date: string;
  clockIn: Date;
  lateMinutes: number;
}

export interface OverrideInput {
  clockIn?: Date;
  clockOut?: Date;
  type?: AttendanceType;
  workMinutes?: number;
  overtimeMinutes?: number;
  lateMinutes?: number;
  notes?: string;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function findByEmployeeAndDate(employeeId: number, date: string): Promise<AttendanceRow | null> {
  const rows = await q<AttendanceRow>(
    `SELECT * FROM attendance_logs WHERE employee_id = ? AND date = ?`,
    [employeeId, date]
  );
  return rows[0] ?? null;
}

export async function findById(id: number): Promise<AttendanceRow | null> {
  const rows = await q<AttendanceRow>(`SELECT * FROM attendance_logs WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

export async function clockIn(data: ClockInInput): Promise<number> {
  const result = await run(
    `INSERT INTO attendance_logs (employee_id, date, clock_in, type, late_minutes)
     VALUES (?, ?, ?, 'PRESENT', ?)`,
    [data.employeeId, data.date, data.clockIn, data.lateMinutes]
  );
  return result.insertId;
}

export async function clockOut(id: number, data: {
  clockOut: Date;
  workMinutes: number;
  overtimeMinutes: number;
  type: AttendanceType;
}): Promise<void> {
  await run(
    `UPDATE attendance_logs SET clock_out = ?, work_minutes = ?, overtime_minutes = ?, type = ? WHERE id = ?`,
    [data.clockOut, data.workMinutes, data.overtimeMinutes, data.type, id]
  );
}

export async function override(id: number, data: OverrideInput): Promise<void> {
  const fields: string[] = ['is_manual = 1'];
  const params: unknown[] = [];

  if (data.clockIn         !== undefined) { fields.push('clock_in = ?');          params.push(data.clockIn); }
  if (data.clockOut        !== undefined) { fields.push('clock_out = ?');         params.push(data.clockOut); }
  if (data.type            !== undefined) { fields.push('type = ?');              params.push(data.type); }
  if (data.workMinutes     !== undefined) { fields.push('work_minutes = ?');      params.push(data.workMinutes); }
  if (data.overtimeMinutes !== undefined) { fields.push('overtime_minutes = ?');  params.push(data.overtimeMinutes); }
  if (data.lateMinutes     !== undefined) { fields.push('late_minutes = ?');      params.push(data.lateMinutes); }
  if (data.notes           !== undefined) { fields.push('notes = ?');             params.push(data.notes); }

  params.push(id);
  await run(`UPDATE attendance_logs SET ${fields.join(', ')} WHERE id = ?`, params);
}

export async function markLeave(employeeId: number, date: string): Promise<void> {
  await run(
    `INSERT INTO attendance_logs (employee_id, date, type, late_minutes) VALUES (?, ?, 'LEAVE', 0)
     ON DUPLICATE KEY UPDATE type = 'LEAVE'`,
    [employeeId, date]
  );
}

export async function myHistory(employeeId: number, from: string, to: string): Promise<AttendanceRow[]> {
  return q<AttendanceRow>(
    `SELECT * FROM attendance_logs WHERE employee_id = ? AND date >= ? AND date <= ? ORDER BY date ASC`,
    [employeeId, from, to]
  );
}

export async function teamAttendance(from: string, to: string, employeeId?: number): Promise<AttendanceWithEmployee[]> {
  const clauses = ['a.date >= ?', 'a.date <= ?'];
  const params: unknown[] = [from, to];

  if (employeeId) { clauses.push('a.employee_id = ?'); params.push(employeeId); }

  return q<AttendanceWithEmployee>(
    `SELECT a.*, e.id AS eId, e.employee_code AS empCode,
            u.id AS uId, u.name AS uName, u.avatar_url AS uAvatar
     FROM attendance_logs a
       JOIN employees e ON a.employee_id = e.id
       JOIN users u ON e.user_id = u.id
     WHERE ${clauses.join(' AND ')}
     ORDER BY a.date ASC, a.employee_id ASC`,
    params
  );
}

export async function summary(from: string, to: string, employeeId?: number): Promise<Array<RowDataPacket & {
  type: AttendanceType;
  lateMinutes: number;
  overtimeMinutes: number;
  workMinutes: number | null;
}>> {
  const clauses = ['date >= ?', 'date <= ?'];
  const params: unknown[] = [from, to];

  if (employeeId) { clauses.push('employee_id = ?'); params.push(employeeId); }

  return q(
    `SELECT type, late_minutes AS lateMinutes,
            overtime_minutes AS overtimeMinutes, work_minutes AS workMinutes
     FROM attendance_logs WHERE ${clauses.join(' AND ')}`,
    params
  );
}

export async function todayCounts(date: string): Promise<Array<RowDataPacket & { type: AttendanceType; cnt: number }>> {
  return q(
    `SELECT type, COUNT(*) AS cnt FROM attendance_logs WHERE date = ? GROUP BY type`,
    [date]
  );
}
