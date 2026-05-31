import { q, run } from '../lib/db';
import type { RowDataPacket } from 'mysql2';

// ─── Types ────────────────────────────────────────────────────────────────────

export type NotifType = 'LEAVE_REQUEST' | 'TASK_DUE' | 'RENEWAL' | 'INVOICE_DUE' | 'PAYROLL' | 'GENERAL';

export interface NotificationRow extends RowDataPacket {
  id: number;
  userId: number;
  type: NotifType;
  title: string;
  body: string | null;
  link: string | null;
  isRead: number;
  createdAt: Date;
}

export interface CreateNotificationInput {
  userId: number;
  type: NotifType;
  title: string;
  body?: string;
  link?: string;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function create(data: CreateNotificationInput): Promise<number> {
  const result = await run(
    `INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)`,
    [data.userId, data.type, data.title, data.body ?? null, data.link ?? null]
  );
  return result.insertId;
}

export async function createMany(items: CreateNotificationInput[]): Promise<void> {
  for (const item of items) {
    await create(item);
  }
}

export async function listForUser(userId: number, unreadOnly = false): Promise<NotificationRow[]> {
  const where = unreadOnly ? 'WHERE user_id = ? AND is_read = 0' : 'WHERE user_id = ?';
  return q<NotificationRow>(
    `SELECT id, user_id AS userId, type, title, body, link, is_read AS isRead, created_at AS createdAt
     FROM notifications ${where} ORDER BY created_at DESC`,
    [userId]
  );
}

export async function unreadCount(userId: number): Promise<number> {
  const rows = await q<RowDataPacket & { cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = ? AND is_read = 0`,
    [userId]
  );
  return rows[0]?.cnt ?? 0;
}

export async function markRead(id: number, userId: number): Promise<void> {
  await run(`UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`, [id, userId]);
}

export async function markAllRead(userId: number): Promise<void> {
  await run(`UPDATE notifications SET is_read = 1 WHERE user_id = ?`, [userId]);
}
