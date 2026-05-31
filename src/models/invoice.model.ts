import { q, run } from '../lib/db';
import type { RowDataPacket } from 'mysql2';

// ─── Types ────────────────────────────────────────────────────────────────────

export type InvoiceStatus = 'DRAFT' | 'SENT' | 'PAID' | 'OVERDUE' | 'CANCELLED';

export interface InvoiceRow extends RowDataPacket {
  id: number;
  uuid: string;
  invoiceNumber: string;
  clientId: number;
  issueDate: Date;
  dueDate: Date;
  subtotal: number;
  gstRate: number;
  gstAmount: number;
  total: number;
  status: InvoiceStatus;
  paidAt: Date | null;
  pdfPath: string | null;
  notes: string | null;
  createdBy: number;
  createdAt: Date;
  updatedAt: Date;
  // joined
  clUuid?: string;
  companyName?: string;
  clEmail?: string;
  contactPerson?: string;
  address?: string;
  gstNumber?: string;
  itemCount?: number;
}

export interface InvoiceItemRow extends RowDataPacket {
  id: number;
  invoiceId: number;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface CreateInvoiceInput {
  invoiceNumber: string;
  clientId: number;
  issueDate: string;
  dueDate: string;
  subtotal: number;
  gstRate: number;
  gstAmount: number;
  total: number;
  notes?: string;
  createdBy: number;
}

export interface InvoiceItemInput {
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface UpdateInvoiceInput {
  issueDate?: string;
  dueDate?: string;
  subtotal?: number;
  gstRate?: number;
  gstAmount?: number;
  total?: number;
  status?: InvoiceStatus;
  notes?: string;
}

export interface ListInvoicesFilter {
  clientId?: number;
  status?: InvoiceStatus;
  search?: string;
  page?: number;
  limit?: number;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

const SELECT_INVOICE_LIST = `
  SELECT i.id, i.uuid, i.invoice_number AS invoiceNumber, i.client_id AS clientId,
         i.issue_date AS issueDate, i.due_date AS dueDate,
         i.subtotal, i.gst_rate AS gstRate, i.gst_amount AS gstAmount, i.total,
         i.status, i.paid_at AS paidAt, i.pdf_path AS pdfPath,
         i.notes, i.created_by AS createdBy, i.created_at AS createdAt,
         c.uuid AS clUuid, c.company_name AS companyName, c.email AS clEmail,
         (SELECT COUNT(*) FROM invoice_items ii WHERE ii.invoice_id = i.id) AS itemCount
  FROM invoices i JOIN clients c ON i.client_id = c.id
`;

const SELECT_INVOICE_DETAIL = `
  SELECT i.id, i.uuid, i.invoice_number AS invoiceNumber, i.client_id AS clientId,
         i.issue_date AS issueDate, i.due_date AS dueDate,
         i.subtotal, i.gst_rate AS gstRate, i.gst_amount AS gstAmount, i.total,
         i.status, i.paid_at AS paidAt, i.pdf_path AS pdfPath,
         i.notes, i.created_by AS createdBy, i.created_at AS createdAt,
         c.company_name AS companyName, c.contact_person AS contactPerson,
         c.email AS clEmail, c.address, c.gst_number AS gstNumber
  FROM invoices i JOIN clients c ON i.client_id = c.id
`;

export async function list(filter: ListInvoicesFilter = {}): Promise<InvoiceRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.clientId) { clauses.push('i.client_id = ?');               params.push(filter.clientId); }
  if (filter.status)   { clauses.push('i.status = ?');                  params.push(filter.status); }
  if (filter.search)   { clauses.push('(i.invoice_number LIKE ? OR c.company_name LIKE ?)'); params.push(`%${filter.search}%`, `%${filter.search}%`); }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const page  = filter.page  ?? 1;
  const limit = filter.limit ?? 20;
  const offset = (page - 1) * limit;

  return q<InvoiceRow>(
    `${SELECT_INVOICE_LIST} ${where} ORDER BY i.issue_date DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
}

export async function findById(id: number): Promise<InvoiceRow | null> {
  const rows = await q<InvoiceRow>(`${SELECT_INVOICE_DETAIL} WHERE i.id = ?`, [id]);
  return rows[0] ?? null;
}

export async function findStatusAndRate(id: number): Promise<RowDataPacket & { id: number; status: InvoiceStatus; gstRate: number } | null> {
  const rows = await q<RowDataPacket & { id: number; status: InvoiceStatus; gstRate: number }>(
    `SELECT id, status, gst_rate AS gstRate FROM invoices WHERE id = ?`,
    [id]
  );
  return rows[0] ?? null;
}

export async function findPdfPath(id: number): Promise<RowDataPacket & { id: number; pdfPath: string | null } | null> {
  const rows = await q<RowDataPacket & { id: number; pdfPath: string | null }>(
    `SELECT id, pdf_path AS pdfPath FROM invoices WHERE id = ?`,
    [id]
  );
  return rows[0] ?? null;
}

export async function lastInvoiceNumber(prefix: string): Promise<string | null> {
  const rows = await q<RowDataPacket & { invoiceNumber: string }>(
    `SELECT invoice_number AS invoiceNumber FROM invoices WHERE invoice_number LIKE ? ORDER BY invoice_number DESC LIMIT 1`,
    [`${prefix}%`]
  );
  return rows[0]?.invoiceNumber ?? null;
}

export async function create(data: CreateInvoiceInput): Promise<number> {
  const result = await run(
    `INSERT INTO invoices
       (invoice_number, client_id, issue_date, due_date, subtotal,
        gst_rate, gst_amount, total, status, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)`,
    [
      data.invoiceNumber, data.clientId, data.issueDate, data.dueDate,
      data.subtotal, data.gstRate, data.gstAmount, data.total,
      data.notes ?? null, data.createdBy,
    ]
  );
  return result.insertId;
}

export async function update(id: number, data: UpdateInvoiceInput): Promise<void> {
  const fieldMap: Record<string, string> = {
    issueDate:  'issue_date',
    dueDate:    'due_date',
    subtotal:   'subtotal',
    gstRate:    'gst_rate',
    gstAmount:  'gst_amount',
    total:      'total',
    status:     'status',
    notes:      'notes',
  };

  const fields: string[] = [];
  const params: unknown[] = [];

  for (const [key, col] of Object.entries(fieldMap)) {
    const val = (data as Record<string, unknown>)[key];
    if (val !== undefined) { fields.push(`${col} = ?`); params.push(val); }
  }

  if (!fields.length) return;
  params.push(id);
  await run(`UPDATE invoices SET ${fields.join(', ')} WHERE id = ?`, params);
}

export async function setSentWithPdf(id: number, pdfPath: string): Promise<void> {
  await run(`UPDATE invoices SET pdf_path = ?, status = 'SENT' WHERE id = ?`, [pdfPath, id]);
}

export async function markPaid(id: number): Promise<void> {
  await run(`UPDATE invoices SET status = 'PAID', paid_at = NOW() WHERE id = ?`, [id]);
}

export async function remove(id: number): Promise<void> {
  await run(`DELETE FROM invoices WHERE id = ?`, [id]);
}

// ─── Invoice Items ─────────────────────────────────────────────────────────

export async function listItems(invoiceId: number): Promise<InvoiceItemRow[]> {
  return q<InvoiceItemRow>(
    `SELECT id, invoice_id AS invoiceId, description, quantity, unit_price AS unitPrice, amount
     FROM invoice_items WHERE invoice_id = ?`,
    [invoiceId]
  );
}

export async function addItem(invoiceId: number, item: InvoiceItemInput): Promise<number> {
  const result = await run(
    `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount)
     VALUES (?, ?, ?, ?, ?)`,
    [invoiceId, item.description, item.quantity, item.unitPrice, item.amount]
  );
  return result.insertId;
}

export async function replaceItems(invoiceId: number, items: InvoiceItemInput[]): Promise<void> {
  await run(`DELETE FROM invoice_items WHERE invoice_id = ?`, [invoiceId]);
  for (const item of items) {
    await addItem(invoiceId, item);
  }
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export async function statusCounts(): Promise<Array<RowDataPacket & { status: InvoiceStatus; cnt: number }>> {
  return q(`SELECT status, COUNT(*) AS cnt FROM invoices GROUP BY status`);
}

export async function overdueCount(today: string): Promise<number> {
  const rows = await q<RowDataPacket & { cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM invoices WHERE status = 'SENT' AND due_date < ?`,
    [today]
  );
  return rows[0]?.cnt ?? 0;
}

export async function totalPaidRevenue(): Promise<number> {
  const rows = await q<RowDataPacket & { total: number }>(
    `SELECT COALESCE(SUM(total), 0) AS total FROM invoices WHERE status = 'PAID'`
  );
  return rows[0]?.total ?? 0;
}

export async function monthRevenue(prefix: string): Promise<number> {
  const rows = await q<RowDataPacket & { total: number }>(
    `SELECT COALESCE(SUM(total), 0) AS total FROM invoices WHERE issue_date LIKE ? AND status != 'CANCELLED'`,
    [`${prefix}%`]
  );
  return rows[0]?.total ?? 0;
}

export async function paidRevenueByMonth(prefix: string): Promise<number> {
  const rows = await q<RowDataPacket & { total: number }>(
    `SELECT COALESCE(SUM(total), 0) AS total FROM invoices WHERE status = 'PAID' AND issue_date LIKE ?`,
    [`${prefix}%`]
  );
  return rows[0]?.total ?? 0;
}
