import { q, run } from '../lib/db';
import type { RowDataPacket } from 'mysql2';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TaskStatus   = 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE' | 'CANCELLED';
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export interface TaskRow extends RowDataPacket {
  id: number;
  uuid: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: Date | null;
  clientId: number | null;
  assignedToId: number | null;
  assignedById: number;
  parentTaskId: number | null;
  createdAt: Date;
  updatedAt: Date;
  // joined
  atId: number | null;
  atName: string | null;
  atAvatar: string | null;
  abId: number;
  abName: string;
  clId: number | null;
  clUuid: string | null;
  clCompany: string | null;
  commentCount: number;
}

export interface SubTaskRow extends RowDataPacket {
  id: number;
  uuid: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  atId: number | null;
  atName: string | null;
  atAvatar: string | null;
}

export interface CommentRow extends RowDataPacket {
  id: number;
  taskId: number;
  body: string;
  createdAt: Date;
  uId: number;
  uName: string;
  uAvatar: string | null;
}

export interface AttachmentRow extends RowDataPacket {
  id: number;
  taskId: number;
  filePath: string;
  fileName: string;
  uploadedBy: number;
  createdAt: Date;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string;
  clientId?: number;
  assignedToId?: number;
  assignedById: number;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string;
  clientId?: number;
  assignedToId?: number;
}

export interface ListTasksFilter {
  status?: TaskStatus;
  priority?: TaskPriority;
  clientId?: number;
  assignedToId?: number;
  assignedById?: number;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

const SELECT_TASK = `
  SELECT t.id, t.uuid, t.title, t.description, t.status, t.priority,
         t.due_date AS dueDate, t.client_id AS clientId,
         t.assigned_to_id AS assignedToId, t.assigned_by_id AS assignedById,
         t.parent_task_id AS parentTaskId,
         t.created_at AS createdAt, t.updated_at AS updatedAt,
         u1.id AS atId, u1.name AS atName, u1.avatar_url AS atAvatar,
         u2.id AS abId, u2.name AS abName,
         c.id AS clId, c.uuid AS clUuid, c.company_name AS clCompany,
         (SELECT COUNT(*) FROM task_comments tc WHERE tc.task_id = t.id) AS commentCount
  FROM tasks t
    LEFT JOIN users u1 ON t.assigned_to_id = u1.id
    LEFT JOIN users u2 ON t.assigned_by_id = u2.id
    LEFT JOIN clients c ON t.client_id = c.id
`;

export async function list(filter: ListTasksFilter = {}): Promise<TaskRow[]> {
  const clauses: string[] = ['t.parent_task_id IS NULL'];
  const params: unknown[] = [];

  if (filter.status)      { clauses.push('t.status = ?');         params.push(filter.status); }
  if (filter.priority)    { clauses.push('t.priority = ?');       params.push(filter.priority); }
  if (filter.clientId)    { clauses.push('t.client_id = ?');      params.push(filter.clientId); }
  if (filter.assignedToId){ clauses.push('t.assigned_to_id = ?'); params.push(filter.assignedToId); }
  if (filter.assignedById){ clauses.push('t.assigned_by_id = ?'); params.push(filter.assignedById); }

  const where = `WHERE ${clauses.join(' AND ')}`;
  return q<TaskRow>(`${SELECT_TASK} ${where} ORDER BY t.due_date ASC, t.created_at DESC`, params);
}

export async function findByUuid(uuid: string): Promise<RowDataPacket & {
  id: number; assignedToId: number | null; assignedById: number; status: TaskStatus; title: string;
} | null> {
  const rows = await q<RowDataPacket & { id: number; assignedToId: number | null; assignedById: number; status: TaskStatus; title: string }>(
    `SELECT id, assigned_to_id AS assignedToId, assigned_by_id AS assignedById, status, title
     FROM tasks WHERE uuid = ?`,
    [uuid]
  );
  return rows[0] ?? null;
}

export async function findById(id: number): Promise<RowDataPacket & { id: number } | null> {
  const rows = await q<RowDataPacket & { id: number }>(
    `SELECT id FROM tasks WHERE uuid = ? OR id = ?`,
    [id, id]
  );
  return rows[0] ?? null;
}

export async function findIdByUuid(uuid: string): Promise<number | null> {
  const rows = await q<RowDataPacket & { id: number }>(`SELECT id FROM tasks WHERE uuid = ?`, [uuid]);
  return rows[0]?.id ?? null;
}

export async function listSubTasks(parentId: number): Promise<SubTaskRow[]> {
  return q<SubTaskRow>(
    `SELECT t.id, t.uuid, t.title, t.status, t.priority,
            u1.id AS atId, u1.name AS atName, u1.avatar_url AS atAvatar
     FROM tasks t LEFT JOIN users u1 ON t.assigned_to_id = u1.id
     WHERE t.parent_task_id = ?`,
    [parentId]
  );
}

export async function create(data: CreateTaskInput): Promise<number> {
  const result = await run(
    `INSERT INTO tasks (title, description, status, priority, due_date, client_id, assigned_to_id, assigned_by_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.title, data.description ?? null,
      data.status ?? 'TODO', data.priority ?? 'MEDIUM',
      data.dueDate ?? null, data.clientId ?? null,
      data.assignedToId ?? null, data.assignedById,
    ]
  );
  return result.insertId;
}

export async function update(id: number, data: UpdateTaskInput): Promise<void> {
  const fieldMap: Record<string, string> = {
    title:        'title',
    description:  'description',
    status:       'status',
    priority:     'priority',
    dueDate:      'due_date',
    clientId:     'client_id',
    assignedToId: 'assigned_to_id',
  };

  const fields: string[] = [];
  const params: unknown[] = [];

  for (const [key, col] of Object.entries(fieldMap)) {
    const val = (data as Record<string, unknown>)[key];
    if (val !== undefined) { fields.push(`${col} = ?`); params.push(val); }
  }

  if (!fields.length) return;
  params.push(id);
  await run(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`, params);
}

export async function setStatus(id: number, status: TaskStatus): Promise<void> {
  await run(`UPDATE tasks SET status = ? WHERE id = ?`, [status, id]);
}

export async function remove(id: number): Promise<void> {
  await run(`DELETE FROM tasks WHERE id = ?`, [id]);
}

export async function statusCounts(): Promise<Array<RowDataPacket & { status: TaskStatus; cnt: number }>> {
  return q(`SELECT status, COUNT(*) AS cnt FROM tasks WHERE parent_task_id IS NULL GROUP BY status`);
}

// ─── Comments ─────────────────────────────────────────────────────────────────

export async function listComments(taskId: number): Promise<CommentRow[]> {
  return q<CommentRow>(
    `SELECT tc.id, tc.task_id AS taskId, tc.body, tc.created_at AS createdAt,
            u.id AS uId, u.name AS uName, u.avatar_url AS uAvatar
     FROM task_comments tc JOIN users u ON tc.user_id = u.id
     WHERE tc.task_id = ? ORDER BY tc.created_at ASC`,
    [taskId]
  );
}

export async function findCommentById(id: number): Promise<CommentRow | null> {
  const rows = await q<CommentRow>(
    `SELECT tc.id, tc.task_id AS taskId, tc.body, tc.created_at AS createdAt,
            u.id AS uId, u.name AS uName, u.avatar_url AS uAvatar
     FROM task_comments tc JOIN users u ON tc.user_id = u.id WHERE tc.id = ?`,
    [id]
  );
  return rows[0] ?? null;
}

export async function findCommentOwner(id: number): Promise<RowDataPacket & { id: number; userId: number } | null> {
  const rows = await q<RowDataPacket & { id: number; userId: number }>(
    `SELECT id, user_id AS userId FROM task_comments WHERE id = ?`,
    [id]
  );
  return rows[0] ?? null;
}

export async function addComment(taskId: number, userId: number, body: string): Promise<number> {
  const result = await run(
    `INSERT INTO task_comments (task_id, user_id, body) VALUES (?, ?, ?)`,
    [taskId, userId, body]
  );
  return result.insertId;
}

export async function deleteComment(id: number): Promise<void> {
  await run(`DELETE FROM task_comments WHERE id = ?`, [id]);
}

// ─── Attachments ──────────────────────────────────────────────────────────────

export async function listAttachments(taskId: number): Promise<AttachmentRow[]> {
  return q<AttachmentRow>(
    `SELECT id, task_id AS taskId, file_path AS filePath, file_name AS fileName,
            uploaded_by AS uploadedBy, created_at AS createdAt
     FROM task_attachments WHERE task_id = ? ORDER BY created_at DESC`,
    [taskId]
  );
}

export async function findAttachmentById(id: number): Promise<RowDataPacket & { id: number; filePath: string; uploadedBy: number } | null> {
  const rows = await q<RowDataPacket & { id: number; filePath: string; uploadedBy: number }>(
    `SELECT id, file_path AS filePath, uploaded_by AS uploadedBy FROM task_attachments WHERE id = ?`,
    [id]
  );
  return rows[0] ?? null;
}

export async function addAttachment(data: {
  taskId: number;
  filePath: string;
  fileName: string;
  uploadedBy: number;
}): Promise<number> {
  const result = await run(
    `INSERT INTO task_attachments (task_id, file_path, file_name, uploaded_by) VALUES (?, ?, ?, ?)`,
    [data.taskId, data.filePath, data.fileName, data.uploadedBy]
  );
  return result.insertId;
}

export async function deleteAttachment(id: number): Promise<void> {
  await run(`DELETE FROM task_attachments WHERE id = ?`, [id]);
}
