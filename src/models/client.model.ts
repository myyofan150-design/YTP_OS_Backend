import { q, run } from '../lib/db';
import type { RowDataPacket } from 'mysql2';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ClientStatus   = 'ACTIVE' | 'PROSPECT' | 'CHURNED' | 'PAUSED';
export type ContractType   = 'MONTHLY' | 'ANNUAL' | 'PROJECT';

export interface ClientRow extends RowDataPacket {
  id: number;
  uuid: string;
  companyName: string;
  contactPerson: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  gstNumber: string | null;
  status: ClientStatus;
  contractType: ContractType;
  monthlyFee: number | null;
  contractStart: Date | null;
  contractEnd: Date | null;
  services: unknown;
  notes: string | null;
  assignedTo: number | null;
  createdBy: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CredentialRow extends RowDataPacket {
  id: number;
  clientId: number;
  platform: string;
  username: string | null;
  passwordEncrypted: string | null;
  url: string | null;
  notes: string | null;
  createdAt: Date;
}

export interface ClientDocumentRow extends RowDataPacket {
  id: number;
  clientId: number;
  name: string;
  filePath: string;
  fileType: string;
  uploadedBy: number;
  createdAt: Date;
}

export interface CreateClientInput {
  companyName: string;
  contactPerson: string;
  email?: string;
  phone?: string;
  address?: string;
  gstNumber?: string;
  status?: ClientStatus;
  contractType?: ContractType;
  monthlyFee?: number;
  contractStart?: string;
  contractEnd?: string;
  services?: unknown;
  notes?: string;
  assignedTo?: number;
  createdBy: number;
}

export interface UpdateClientInput {
  companyName?: string;
  contactPerson?: string;
  email?: string;
  phone?: string;
  address?: string;
  gstNumber?: string;
  status?: ClientStatus;
  contractType?: ContractType;
  monthlyFee?: number;
  contractStart?: string;
  contractEnd?: string;
  services?: unknown;
  notes?: string;
  assignedTo?: number;
}

export interface ListClientsFilter {
  status?: ClientStatus;
  search?: string;
  assignedTo?: number;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

const SELECT_CLIENT = `
  SELECT id, uuid, company_name AS companyName, contact_person AS contactPerson,
         email, phone, address, gst_number AS gstNumber, status,
         contract_type AS contractType, monthly_fee AS monthlyFee,
         contract_start AS contractStart, contract_end AS contractEnd,
         services, notes, assigned_to AS assignedTo, created_by AS createdBy,
         created_at AS createdAt, updated_at AS updatedAt
  FROM clients
`;

export async function list(filter: ListClientsFilter = {}): Promise<ClientRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.status)     { clauses.push('status = ?');               params.push(filter.status); }
  if (filter.assignedTo) { clauses.push('assigned_to = ?');          params.push(filter.assignedTo); }
  if (filter.search)     { clauses.push('company_name LIKE ?');      params.push(`%${filter.search}%`); }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return q<ClientRow>(`${SELECT_CLIENT} ${where} ORDER BY company_name ASC`, params);
}

export async function findByUuid(uuid: string): Promise<ClientRow | null> {
  const rows = await q<ClientRow>(`${SELECT_CLIENT} WHERE uuid = ?`, [uuid]);
  return rows[0] ?? null;
}

export async function findById(id: number): Promise<ClientRow | null> {
  const rows = await q<ClientRow>(`${SELECT_CLIENT} WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

export async function findContactById(id: number): Promise<RowDataPacket & { companyName: string; contactPerson: string; email: string | null; address: string | null; gstNumber: string | null } | null> {
  const rows = await q<RowDataPacket & { companyName: string; contactPerson: string; email: string | null; address: string | null; gstNumber: string | null }>(
    `SELECT id, company_name AS companyName, contact_person AS contactPerson,
            email, address, gst_number AS gstNumber
     FROM clients WHERE id = ?`,
    [id]
  );
  return rows[0] ?? null;
}

export async function upcomingRenewals(from: string, to: string): Promise<ClientRow[]> {
  return q<ClientRow>(
    `${SELECT_CLIENT}
     WHERE contract_end >= ? AND contract_end <= ? AND status != 'CHURNED'
     ORDER BY contract_end ASC`,
    [from, to]
  );
}

export async function activeRenewals(from: string, to: string): Promise<Array<RowDataPacket & { id: number; uuid: string; companyName: string; contractEnd: Date }>> {
  return q(
    `SELECT id, uuid, company_name AS companyName, contract_end AS contractEnd
     FROM clients WHERE contract_end >= ? AND contract_end <= ? AND status = 'ACTIVE'
     ORDER BY contract_end ASC LIMIT 10`,
    [from, to]
  );
}

export async function create(data: CreateClientInput): Promise<number> {
  const result = await run(
    `INSERT INTO clients
       (company_name, contact_person, email, phone, address, gst_number,
        status, contract_type, monthly_fee, contract_start, contract_end,
        services, notes, assigned_to, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.companyName, data.contactPerson, data.email ?? null, data.phone ?? null,
      data.address ?? null, data.gstNumber ?? null,
      data.status ?? 'PROSPECT', data.contractType ?? 'MONTHLY',
      data.monthlyFee ?? null, data.contractStart ?? null, data.contractEnd ?? null,
      data.services ? JSON.stringify(data.services) : null,
      data.notes ?? null, data.assignedTo ?? null, data.createdBy,
    ]
  );
  return result.insertId;
}

export async function update(id: number, data: UpdateClientInput): Promise<void> {
  const fieldMap: Record<string, string> = {
    companyName: 'company_name',   contactPerson: 'contact_person',
    email: 'email',                phone: 'phone',
    address: 'address',            gstNumber: 'gst_number',
    status: 'status',              contractType: 'contract_type',
    monthlyFee: 'monthly_fee',     contractStart: 'contract_start',
    contractEnd: 'contract_end',   notes: 'notes',
    assignedTo: 'assigned_to',
  };

  const fields: string[] = [];
  const params: unknown[] = [];

  for (const [key, col] of Object.entries(fieldMap)) {
    const val = (data as Record<string, unknown>)[key];
    if (val !== undefined) {
      fields.push(`${col} = ?`);
      params.push(key === 'services' ? JSON.stringify(val) : val);
    }
  }
  if (data.services !== undefined) {
    fields.push('services = ?');
    params.push(JSON.stringify(data.services));
  }

  if (!fields.length) return;
  params.push(id);
  await run(`UPDATE clients SET ${fields.join(', ')} WHERE id = ?`, params);
}

export async function churn(id: number): Promise<void> {
  await run(`UPDATE clients SET status = 'CHURNED' WHERE id = ?`, [id]);
}

// ─── Credentials ──────────────────────────────────────────────────────────────

export async function listCredentials(clientId: number): Promise<CredentialRow[]> {
  return q<CredentialRow>(
    `SELECT id, client_id AS clientId, platform, username,
            password AS passwordEncrypted, url, notes, created_at AS createdAt
     FROM client_credentials WHERE client_id = ?`,
    [clientId]
  );
}

export async function addCredential(clientId: number, data: {
  platform: string;
  username?: string;
  passwordEncrypted?: string;
  url?: string;
  notes?: string;
}): Promise<number> {
  const result = await run(
    `INSERT INTO client_credentials (client_id, platform, username, password, url, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [clientId, data.platform, data.username ?? null, data.passwordEncrypted ?? null, data.url ?? null, data.notes ?? null]
  );
  return result.insertId;
}

export async function deleteCredential(id: number): Promise<void> {
  await run(`DELETE FROM client_credentials WHERE id = ?`, [id]);
}

// ─── Documents ────────────────────────────────────────────────────────────────

export async function listDocuments(clientId: number): Promise<ClientDocumentRow[]> {
  return q<ClientDocumentRow>(
    `SELECT id, client_id AS clientId, name, file_path AS filePath,
            file_type AS fileType, uploaded_by AS uploadedBy, created_at AS createdAt
     FROM client_documents WHERE client_id = ?`,
    [clientId]
  );
}

export async function addDocument(data: {
  clientId: number;
  name: string;
  filePath: string;
  fileType: string;
  uploadedBy: number;
}): Promise<number> {
  const result = await run(
    `INSERT INTO client_documents (client_id, name, file_path, file_type, uploaded_by)
     VALUES (?, ?, ?, ?, ?)`,
    [data.clientId, data.name, data.filePath, data.fileType, data.uploadedBy]
  );
  return result.insertId;
}

export async function findDocumentById(id: number): Promise<RowDataPacket & { id: number; filePath: string } | null> {
  const rows = await q<RowDataPacket & { id: number; filePath: string }>(
    `SELECT id, file_path AS filePath FROM client_documents WHERE id = ?`,
    [id]
  );
  return rows[0] ?? null;
}

export async function deleteDocument(id: number): Promise<void> {
  await run(`DELETE FROM client_documents WHERE id = ?`, [id]);
}

// ─── Task snippet (for client detail page) ────────────────────────────────────

export async function activeTaskCount(clientIds: number[]): Promise<Array<RowDataPacket & { clientId: number; cnt: number }>> {
  if (!clientIds.length) return [];
  const placeholders = clientIds.map(() => '?').join(',');
  return q(
    `SELECT client_id AS clientId, COUNT(*) AS cnt FROM tasks
     WHERE client_id IN (${placeholders})
       AND status IN ('TODO','IN_PROGRESS','IN_REVIEW')
       AND parent_task_id IS NULL
     GROUP BY client_id`,
    clientIds
  );
}

export async function recentTasks(clientId: number): Promise<RowDataPacket[]> {
  return q(
    `SELECT t.id, t.uuid, t.title, t.status, t.priority,
            t.due_date AS dueDate, t.created_at AS createdAt,
            u.id AS assignedToId, u.name AS assignedToName
     FROM tasks t LEFT JOIN users u ON t.assigned_to_id = u.id
     WHERE t.client_id = ? ORDER BY t.created_at DESC LIMIT 5`,
    [clientId]
  );
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export async function statusCounts(): Promise<Array<RowDataPacket & { status: ClientStatus; cnt: number }>> {
  return q(`SELECT status, COUNT(*) AS cnt FROM clients GROUP BY status`);
}
