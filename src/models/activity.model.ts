import { q, run } from '../lib/db';
import type { RowDataPacket } from 'mysql2';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ActivityLogRow extends RowDataPacket {
  id: bigint;
  userId: number | null;
  action: string;
  entityType: string;
  entityId: number | null;
  beforeData: unknown;
  afterData: unknown;
  ipAddress: string | null;
  createdAt: Date;
  // joined
  userName?: string;
  userEmail?: string;
}

export interface CreateActivityInput {
  userId?: number;
  action: string;
  entityType: string;
  entityId?: number;
  beforeData?: unknown;
  afterData?: unknown;
  ipAddress?: string;
}

export interface ListActivityFilter {
  userId?: number;
  entityType?: string;
  entityId?: number;
  action?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function log(data: CreateActivityInput): Promise<void> {
  await run(
    `INSERT INTO activity_logs
       (user_id, action, entity_type, entity_id, before_data, after_data, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      data.userId ?? null,
      data.action,
      data.entityType,
      data.entityId ?? null,
      data.beforeData ? JSON.stringify(data.beforeData) : null,
      data.afterData  ? JSON.stringify(data.afterData)  : null,
      data.ipAddress ?? null,
    ]
  );
}

export async function list(filter: ListActivityFilter = {}): Promise<ActivityLogRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.userId)     { clauses.push('al.user_id = ?');      params.push(filter.userId); }
  if (filter.entityType) { clauses.push('al.entity_type = ?');  params.push(filter.entityType); }
  if (filter.entityId)   { clauses.push('al.entity_id = ?');    params.push(filter.entityId); }
  if (filter.action)     { clauses.push('al.action LIKE ?');    params.push(`%${filter.action}%`); }
  if (filter.from)       { clauses.push('al.created_at >= ?');  params.push(filter.from); }
  if (filter.to)         { clauses.push('al.created_at <= ?');  params.push(filter.to); }

  const where  = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit  = filter.limit  ?? 50;
  const offset = filter.offset ?? 0;

  return q<ActivityLogRow>(
    `SELECT al.id, al.user_id AS userId, al.action,
            al.entity_type AS entityType, al.entity_id AS entityId,
            al.before_data AS beforeData, al.after_data AS afterData,
            al.ip_address AS ipAddress, al.created_at AS createdAt,
            u.name AS userName, u.email AS userEmail
     FROM activity_logs al LEFT JOIN users u ON al.user_id = u.id
     ${where} ORDER BY al.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
}

export async function count(filter: Omit<ListActivityFilter, 'limit' | 'offset'> = {}): Promise<number> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.userId)     { clauses.push('user_id = ?');      params.push(filter.userId); }
  if (filter.entityType) { clauses.push('entity_type = ?');  params.push(filter.entityType); }
  if (filter.entityId)   { clauses.push('entity_id = ?');    params.push(filter.entityId); }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows  = await q<RowDataPacket & { cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM activity_logs ${where}`,
    params
  );
  return rows[0]?.cnt ?? 0;
}
