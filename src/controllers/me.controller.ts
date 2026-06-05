// src/controllers/me.controller.ts
// Employee self-service endpoints. All routes require authenticate().

import { Request, Response } from 'express';
import { q, run } from '../lib/db';
import type { RowDataPacket } from 'mysql2';
import { logActivity } from '../lib/logger';
import * as notif from '../models/notification.model';
import * as ss from '../models/self-service.model';
import { uploadFile } from '../lib/storage';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getEmployeeIdForUser(userId: number): Promise<number | null> {
  const rows = await q<RowDataPacket>('SELECT id FROM employees WHERE user_id = ?', [userId]);
  return rows[0]?.id ?? null;
}

async function getAdminUserIds(): Promise<number[]> {
  const rows = await q<RowDataPacket>(
    `SELECT id FROM users WHERE role IN ('SUPER_ADMIN','ADMIN','HR') AND status = 'ACTIVE'`
  );
  return rows.map(r => r['id'] as number);
}

async function notifyAdmins(data: { title: string; body: string; link?: string }): Promise<void> {
  const ids = await getAdminUserIds();
  await notif.createMany(ids.map(id => ({
    userId: id, type: 'GENERAL' as const,
    title: data.title, body: data.body, link: data.link,
  })));
}

// ─── GET /api/me ─────────────────────────────────────────────────────────────

export async function getMyProfile(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;

    // ── 1. Base query — only guaranteed columns from schema.sql ──────────────
    const baseRows = await q<RowDataPacket>(
      `SELECT u.id AS userId, u.uuid AS userUuid, u.name, u.email,
              u.role, u.status, u.avatar_url AS avatarUrl,
              e.id AS empId, e.uuid AS empUuid,
              e.employee_code AS employeeCode,
              e.department, e.designation,
              e.joining_date AS joiningDate,
              e.shift_start AS shiftStart,
              e.shift_end AS shiftEnd,
              e.status AS empStatus,
              e.bank_name AS legacyBankName,
              e.bank_account AS legacyBankAccount,
              e.bank_ifsc AS legacyBankIfsc,
              e.pan_number AS legacyPanNumber,
              e.emergency_contact AS legacyEmergencyContact,
              e.emergency_phone AS legacyEmergencyPhone
       FROM users u
       JOIN employees e ON e.user_id = u.id
       WHERE u.id = ?`,
      [userId]
    );

    if (!baseRows[0]) {
      res.status(404).json({
        success: false,
        message: 'No employee record found for your account. Please contact HR to set up your employee profile.',
      });
      return;
    }

    const base = baseRows[0];
    const empId: number = base['empId'];

    // ── 2. Enhanced employee columns (from employees_enhancement.sql) ────────
    // Wrapped in try-catch: silently falls back to nulls if migration not run yet.
    let enhanced: Record<string, unknown> = {};
    try {
      const enhRows = await q<RowDataPacket>(
        `SELECT phone, personal_email AS personalEmail,
                official_email AS officialEmail,
                date_of_birth AS dateOfBirth, gender,
                marital_status AS maritalStatus, nationality,
                blood_group AS bloodGroup, work_mode AS workMode,
                work_location AS workLocation,
                education_qualification AS educationQualification,
                COALESCE(photo_url, ?) AS photoUrl
         FROM employees WHERE id = ?`,
        [base['avatarUrl'] ?? null, empId]
      );
      if (enhRows[0]) enhanced = enhRows[0] as Record<string, unknown>;
    } catch { /* enhancement migration not yet run */ }

    // ── 3. Address (employee_addresses table) ────────────────────────────────
    let address: Record<string, unknown> | null = null;
    try {
      const addrRows = await q<RowDataPacket>(
        `SELECT flat_door AS flatDoor, street, city,
                pin_code AS pinCode, state, country
         FROM employee_addresses WHERE employee_id = ? LIMIT 1`,
        [empId]
      );
      address = addrRows[0] ?? null;
    } catch { /* table not yet created */ }

    // ── 4. Emergency contacts (employee_emergency_contacts table) ────────────
    let emergencyContacts: RowDataPacket[] = [];
    try {
      emergencyContacts = await q<RowDataPacket>(
        `SELECT id, name, relationship, phone, email
         FROM employee_emergency_contacts
         WHERE employee_id = ? ORDER BY contact_order ASC`,
        [empId]
      );
    } catch {
      // Fallback to legacy single emergency contact in employees table
      if (base['legacyEmergencyContact']) {
        emergencyContacts = [{
          id: 0, name: base['legacyEmergencyContact'],
          relationship: null, phone: base['legacyEmergencyPhone'], email: null,
        } as unknown as RowDataPacket];
      }
    }

    // ── 5. Bank details (employee_bank_details table, then legacy fallback) ──
    let bankDetails: Record<string, unknown> | null = null;
    try {
      const bankRows = await q<RowDataPacket>(
        `SELECT bank_name AS bankName,
                account_number AS accountNumber,
                account_holder_name AS accountHolderName,
                ifsc_code AS ifscCode,
                pan_number AS panNumber,
                aadhaar_number AS aadhaarNumber
         FROM employee_bank_details WHERE employee_id = ? LIMIT 1`,
        [empId]
      );
      if (bankRows[0]) {
        const b = bankRows[0];
        bankDetails = {
          bankName:            b['bankName'] ?? base['legacyBankName'],
          accountNumberMasked: ss.maskValue(b['accountNumber'] as string ?? base['legacyBankAccount'] as string),
          accountHolderName:   b['accountHolderName'],
          ifscCode:            b['ifscCode'] ?? base['legacyBankIfsc'],
          panNumberMasked:     ss.maskValue(b['panNumber'] as string ?? base['legacyPanNumber'] as string),
          aadhaarNumberMasked: ss.maskValue(b['aadhaarNumber'] as string),
        };
      } else if (base['legacyBankName'] || base['legacyBankAccount']) {
        bankDetails = {
          bankName:            base['legacyBankName'],
          accountNumberMasked: ss.maskValue(base['legacyBankAccount'] as string),
          accountHolderName:   null,
          ifscCode:            base['legacyBankIfsc'],
          panNumberMasked:     ss.maskValue(base['legacyPanNumber'] as string),
          aadhaarNumberMasked: '',
        };
      }
    } catch {
      // Fall back to legacy columns in employees table
      if (base['legacyBankName'] || base['legacyBankAccount']) {
        bankDetails = {
          bankName:            base['legacyBankName'],
          accountNumberMasked: ss.maskValue(base['legacyBankAccount'] as string),
          accountHolderName:   null,
          ifscCode:            base['legacyBankIfsc'],
          panNumberMasked:     ss.maskValue(base['legacyPanNumber'] as string),
          aadhaarNumberMasked: '',
        };
      }
    }

    // ── 6. Leave balance (current year) ──────────────────────────────────────
    let leaveBalance: RowDataPacket | null = null;
    try {
      const year = new Date().getFullYear();
      const lbRows = await q<RowDataPacket>(
        `SELECT casual_total AS casualTotal, casual_used AS casualUsed,
                sick_total AS sickTotal, sick_used AS sickUsed,
                paid_total AS paidTotal, paid_used AS paidUsed,
                comp_off AS compOff
         FROM leave_balances WHERE employee_id = ? AND year = ?`,
        [empId, year]
      );
      leaveBalance = lbRows[0] ?? null;
    } catch { /* non-fatal */ }

    // ── 7. Active permissions for this employee ───────────────────────────────
    let activePermissions: ss.PermissionRow[] = [];
    try {
      activePermissions = await ss.listActivePermissionsForEmployee(empId);
    } catch { /* tables not yet created */ }

    // ── 8. Pending change request count ──────────────────────────────────────
    let pendingRequestCount = 0;
    try {
      const reqRows = await q<RowDataPacket>(
        `SELECT COUNT(*) AS cnt FROM employee_field_change_requests
         WHERE employee_id = ? AND status = 'PENDING'`,
        [empId]
      );
      pendingRequestCount = reqRows[0]?.['cnt'] ?? 0;
    } catch { /* tables not yet created */ }

    res.json({
      success: true,
      message: 'OK',
      data: {
        user: {
          id:        base['userId'],
          uuid:      base['userUuid'],
          name:      base['name'],
          email:     base['email'],
          role:      base['role'],
          status:    base['status'],
          avatarUrl: base['avatarUrl'],
        },
        employee: {
          id:            empId,
          uuid:          base['empUuid'],
          employeeCode:  base['employeeCode'],
          department:    base['department'],
          designation:   base['designation'],
          joiningDate:   base['joiningDate'],
          shiftStart:    base['shiftStart'],
          shiftEnd:      base['shiftEnd'],
          status:        base['empStatus'],
          // Enhanced fields (null if migration not yet run)
          phone:                  enhanced['phone']            ?? null,
          personalEmail:          enhanced['personalEmail']    ?? null,
          officialEmail:          enhanced['officialEmail']    ?? null,
          dateOfBirth:            enhanced['dateOfBirth']      ?? null,
          gender:                 enhanced['gender']           ?? null,
          maritalStatus:          enhanced['maritalStatus']    ?? null,
          nationality:            enhanced['nationality']      ?? null,
          bloodGroup:             enhanced['bloodGroup']       ?? null,
          workMode:               enhanced['workMode']         ?? null,
          workLocation:           enhanced['workLocation']     ?? null,
          educationQualification: enhanced['educationQualification'] ?? null,
          photoUrl:               enhanced['photoUrl']         ?? base['avatarUrl'] ?? null,
        },
        address,
        emergencyContacts,
        bankDetails,
        leaveBalance,
        activePermissions: activePermissions.map(p => ({
          id:        p.id,
          fieldName: p.fieldName,
          expiresAt: p.expiresAt,
          grantedAt: p.grantedAt,
        })),
        pendingRequestCount,
      },
    });
  } catch (err) {
    console.error('[me/getMyProfile]', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ─── PUT /api/me/profile — update free (no-approval) fields ──────────────────

export async function updateMyFreeFields(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const empId = await getEmployeeIdForUser(userId);
    if (!empId) { res.status(404).json({ success: false, message: 'Employee record not found' }); return; }

    const { address, emergencyContacts } = req.body as {
      address?: {
        flatDoor?: string; street?: string; city?: string;
        pinCode?: string; state?: string; country?: string;
      };
      emergencyContacts?: Array<{
        name: string; relationship?: string; phone: string; email?: string;
      }>;
    };

    const changes: string[] = [];

    // Upsert address
    if (address !== undefined) {
      try {
        const existing = await q<RowDataPacket>(
          'SELECT id FROM employee_addresses WHERE employee_id = ? LIMIT 1', [empId]
        );
        if (existing[0]) {
          const aSets: string[] = [];
          const aP: unknown[] = [];
          if (address.flatDoor !== undefined) { aSets.push('flat_door = ?'); aP.push(address.flatDoor); }
          if (address.street   !== undefined) { aSets.push('street = ?');    aP.push(address.street);   }
          if (address.city     !== undefined) { aSets.push('city = ?');      aP.push(address.city);     }
          if (address.pinCode  !== undefined) { aSets.push('pin_code = ?');  aP.push(address.pinCode);  }
          if (address.state    !== undefined) { aSets.push('state = ?');     aP.push(address.state);    }
          if (address.country  !== undefined) { aSets.push('country = ?');   aP.push(address.country);  }
          if (aSets.length) { aP.push(empId); await run(`UPDATE employee_addresses SET ${aSets.join(', ')} WHERE employee_id = ?`, aP); }
        } else {
          await run(
            `INSERT INTO employee_addresses (employee_id, flat_door, street, city, pin_code, state, country)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [empId, address.flatDoor ?? null, address.street ?? null, address.city ?? null,
             address.pinCode ?? null, address.state ?? null, address.country ?? 'India']
          );
        }
        changes.push('address');
      } catch { /* table not available */ }
    }

    // Replace emergency contacts
    if (Array.isArray(emergencyContacts)) {
      try {
        await run('DELETE FROM employee_emergency_contacts WHERE employee_id = ?', [empId]);
        for (let i = 0; i < emergencyContacts.length; i++) {
          const c = emergencyContacts[i];
          await run(
            `INSERT INTO employee_emergency_contacts
               (employee_id, contact_order, name, relationship, phone, email)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [empId, i + 1, c.name, c.relationship ?? null, c.phone, c.email ?? null]
          );
        }
        changes.push('emergency contacts');
      } catch { /* table not available */ }
    }

    if (changes.length === 0) {
      res.json({ success: true, message: 'No changes to apply', data: null });
      return;
    }

    const userRows = await q<RowDataPacket>('SELECT name FROM users WHERE id = ?', [userId]);
    const userName = userRows[0]?.['name'] ?? 'An employee';
    await notifyAdmins({
      title: `Profile updated by ${userName}`,
      body:  `Changed: ${changes.join(', ')}`,
      link:  '/',
    });
    await logActivity(userId, 'UPDATE_OWN_PROFILE', 'Employee', empId, undefined, { changes }, req.ip);

    res.json({ success: true, message: 'Profile updated successfully', data: null });
  } catch (err) {
    console.error('[me/updateMyFreeFields]', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ─── PUT /api/me/field/:fieldName — restricted field with active permission ───

export async function updatePermittedField(req: Request, res: Response): Promise<void> {
  try {
    const userId    = req.user!.id;
    const fieldName = req.params['fieldName']!;
    const { value } = req.body as { value?: string };

    if (value === undefined) {
      res.status(400).json({ success: false, message: 'value is required' });
      return;
    }

    const fieldDef = ss.RESTRICTED_FIELDS[fieldName];
    if (!fieldDef) {
      res.status(400).json({ success: false, message: `Unknown restricted field: ${fieldName}` });
      return;
    }

    // Document fields handled by the dedicated upload endpoint
    if (fieldDef.table === 'employee_documents') {
      res.status(400).json({ success: false, message: 'Use POST /api/me/documents/upload for document re-uploads.' });
      return;
    }

    const empId = await getEmployeeIdForUser(userId);
    if (!empId) { res.status(404).json({ success: false, message: 'Employee record not found' }); return; }

    const perm = await ss.findActivePermission(empId, fieldName);
    if (!perm) {
      res.status(403).json({
        success: false,
        message: 'No active permission to edit this field. Please raise a change request.',
      });
      return;
    }

    if (fieldDef.table === 'users') {
      await run(`UPDATE users SET ${fieldDef.column} = ? WHERE id = ?`, [value, userId]);
    } else if (fieldDef.table === 'employees') {
      await run(`UPDATE employees SET ${fieldDef.column} = ? WHERE id = ?`, [value, empId]);
    } else if (fieldDef.table === 'employee_bank_details') {
      const existing = await q<RowDataPacket>(
        'SELECT id FROM employee_bank_details WHERE employee_id = ? LIMIT 1', [empId]
      );
      if (existing[0]) {
        await run(`UPDATE employee_bank_details SET ${fieldDef.column} = ? WHERE employee_id = ?`, [value, empId]);
      } else {
        await run(
          `INSERT INTO employee_bank_details (employee_id, ${fieldDef.column}) VALUES (?, ?)`,
          [empId, value]
        );
      }
    }

    const userRows = await q<RowDataPacket>('SELECT name FROM users WHERE id = ?', [userId]);
    const userName = userRows[0]?.['name'] ?? 'An employee';
    await notifyAdmins({
      title: `${userName} updated ${fieldDef.label}`,
      body:  `The field "${fieldDef.label}" was updated using a granted permission.`,
      link:  '/change-requests',
    });
    await logActivity(userId, 'UPDATE_PERMITTED_FIELD', 'Employee', empId,
      { field: fieldName }, { field: fieldName, newValue: fieldDef.masked ? '***' : value }, req.ip);

    res.json({ success: true, message: `${fieldDef.label} updated successfully`, data: null });
  } catch (err) {
    console.error('[me/updatePermittedField]', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ─── GET /api/me/change-requests ─────────────────────────────────────────────

export async function getMyChangeRequests(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const empId  = await getEmployeeIdForUser(userId);
    if (!empId) { res.json({ success: true, message: 'OK', data: [] }); return; }
    try {
      const requests = await ss.listRequestsForEmployee(empId);
      res.json({ success: true, message: 'OK', data: requests });
    } catch {
      res.json({ success: true, message: 'OK', data: [] });
    }
  } catch (err) {
    console.error('[me/getMyChangeRequests]', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ─── POST /api/me/change-requests — text field changes ───────────────────────

export async function createMyChangeRequest(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const { fieldName, newValue, reason } = req.body as {
      fieldName?: string; newValue?: string; reason?: string;
    };

    if (!fieldName || !newValue || !newValue.trim()) {
      res.status(400).json({ success: false, message: 'fieldName and newValue are required' });
      return;
    }
    if (!reason || !reason.trim()) {
      res.status(400).json({ success: false, message: 'reason is required' });
      return;
    }
    const fieldDef = ss.RESTRICTED_FIELDS[fieldName];
    if (!fieldDef) {
      res.status(400).json({ success: false, message: `Unknown restricted field: ${fieldName}` });
      return;
    }
    if (fieldDef.table === 'employee_documents') {
      res.status(400).json({ success: false, message: 'Use POST /api/me/change-requests/upload for document changes.' });
      return;
    }

    const empId = await getEmployeeIdForUser(userId);
    if (!empId) { res.status(404).json({ success: false, message: 'Employee record not found' }); return; }

    // Block duplicate pending requests
    try {
      const existing = await q<RowDataPacket>(
        `SELECT id FROM employee_field_change_requests
         WHERE employee_id = ? AND field_name = ? AND status = 'PENDING' LIMIT 1`,
        [empId, fieldName]
      );
      if (existing[0]) {
        res.status(409).json({ success: false, message: 'A pending request for this field already exists.' });
        return;
      }
    } catch { /* table not yet created — allow the insert below */ }

    // Read current value for admin context
    let currentValue: string | null = null;
    try {
      if (fieldDef.table === 'users') {
        const r = await q<RowDataPacket>(`SELECT ${fieldDef.column} AS v FROM users WHERE id = ?`, [userId]);
        currentValue = r[0]?.['v'] ?? null;
      } else if (fieldDef.table === 'employees') {
        const r = await q<RowDataPacket>(`SELECT ${fieldDef.column} AS v FROM employees WHERE id = ?`, [empId]);
        currentValue = r[0]?.['v'] ?? null;
      } else if (fieldDef.table === 'employee_bank_details') {
        const r = await q<RowDataPacket>(`SELECT ${fieldDef.column} AS v FROM employee_bank_details WHERE employee_id = ?`, [empId]);
        currentValue = r[0]?.['v'] ?? null;
      }
    } catch { /* column may not exist */ }

    let id: number;
    try {
      id = await ss.createChangeRequest({
        employeeId:     empId,
        fieldName,
        fieldLabel:     fieldDef.label,
        currentValue:   fieldDef.masked && currentValue ? ss.maskValue(currentValue) : currentValue,
        requestedValue: newValue.trim(),
        reason:         reason.trim(),
      });
    } catch (dbErr: unknown) {
      const msg  = String((dbErr as { message?: string })?.message ?? '');
      const code = String((dbErr as { code?: string })?.code ?? '');
      if (msg.includes("doesn't exist") || msg.includes("ER_NO_SUCH_TABLE")) {
        res.status(503).json({
          success: false,
          message: 'Self-service tables not initialised. Please ask an administrator to run the setup migration.',
        });
      } else if (code === 'ER_BAD_FIELD_ERROR' || msg.includes("Unknown column 'new_doc_url'")) {
        res.status(503).json({
          success: false,
          message: 'Database migration required. Run: ALTER TABLE employee_field_change_requests ADD COLUMN new_doc_url VARCHAR(500) NULL AFTER requested_value;',
        });
      } else {
        console.error('[me/createMyChangeRequest/db]', dbErr);
        res.status(500).json({ success: false, message: 'Failed to save change request. Please try again.' });
      }
      return;
    }

    try {
      const userRows = await q<RowDataPacket>('SELECT name FROM users WHERE id = ?', [userId]);
      const userName = userRows[0]?.['name'] ?? 'An employee';
      await notifyAdmins({
        title: `Change request: ${fieldDef.label}`,
        body:  `${userName} submitted a new value for ${fieldDef.label} — awaiting your review.`,
        link:  '/change-requests',
      });
    } catch { /* non-fatal */ }

    try {
      await logActivity(userId, 'CREATE_CHANGE_REQUEST', 'ChangeRequest', id,
        undefined, { fieldName, fieldLabel: fieldDef.label }, req.ip);
    } catch { /* non-fatal */ }

    res.status(201).json({ success: true, message: 'Change request submitted', data: { id } });
  } catch (err) {
    console.error('[me/createMyChangeRequest]', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ─── POST /api/me/change-requests/upload — document field changes ─────────────
// Employee uploads the new document with the request itself.
// On admin approval the file URL is written directly to employee_documents.

export async function createMyDocChangeRequest(req: Request, res: Response): Promise<void> {
  try {
    const userId    = req.user!.id;
    const fieldName = String((req.body as Record<string, unknown>)['fieldName'] ?? '').trim();
    const reason    = String((req.body as Record<string, unknown>)['reason']    ?? '').trim();

    if (!fieldName) {
      res.status(400).json({ success: false, message: 'fieldName is required' });
      return;
    }
    if (!reason) {
      res.status(400).json({ success: false, message: 'reason is required' });
      return;
    }

    const fieldDef = ss.RESTRICTED_FIELDS[fieldName];
    if (!fieldDef || fieldDef.table !== 'employee_documents') {
      res.status(400).json({ success: false, message: 'Invalid document field name' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ success: false, message: 'Document file is required' });
      return;
    }

    const allowed = ['.pdf', '.png', '.jpg', '.jpeg', '.doc', '.docx'];
    const ext = req.file.originalname.slice(req.file.originalname.lastIndexOf('.')).toLowerCase();
    if (!allowed.includes(ext)) {
      res.status(400).json({ success: false, message: 'Only PDF, PNG, JPG, DOC files allowed' });
      return;
    }

    const empId = await getEmployeeIdForUser(userId);
    if (!empId) { res.status(404).json({ success: false, message: 'Employee record not found' }); return; }

    // Block duplicate pending requests
    try {
      const existing = await q<RowDataPacket>(
        `SELECT id FROM employee_field_change_requests
         WHERE employee_id = ? AND field_name = ? AND status = 'PENDING' LIMIT 1`,
        [empId, fieldName]
      );
      if (existing[0]) {
        res.status(409).json({ success: false, message: 'A pending request for this document already exists.' });
        return;
      }
    } catch { /* table not yet created */ }

    // Upload the new document to storage
    const { url } = await uploadFile(req.file.buffer, {
      folder:   'employee-doc-requests',
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
    });

    // Store the existing doc URL so admin can compare old vs new
    let currentValue: string | null = null;
    try {
      const r = await q<RowDataPacket>(
        `SELECT file_path AS v FROM employee_documents WHERE employee_id = ? AND name = ? ORDER BY created_at DESC LIMIT 1`,
        [empId, fieldDef.label]
      );
      currentValue = r[0]?.['v'] ?? null;
    } catch { /* non-fatal */ }

    let id: number;
    try {
      id = await ss.createChangeRequest({
        employeeId:     empId,
        fieldName,
        fieldLabel:     fieldDef.label,
        currentValue,
        requestedValue: `[New document: ${req.file.originalname}]`,
        reason,
        newDocUrl:      url,
      });
    } catch (dbErr: unknown) {
      const msg = String((dbErr as { message?: string })?.message ?? '');
      if (msg.includes("doesn't exist") || msg.includes("ER_NO_SUCH_TABLE")) {
        res.status(503).json({
          success: false,
          message: 'Self-service tables not initialised. Please ask an administrator to run the setup migration.',
        });
      } else {
        console.error('[me/createMyDocChangeRequest/db]', dbErr);
        res.status(500).json({ success: false, message: 'Failed to save change request. Please try again.' });
      }
      return;
    }

    try {
      const userRows = await q<RowDataPacket>('SELECT name FROM users WHERE id = ?', [userId]);
      const userName = userRows[0]?.['name'] ?? 'An employee';
      await notifyAdmins({
        title: `Document change request: ${fieldDef.label}`,
        body:  `${userName} submitted a new ${fieldDef.label} for your review.`,
        link:  '/change-requests',
      });
    } catch { /* non-fatal */ }

    try {
      await logActivity(userId, 'CREATE_CHANGE_REQUEST', 'ChangeRequest', id,
        undefined, { fieldName, fieldLabel: fieldDef.label, hasDoc: true }, req.ip);
    } catch { /* non-fatal */ }

    res.status(201).json({ success: true, message: 'Document change request submitted', data: { id } });
  } catch (err) {
    console.error('[me/createMyDocChangeRequest]', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ─── GET /api/me/attendance ───────────────────────────────────────────────────

export async function getMyAttendance(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const empId  = await getEmployeeIdForUser(userId);
    if (!empId) { res.json({ success: true, message: 'OK', data: [] }); return; }
    const rows = await q<RowDataPacket>(
      `SELECT date, clock_in AS clockIn, clock_out AS clockOut, type,
              late_minutes AS lateMinutes, work_minutes AS workMinutes,
              overtime_minutes AS overtimeMinutes, notes, is_manual AS isManual
       FROM attendance_logs WHERE employee_id = ?
       ORDER BY date DESC LIMIT 60`,
      [empId]
    );
    res.json({ success: true, message: 'OK', data: rows });
  } catch (err) {
    console.error('[me/getMyAttendance]', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ─── GET /api/me/leaves ───────────────────────────────────────────────────────

export async function getMyLeaves(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const empId  = await getEmployeeIdForUser(userId);
    if (!empId) { res.json({ success: true, message: 'OK', data: { balance: null, requests: [] } }); return; }
    const year = new Date().getFullYear();
    const balance = await q<RowDataPacket>(
      `SELECT casual_total AS casualTotal, casual_used AS casualUsed,
              sick_total AS sickTotal, sick_used AS sickUsed,
              paid_total AS paidTotal, paid_used AS paidUsed,
              comp_off AS compOff
       FROM leave_balances WHERE employee_id = ? AND year = ?`,
      [empId, year]
    );
    const requests = await q<RowDataPacket>(
      `SELECT uuid, leave_type AS leaveType, from_date AS fromDate,
              to_date AS toDate, days, reason, status,
              review_note AS reviewNote, created_at AS createdAt
       FROM leave_requests WHERE employee_id = ?
       ORDER BY created_at DESC LIMIT 50`,
      [empId]
    );
    res.json({ success: true, message: 'OK', data: { balance: balance[0] ?? null, requests } });
  } catch (err) {
    console.error('[me/getMyLeaves]', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ─── GET /api/me/payslips ─────────────────────────────────────────────────────

export async function getMyPayslips(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const empId  = await getEmployeeIdForUser(userId);
    if (!empId) { res.json({ success: true, message: 'OK', data: [] }); return; }
    const rows = await q<RowDataPacket>(
      `SELECT id, month, year,
              base_salary AS baseSalary,
              working_days AS workingDays,
              present_days AS presentDays,
              gross_salary AS grossSalary,
              net_salary AS netSalary,
              bonus, late_deduction AS lateDeduction,
              other_deduction AS otherDeduction,
              overtime_amount AS overtimeAmount,
              lop_days AS lopDays,
              status, paid_at AS paidAt
       FROM payroll_records
       WHERE employee_id = ? AND status IN ('APPROVED','PAID')
       ORDER BY year DESC, month DESC LIMIT 36`,
      [empId]
    );
    res.json({ success: true, message: 'OK', data: rows });
  } catch (err) {
    console.error('[me/getMyPayslips]', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ─── GET /api/me/tasks ────────────────────────────────────────────────────────

export async function getMyTasks(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const rows = await q<RowDataPacket>(
      `SELECT t.uuid, t.title, t.status, t.priority, t.due_date AS dueDate,
              t.created_at AS createdAt,
              c.company_name AS clientName,
              u.name AS assignedByName
       FROM tasks t
       LEFT JOIN clients c ON c.id = t.client_id
       JOIN users u ON u.id = t.assigned_by_id
       WHERE (t.assigned_to_id = ? OR EXISTS (SELECT 1 FROM task_members tm WHERE tm.task_id = t.id AND tm.user_id = ?))
         AND t.status != 'DONE'
       ORDER BY t.due_date ASC, t.priority DESC LIMIT 20`,
      [userId, userId]
    );
    res.json({ success: true, message: 'OK', data: rows });
  } catch (err) {
    console.error('[me/getMyTasks]', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ─── GET /api/me/task-stats ───────────────────────────────────────────────────

export async function getMyTaskStats(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;

    const [open] = await q<RowDataPacket>(
      `SELECT
         COUNT(*)                                                             AS totalOpen,
         SUM(CASE WHEN DATE(t.due_date) = CURDATE() THEN 1 ELSE 0 END)      AS todayTasks,
         SUM(CASE WHEN t.status = 'IN_PROGRESS' THEN 1 ELSE 0 END)          AS inProgress,
         SUM(CASE WHEN t.status = 'IN_REVIEW'   THEN 1 ELSE 0 END)          AS inReview,
         SUM(CASE WHEN t.due_date < CURDATE()   THEN 1 ELSE 0 END)          AS overdue
       FROM tasks t
       WHERE (t.assigned_to_id = ? OR EXISTS (SELECT 1 FROM task_members tm WHERE tm.task_id = t.id AND tm.user_id = ?))
         AND t.status != 'DONE'`,
      [userId, userId]
    );

    const [done] = await q<RowDataPacket>(
      `SELECT
         SUM(CASE WHEN DATE(t.updated_at) = CURDATE() THEN 1 ELSE 0 END) AS completedToday,
         COUNT(*)                                                          AS completedThisMonth
       FROM tasks t
       WHERE (t.assigned_to_id = ? OR EXISTS (SELECT 1 FROM task_members tm WHERE tm.task_id = t.id AND tm.user_id = ?))
         AND t.status = 'DONE'
         AND YEAR(t.updated_at) = YEAR(CURDATE()) AND MONTH(t.updated_at) = MONTH(CURDATE())`,
      [userId, userId]
    );

    res.json({
      success: true, message: 'OK',
      data: {
        todayTasks:         Number(open['todayTasks']         ?? 0),
        completedToday:     Number(done['completedToday']     ?? 0),
        inProgress:         Number(open['inProgress']         ?? 0),
        inReview:           Number(open['inReview']           ?? 0),
        overdue:            Number(open['overdue']            ?? 0),
        completedThisMonth: Number(done['completedThisMonth'] ?? 0),
      },
    });
  } catch (err) {
    console.error('[me/getMyTaskStats]', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ─── GET /api/me/documents ────────────────────────────────────────────────────

export async function getMyDocuments(req: Request, res: Response): Promise<void> {
  try {
    const empId = await getEmployeeIdForUser(req.user!.id);
    if (!empId) { res.json({ success: true, message: 'OK', data: [] }); return; }

    const docs = await q<RowDataPacket>(
      `SELECT id, doc_type AS docType, doc_category AS docCategory,
              name, file_path AS filePath,
              is_mandatory AS isMandatory,
              verification_status AS verificationStatus,
              expiry_date AS expiryDate,
              created_at AS createdAt
       FROM employee_documents
       WHERE employee_id = ?
       ORDER BY created_at DESC`,
      [empId]
    );
    res.json({ success: true, message: 'OK', data: docs });
  } catch (err) {
    console.error('[me/getMyDocuments]', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ─── GET /api/me/agreements ───────────────────────────────────────────────────

export async function getMyAgreements(req: Request, res: Response): Promise<void> {
  try {
    const empId = await getEmployeeIdForUser(req.user!.id);
    if (!empId) { res.json({ success: true, message: 'OK', data: [] }); return; }

    const rows = await q<RowDataPacket>(
      `SELECT uuid, agreement_type AS agreementType, name,
              file_path AS filePath, version,
              signed_at AS signedAt, notes,
              created_at AS createdAt
       FROM employee_agreements
       WHERE employee_id = ?
       ORDER BY created_at DESC`,
      [empId]
    );
    res.json({ success: true, message: 'OK', data: rows });
  } catch (err) {
    console.error('[me/getMyAgreements]', err);
    // Table may not exist if enhancement migration not yet run
    res.json({ success: true, message: 'OK', data: [] });
  }
}

// ─── POST /api/me/documents/upload — upload ID Proof (needs active permission) ─

export async function uploadMyDocument(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const empId  = await getEmployeeIdForUser(userId);
    if (!empId) { res.status(404).json({ success: false, message: 'Employee record not found' }); return; }

    const FIELD_TO_DOC_TYPE: Record<string, string> = {
      doc_aadhaar:         'AADHAAR',
      doc_pan:             'PAN',
      doc_bank_passbook:   'BANK_PASSBOOK',
      doc_education_cert:  'EDUCATION_CERT',
      doc_resume:          'RESUME',
      doc_experience_cert: 'EXPERIENCE_CERT',
      doc_id_proof:        'ID_PROOF',  // legacy
    };
    // Canonical slot name stored as doc.name — used for slot-matching in the employee view
    const FIELD_TO_SLOT_NAME: Record<string, string> = {
      doc_aadhaar:         'Aadhaar Card',
      doc_pan:             'PAN Card',
      doc_bank_passbook:   'Bank Passbook / Cancelled Cheque',
      doc_education_cert:  'Highest Education Certificate',
      doc_resume:          'Resume',
      doc_experience_cert: 'Experience Certificate',
      doc_id_proof:        'ID Proof',
    };

    const fieldName = String((req.body as Record<string, unknown>)['fieldName'] ?? 'doc_id_proof');
    const docType   = FIELD_TO_DOC_TYPE[fieldName] ?? 'OTHER';
    const slotName  = FIELD_TO_SLOT_NAME[fieldName] ?? req.file?.originalname ?? 'Document';
    const docLabel  = slotName;

    if (!FIELD_TO_DOC_TYPE[fieldName]) {
      res.status(400).json({ success: false, message: 'Invalid document field name' }); return;
    }

    const perm = await ss.findActivePermission(empId, fieldName);
    if (!perm) {
      res.status(403).json({
        success: false,
        message: `No active permission to upload ${docLabel}. Please raise a change request first.`,
      });
      return;
    }

    if (!req.file) {
      res.status(400).json({ success: false, message: 'No file uploaded' }); return;
    }

    const allowed = ['.pdf', '.png', '.jpg', '.jpeg'];
    const ext = req.file.originalname.slice(req.file.originalname.lastIndexOf('.')).toLowerCase();
    if (!allowed.includes(ext)) {
      res.status(400).json({ success: false, message: 'Only PDF, PNG, JPG files allowed' }); return;
    }

    const { url } = await uploadFile(req.file.buffer, {
      folder: 'employee-docs',
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
    });

    const result = await run(
      `INSERT INTO employee_documents (employee_id, doc_type, name, file_path, uploaded_by)
       VALUES (?, ?, ?, ?, ?)`,
      [empId, docType, slotName, url, userId]
    );

    const userRows = await q<RowDataPacket>('SELECT name FROM users WHERE id = ?', [userId]);
    const userName = userRows[0]?.['name'] ?? 'An employee';
    await notifyAdmins({
      title: `${userName} uploaded ${docLabel}`,
      body: `A new ${docLabel} document has been uploaded and is pending verification.`,
      link: `/employees`,
    });

    await logActivity(userId, 'UPLOAD_OWN_DOCUMENT', 'EmployeeDocument', result.insertId,
      undefined, { docType, fileName: req.file.originalname }, req.ip);

    res.status(201).json({ success: true, message: `${docLabel} uploaded successfully`, data: { filePath: url } });
  } catch (err) {
    console.error('[me/uploadMyDocument]', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}
