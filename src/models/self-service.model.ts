// src/models/self-service.model.ts
import { q, run } from '../lib/db';
import type { RowDataPacket } from 'mysql2';

// ─── Types ────────────────────────────────────────────────────────────────────

export type RequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type PermissionStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';

export interface ChangeRequestRow extends RowDataPacket {
  id: number;
  uuid: string;
  employeeId: number;
  fieldName: string;
  fieldLabel: string;
  currentValue: string | null;
  requestedValue: string;
  newDocUrl: string | null;
  reason: string;
  status: RequestStatus;
  reviewedBy: number | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
  // Joined fields
  employeeName?: string;
  employeeCode?: string;
  reviewerName?: string;
}

// Kept for backward compat — no longer created for new approvals
export interface PermissionRow extends RowDataPacket {
  id: number;
  uuid: string;
  employeeId: number;
  fieldName: string;
  grantedBy: number;
  grantedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: number | null;
  changeRequestId: number | null;
  status: PermissionStatus;
  // Joined
  employeeName?: string;
  employeeCode?: string;
  granterName?: string;
}

// ─── RESTRICTED field definitions ─────────────────────────────────────────────
// These fields require admin approval. Employee submits new value/doc with request;
// admin validates old vs new and approves → change applied directly.

export const RESTRICTED_FIELDS: Record<string, {
  label: string;
  table: 'users' | 'employees' | 'employee_bank_details' | 'employee_documents';
  column: string;
  masked: boolean;
  multiUpload?: boolean; // if true, approval INSERTs a new record instead of upsert
}> = {
  name:             { label: 'Full Name',           table: 'users',      column: 'name',           masked: false },
  phone:            { label: 'Phone Number',        table: 'employees',  column: 'phone',          masked: false },
  personal_email:   { label: 'Personal Email',      table: 'employees',  column: 'personal_email', masked: false },
  official_email:   { label: 'Official Email',      table: 'employees',  column: 'official_email', masked: false },
  date_of_birth:    { label: 'Date of Birth',       table: 'employees',  column: 'date_of_birth',  masked: false },
  gender:           { label: 'Gender',              table: 'employees',  column: 'gender',         masked: false },
  blood_group:      { label: 'Blood Group',         table: 'employees',  column: 'blood_group',    masked: false },
  nationality:      { label: 'Nationality',         table: 'employees',  column: 'nationality',    masked: false },
  bank_account:     { label: 'Bank Account Number', table: 'employee_bank_details', column: 'account_number', masked: true  },
  bank_ifsc:        { label: 'Bank IFSC Code',      table: 'employee_bank_details', column: 'ifsc_code',      masked: false },
  bank_name:        { label: 'Bank Name',           table: 'employee_bank_details', column: 'bank_name',      masked: false },
  pan_number:       { label: 'PAN Number',          table: 'employee_bank_details', column: 'pan_number',     masked: true  },
  aadhaar_number:   { label: 'Aadhaar Number',      table: 'employee_bank_details', column: 'aadhaar_number', masked: true  },
  // ── Mandatory document slots ──────────────────────────────────────────────
  doc_aadhaar:         { label: 'Aadhaar Card',                        table: 'employee_documents', column: 'AADHAAR',           masked: false },
  doc_pan:             { label: 'PAN Card',                            table: 'employee_documents', column: 'PAN',               masked: false },
  doc_bank_passbook:   { label: 'Bank Passbook / Cancelled Cheque',    table: 'employee_documents', column: 'BANK_PASSBOOK',     masked: false },
  doc_education_cert:  { label: 'Highest Education Certificate',       table: 'employee_documents', column: 'EDUCATION_CERT',   masked: false },
  doc_resume:          { label: 'Resume',                              table: 'employee_documents', column: 'RESUME',            masked: false },
  // ── Optional document slots ───────────────────────────────────────────────
  doc_passport:         { label: 'Passport',               table: 'employee_documents', column: 'PASSPORT',         masked: false },
  doc_experience_cert:  { label: 'Experience Certificate',  table: 'employee_documents', column: 'EXPERIENCE_CERT',  masked: false },
  doc_last_payslips:    { label: 'Last 3 Payslips',          table: 'employee_documents', column: 'PAYSLIP',           masked: false, multiUpload: true },
  doc_relieving_letter: { label: 'Relieving Letter',         table: 'employee_documents', column: 'RELIEVING_LETTER',  masked: false },
  doc_skill_cert:       { label: 'Skill Certificates',       table: 'employee_documents', column: 'SKILL_CERT',        masked: false },
  // ── Legacy ────────────────────────────────────────────────────────────────
  doc_id_proof:         { label: 'ID Proof',                 table: 'employee_documents', column: 'ID_PROOF',          masked: false },
};

export function maskValue(value: string | null | undefined): string {
  if (!value) return '';
  if (value.length <= 4) return '****';
  return '****' + value.slice(-4);
}

// ─── Change Requests ──────────────────────────────────────────────────────────

const SEL_REQUEST = `
  SELECT r.id, r.uuid, r.employee_id AS employeeId,
         r.field_name AS fieldName, r.field_label AS fieldLabel,
         r.current_value AS currentValue, r.requested_value AS requestedValue,
         r.new_doc_url AS newDocUrl,
         r.reason, r.status, r.reviewed_by AS reviewedBy,
         r.review_note AS reviewNote, r.reviewed_at AS reviewedAt,
         r.created_at AS createdAt,
         u.name AS employeeName, e.employee_code AS employeeCode,
         rev.name AS reviewerName
  FROM employee_field_change_requests r
  JOIN employees e ON e.id = r.employee_id
  JOIN users u     ON u.id = e.user_id
  LEFT JOIN users rev ON rev.id = r.reviewed_by
`;

export async function createChangeRequest(data: {
  employeeId: number;
  fieldName: string;
  fieldLabel: string;
  currentValue: string | null;
  requestedValue: string;
  reason: string;
  newDocUrl?: string | null;
}): Promise<number> {
  const result = await run(
    `INSERT INTO employee_field_change_requests
       (employee_id, field_name, field_label, current_value, requested_value, new_doc_url, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [data.employeeId, data.fieldName, data.fieldLabel,
     data.currentValue ?? null, data.requestedValue, data.newDocUrl ?? null, data.reason]
  );
  return result.insertId;
}

export async function listRequestsForEmployee(employeeId: number): Promise<ChangeRequestRow[]> {
  return q<ChangeRequestRow>(
    `${SEL_REQUEST} WHERE r.employee_id = ? ORDER BY r.created_at DESC`,
    [employeeId]
  );
}

export async function listAllRequests(status?: RequestStatus): Promise<ChangeRequestRow[]> {
  const where = status ? 'WHERE r.status = ?' : '';
  const params = status ? [status] : [];
  return q<ChangeRequestRow>(`${SEL_REQUEST} ${where} ORDER BY r.created_at DESC`, params);
}

export async function findRequestById(id: number): Promise<ChangeRequestRow | null> {
  const rows = await q<ChangeRequestRow>(`${SEL_REQUEST} WHERE r.id = ?`, [id]);
  return rows[0] ?? null;
}

export async function updateRequestStatus(id: number, data: {
  status: RequestStatus;
  reviewedBy: number;
  reviewNote?: string;
}): Promise<void> {
  await run(
    `UPDATE employee_field_change_requests
     SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = NOW()
     WHERE id = ?`,
    [data.status, data.reviewedBy, data.reviewNote ?? null, id]
  );
}

// ─── Apply approved change directly to the employee's data ───────────────────
// Called by the admin approval endpoint instead of creating a permission window.

export async function applyApprovedChange(
  request: ChangeRequestRow,
  adminUserId: number
): Promise<void> {
  const fieldDef = RESTRICTED_FIELDS[request.fieldName];
  if (!fieldDef) return;

  if (fieldDef.table === 'employee_documents') {
    if (!request.newDocUrl) return;
    if (fieldDef.multiUpload) {
      // Multi-upload slots (e.g. Last 3 Payslips): always add a new record
      await run(
        `INSERT INTO employee_documents (employee_id, doc_type, name, file_path, uploaded_by, verification_status)
         VALUES (?, ?, ?, ?, ?, 'pending')`,
        [request.employeeId, fieldDef.column, fieldDef.label, request.newDocUrl, adminUserId]
      );
    } else {
      // Single-slot docs: replace file on the most recent record, delete any stale duplicates
      const existingRows = await q<RowDataPacket>(
        `SELECT id FROM employee_documents WHERE employee_id = ? AND name = ? ORDER BY created_at DESC`,
        [request.employeeId, fieldDef.label]
      );
      if (existingRows.length > 0) {
        const latestId = existingRows[0]['id'] as number;
        await run(
          `UPDATE employee_documents SET file_path = ?, verification_status = 'pending' WHERE id = ?`,
          [request.newDocUrl, latestId]
        );
        // Remove any duplicate records that accumulated from previous failed upserts
        if (existingRows.length > 1) {
          const dupeIds = existingRows.slice(1).map((r: RowDataPacket) => r['id'] as number);
          await run(
            `DELETE FROM employee_documents WHERE id IN (${dupeIds.map(() => '?').join(',')})`,
            dupeIds
          );
        }
      } else {
        await run(
          `INSERT INTO employee_documents (employee_id, doc_type, name, file_path, uploaded_by, verification_status)
           VALUES (?, ?, ?, ?, ?, 'pending')`,
          [request.employeeId, fieldDef.column, fieldDef.label, request.newDocUrl, adminUserId]
        );
      }
    }
    return;
  }

  if (fieldDef.table === 'users') {
    const rows = await q<RowDataPacket>('SELECT user_id FROM employees WHERE id = ?', [request.employeeId]);
    const userId = rows[0]?.['user_id'];
    if (userId) {
      await run(`UPDATE users SET ${fieldDef.column} = ? WHERE id = ?`, [request.requestedValue, userId]);
    }
    return;
  }

  if (fieldDef.table === 'employees') {
    await run(
      `UPDATE employees SET ${fieldDef.column} = ? WHERE id = ?`,
      [request.requestedValue, request.employeeId]
    );
    return;
  }

  if (fieldDef.table === 'employee_bank_details') {
    const existing = await q<RowDataPacket>(
      'SELECT id FROM employee_bank_details WHERE employee_id = ? LIMIT 1',
      [request.employeeId]
    );
    if (existing[0]) {
      await run(
        `UPDATE employee_bank_details SET ${fieldDef.column} = ? WHERE employee_id = ?`,
        [request.requestedValue, request.employeeId]
      );
    } else {
      await run(
        `INSERT INTO employee_bank_details (employee_id, ${fieldDef.column}) VALUES (?, ?)`,
        [request.employeeId, request.requestedValue]
      );
    }
  }
}

// ─── Permissions (kept for backward compat — no longer created for new approvals) ─

const SEL_PERM = `
  SELECT p.id, p.uuid, p.employee_id AS employeeId, p.field_name AS fieldName,
         p.granted_by AS grantedBy, p.granted_at AS grantedAt,
         p.expires_at AS expiresAt, p.revoked_at AS revokedAt,
         p.revoked_by AS revokedBy, p.change_request_id AS changeRequestId,
         p.status,
         u.name AS employeeName, e.employee_code AS employeeCode,
         g.name AS granterName
  FROM employee_field_permissions p
  JOIN employees e ON e.id = p.employee_id
  JOIN users u     ON u.id = e.user_id
  JOIN users g     ON g.id = p.granted_by
`;

export async function createPermission(data: {
  employeeId: number;
  fieldName: string;
  grantedBy: number;
  changeRequestId: number;
}): Promise<number> {
  const result = await run(
    `INSERT INTO employee_field_permissions
       (employee_id, field_name, granted_by, expires_at, change_request_id, status)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY), ?, 'ACTIVE')`,
    [data.employeeId, data.fieldName, data.grantedBy, data.changeRequestId]
  );
  return result.insertId;
}

export async function findActivePermission(employeeId: number, fieldName: string): Promise<PermissionRow | null> {
  const rows = await q<PermissionRow>(
    `${SEL_PERM}
     WHERE p.employee_id = ? AND p.field_name = ?
       AND p.status = 'ACTIVE'
       AND p.revoked_at IS NULL
       AND p.expires_at > NOW()
     ORDER BY p.granted_at DESC LIMIT 1`,
    [employeeId, fieldName]
  );
  return rows[0] ?? null;
}

export async function listActivePermissionsForEmployee(employeeId: number): Promise<PermissionRow[]> {
  return q<PermissionRow>(
    `${SEL_PERM}
     WHERE p.employee_id = ?
       AND p.status = 'ACTIVE'
       AND p.revoked_at IS NULL
       AND p.expires_at > NOW()
     ORDER BY p.granted_at DESC`,
    [employeeId]
  );
}

export async function listAllActivePermissions(): Promise<PermissionRow[]> {
  return q<PermissionRow>(
    `${SEL_PERM}
     WHERE p.status = 'ACTIVE'
       AND p.revoked_at IS NULL
       AND p.expires_at > NOW()
     ORDER BY p.granted_at DESC`
  );
}

export async function revokePermission(id: number, revokedBy: number): Promise<void> {
  await run(
    `UPDATE employee_field_permissions
     SET status = 'REVOKED', revoked_at = NOW(), revoked_by = ?
     WHERE id = ?`,
    [revokedBy, id]
  );
}

export async function findPermissionById(id: number): Promise<PermissionRow | null> {
  const rows = await q<PermissionRow>(`${SEL_PERM} WHERE p.id = ?`, [id]);
  return rows[0] ?? null;
}
