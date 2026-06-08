import { q, run } from '../lib/db';
import type { RowDataPacket } from 'mysql2';

// ─── Types ────────────────────────────────────────────────────────────────────

export type UserRole = 'SUPER_ADMIN' | 'ADMIN' | 'HR' | 'TEAM_LEAD' | 'EMPLOYEE' | 'ACCOUNTANT' | 'CLIENT';
export type UserStatus = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';

export interface UserRow extends RowDataPacket {
  id: number;
  uuid: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  avatarUrl: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  clientId: number | null;
}

export interface UserAuthRow extends RowDataPacket {
  id: number;
  uuid: string;
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  status: UserStatus;
  avatarUrl: string | null;
}

export interface UserWithEmployee extends UserRow {
  empId: number | null;
  employeeCode: string | null;
  department: string | null;
  designation: string | null;
  joiningDate: Date | null;
}

export interface CreateUserInput {
  name: string;
  email: string;
  passwordHash: string;
  role?: UserRole;
}

export interface UpdateUserInput {
  name?: string;
  email?: string;
  role?: UserRole;
  status?: UserStatus;
  avatarUrl?: string;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

const SELECT_PUBLIC = `
  SELECT id, uuid, name, email, role, status,
         avatar_url AS avatarUrl, last_login_at AS lastLoginAt,
         created_at AS createdAt, updated_at AS updatedAt,
         client_id AS clientId
  FROM users
`;

export async function findByEmail(email: string): Promise<UserAuthRow | null> {
  const rows = await q<UserAuthRow>(
    `SELECT id, uuid, name, email,
            password_hash AS passwordHash, role, status,
            avatar_url AS avatarUrl
     FROM users WHERE email = ?`,
    [email]
  );
  return rows[0] ?? null;
}

export async function findById(id: number): Promise<UserRow | null> {
  const rows = await q<UserRow>(`${SELECT_PUBLIC} WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

export async function findByIdWithEmployee(id: number): Promise<UserWithEmployee | null> {
  const rows = await q<UserWithEmployee>(
    `SELECT u.id, u.uuid, u.name, u.email, u.role, u.status,
            u.avatar_url AS avatarUrl, u.last_login_at AS lastLoginAt, u.created_at AS createdAt,
            e.id AS empId, e.employee_code AS employeeCode,
            e.department, e.designation, e.joining_date AS joiningDate
     FROM users u LEFT JOIN employees e ON e.user_id = u.id
     WHERE u.id = ?`,
    [id]
  );
  return rows[0] ?? null;
}

export async function findPasswordHash(id: number): Promise<string | null> {
  const rows = await q<RowDataPacket & { passwordHash: string }>(
    `SELECT password_hash AS passwordHash FROM users WHERE id = ?`,
    [id]
  );
  return rows[0]?.passwordHash ?? null;
}

export async function emailExists(email: string): Promise<boolean> {
  const rows = await q<RowDataPacket>(`SELECT id FROM users WHERE email = ?`, [email]);
  return rows.length > 0;
}

export interface ListUsersFilter {
  role?: UserRole;
  status?: UserStatus;
  search?: string;
}

export async function list(filter: ListUsersFilter = {}): Promise<UserRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.role)   { clauses.push('role = ?');             params.push(filter.role); }
  if (filter.status) { clauses.push('status = ?');           params.push(filter.status); }
  if (filter.search) { clauses.push('(name LIKE ? OR email LIKE ?)'); params.push(`%${filter.search}%`, `%${filter.search}%`); }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return q<UserRow>(`${SELECT_PUBLIC} ${where} ORDER BY created_at DESC`, params);
}

export async function listByRoles(roles: UserRole[]): Promise<Array<RowDataPacket & { id: number }>> {
  const placeholders = roles.map(() => '?').join(',');
  return q<RowDataPacket & { id: number }>(
    `SELECT id FROM users WHERE role IN (${placeholders}) AND status = 'ACTIVE'`,
    roles
  );
}

export async function create(data: CreateUserInput): Promise<number> {
  const result = await run(
    `INSERT INTO users (name, email, password_hash, role, status) VALUES (?, ?, ?, ?, 'ACTIVE')`,
    [data.name, data.email, data.passwordHash, data.role ?? 'EMPLOYEE']
  );
  return result.insertId;
}

export async function update(id: number, data: UpdateUserInput): Promise<void> {
  const fields: string[] = [];
  const params: unknown[] = [];

  if (data.name      !== undefined) { fields.push('name = ?');       params.push(data.name); }
  if (data.email     !== undefined) { fields.push('email = ?');      params.push(data.email); }
  if (data.role      !== undefined) { fields.push('role = ?');       params.push(data.role); }
  if (data.status    !== undefined) { fields.push('status = ?');     params.push(data.status); }
  if (data.avatarUrl !== undefined) { fields.push('avatar_url = ?'); params.push(data.avatarUrl); }

  if (!fields.length) return;
  params.push(id);
  await run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params);
}

export async function updateLastLogin(id: number): Promise<void> {
  await run(`UPDATE users SET last_login_at = NOW() WHERE id = ?`, [id]);
}

export async function updatePassword(id: number, hash: string): Promise<void> {
  await run(`UPDATE users SET password_hash = ? WHERE id = ?`, [hash, id]);
}

export async function setStatus(id: number, status: UserStatus): Promise<void> {
  await run(`UPDATE users SET status = ? WHERE id = ?`, [status, id]);
}
