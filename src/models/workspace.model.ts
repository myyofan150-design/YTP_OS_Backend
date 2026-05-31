import { q, run } from '../lib/db';
import type { RowDataPacket } from 'mysql2';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PropType = 'TEXT' | 'NUMBER' | 'DATE' | 'SELECT' | 'MULTI_SELECT' | 'URL' | 'EMAIL' | 'CHECKBOX' | 'FILE';

export interface WorkspaceRow extends RowDataPacket {
  id: number;
  uuid: string;
  name: string;
  icon: string | null;
  color: string | null;
  createdBy: number;
  createdAt: Date;
  propCount?: number;
  entryCount?: number;
}

export interface PropertyRow extends RowDataPacket {
  id: number;
  workspaceId: number;
  name: string;
  type: PropType;
  options: unknown;
  isRequired: number;
  sortOrder: number;
}

export interface EntryRow extends RowDataPacket {
  id: number;
  uuid: string;
  workspaceId: number;
  title: string;
  data: unknown;
  createdBy: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWorkspaceInput {
  name: string;
  icon?: string;
  color?: string;
  createdBy: number;
}

export interface CreatePropertyInput {
  workspaceId: number;
  name: string;
  type: PropType;
  options?: unknown;
  isRequired?: boolean;
  sortOrder?: number;
}

export interface CreateEntryInput {
  workspaceId: number;
  title: string;
  data: Record<string, unknown>;
  createdBy: number;
}

export interface UpdateEntryInput {
  title?: string;
  data?: Record<string, unknown>;
}

// ─── Workspace ────────────────────────────────────────────────────────────────

export async function list(): Promise<WorkspaceRow[]> {
  return q<WorkspaceRow>(
    `SELECT w.id, w.uuid, w.name, w.icon, w.color, w.created_by AS createdBy, w.created_at AS createdAt,
            (SELECT COUNT(*) FROM workspace_properties wp WHERE wp.workspace_id = w.id) AS propCount,
            (SELECT COUNT(*) FROM workspace_entries   we WHERE we.workspace_id  = w.id) AS entryCount
     FROM workspaces w ORDER BY w.created_at ASC`
  );
}

export async function findById(id: number): Promise<WorkspaceRow | null> {
  const rows = await q<WorkspaceRow>(
    `SELECT id, uuid, name, icon, color, created_by AS createdBy, created_at AS createdAt
     FROM workspaces WHERE id = ?`,
    [id]
  );
  return rows[0] ?? null;
}

export async function findByUuid(uuid: string): Promise<WorkspaceRow | null> {
  const rows = await q<WorkspaceRow>(
    `SELECT id, uuid, name, icon, color, created_by AS createdBy, created_at AS createdAt
     FROM workspaces WHERE uuid = ?`,
    [uuid]
  );
  return rows[0] ?? null;
}

export async function create(data: CreateWorkspaceInput): Promise<number> {
  const result = await run(
    `INSERT INTO workspaces (name, icon, color, created_by) VALUES (?, ?, ?, ?)`,
    [data.name, data.icon ?? null, data.color ?? null, data.createdBy]
  );
  return result.insertId;
}

// ─── Properties ───────────────────────────────────────────────────────────────

export async function listProperties(workspaceId: number): Promise<PropertyRow[]> {
  return q<PropertyRow>(
    `SELECT id, workspace_id AS workspaceId, name, type, options,
            is_required AS isRequired, sort_order AS sortOrder
     FROM workspace_properties WHERE workspace_id = ? ORDER BY sort_order ASC`,
    [workspaceId]
  );
}

export async function findPropertyById(id: number): Promise<PropertyRow | null> {
  const rows = await q<PropertyRow>(
    `SELECT id, workspace_id AS workspaceId, name, type, options,
            is_required AS isRequired, sort_order AS sortOrder
     FROM workspace_properties WHERE id = ?`,
    [id]
  );
  return rows[0] ?? null;
}

export async function propertyBelongsTo(propertyId: number, workspaceId: number): Promise<boolean> {
  const rows = await q<RowDataPacket>(
    `SELECT id FROM workspace_properties WHERE id = ? AND workspace_id = ?`,
    [propertyId, workspaceId]
  );
  return rows.length > 0;
}

export async function requiredProperties(workspaceId: number): Promise<Array<RowDataPacket & { id: number; name: string; isRequired: number }>> {
  return q(
    `SELECT id, name, is_required AS isRequired FROM workspace_properties WHERE workspace_id = ?`,
    [workspaceId]
  );
}

export async function addProperty(data: CreatePropertyInput): Promise<number> {
  const result = await run(
    `INSERT INTO workspace_properties (workspace_id, name, type, options, is_required, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      data.workspaceId, data.name, data.type,
      data.options ? JSON.stringify(data.options) : null,
      data.isRequired ? 1 : 0,
      data.sortOrder ?? 0,
    ]
  );
  return result.insertId;
}

export async function deleteProperty(id: number): Promise<void> {
  await run(`DELETE FROM workspace_properties WHERE id = ?`, [id]);
}

// ─── Entries ──────────────────────────────────────────────────────────────────

export async function listEntries(workspaceId: number): Promise<EntryRow[]> {
  return q<EntryRow>(
    `SELECT id, uuid, workspace_id AS workspaceId, title, data,
            created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt
     FROM workspace_entries WHERE workspace_id = ? ORDER BY created_at DESC`,
    [workspaceId]
  );
}

export async function findEntryById(id: number): Promise<EntryRow | null> {
  const rows = await q<EntryRow>(
    `SELECT id, uuid, workspace_id AS workspaceId, title, data,
            created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt
     FROM workspace_entries WHERE id = ?`,
    [id]
  );
  return rows[0] ?? null;
}

export async function findEntryByUuid(uuid: string, workspaceId: number): Promise<RowDataPacket & { id: number; createdBy: number } | null> {
  const rows = await q<RowDataPacket & { id: number; createdBy: number }>(
    `SELECT id, created_by AS createdBy FROM workspace_entries WHERE uuid = ? AND workspace_id = ?`,
    [uuid, workspaceId]
  );
  return rows[0] ?? null;
}

export async function createEntry(data: CreateEntryInput): Promise<number> {
  const result = await run(
    `INSERT INTO workspace_entries (workspace_id, title, data, created_by) VALUES (?, ?, ?, ?)`,
    [data.workspaceId, data.title, JSON.stringify(data.data), data.createdBy]
  );
  return result.insertId;
}

export async function updateEntry(id: number, data: UpdateEntryInput): Promise<void> {
  const fields: string[] = [];
  const params: unknown[] = [];

  if (data.title !== undefined) { fields.push('title = ?'); params.push(data.title); }
  if (data.data  !== undefined) { fields.push('data = ?');  params.push(JSON.stringify(data.data)); }

  if (!fields.length) return;
  params.push(id);
  await run(`UPDATE workspace_entries SET ${fields.join(', ')} WHERE id = ?`, params);
}

export async function deleteEntry(id: number): Promise<void> {
  await run(`DELETE FROM workspace_entries WHERE id = ?`, [id]);
}
