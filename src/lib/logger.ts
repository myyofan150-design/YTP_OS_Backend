// src/lib/logger.ts — writes activity logs using raw mysql2
import { pool } from "./db";

export async function logActivity(
  userId: number | null,
  action: string,
  entityType: string,
  entityId?: number,
  before?: object,
  after?: object,
  ipAddress?: string
): Promise<void> {
  try {
    await pool.execute(
      `INSERT INTO activity_logs (user_id, action, entity_type, entity_id, before_data, after_data, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId ?? null,
        action,
        entityType,
        entityId ?? null,
        before ? JSON.stringify(before) : null,
        after  ? JSON.stringify(after)  : null,
        ipAddress ?? null,
      ]
    );
  } catch (err) {
    console.error("[ActivityLog] Failed to write log:", err);
  }
}
