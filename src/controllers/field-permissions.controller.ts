// src/controllers/field-permissions.controller.ts
// Admin-only endpoints for managing employee field change requests and permissions.

import { Request, Response } from 'express';
import { q } from '../lib/db';
import type { RowDataPacket } from 'mysql2';
import { logActivity } from '../lib/logger';
import * as notif from '../models/notification.model';
import * as ss from '../models/self-service.model';

function isMissingTable(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? '');
  return msg.includes("doesn't exist") || msg.includes("ER_NO_SUCH_TABLE");
}

// ─── Helper: notify the employee who owns the request ─────────────────────────

async function notifyEmployee(employeeId: number, data: {
  title: string; body: string; link?: string;
}): Promise<void> {
  const rows = await q<RowDataPacket>(
    'SELECT user_id AS userId FROM employees WHERE id = ?', [employeeId]
  );
  const uid: number | undefined = rows[0]?.['userId'];
  if (!uid) return;
  await notif.create({ userId: uid, type: 'GENERAL', ...data });
}

// ─── GET /api/field-permissions/requests ─────────────────────────────────────

export async function listRequests(req: Request, res: Response): Promise<void> {
  try {
    const { status } = req.query as { status?: ss.RequestStatus };
    const requests = await ss.listAllRequests(status);

    // For pending document requests, replace stored currentValue with live doc URL
    // (stored value may be null/stale if the original upload used a different name)
    for (const r of requests) {
      if (r.status !== 'PENDING') continue;
      const fieldDef = ss.RESTRICTED_FIELDS[r.fieldName];
      if (fieldDef?.table !== 'employee_documents' || fieldDef.multiUpload) continue;
      const rows = await q<RowDataPacket>(
        `SELECT file_path FROM employee_documents WHERE employee_id = ? AND name = ? ORDER BY created_at DESC LIMIT 1`,
        [r.employeeId, fieldDef.label]
      );
      r.currentValue = rows[0]?.['file_path'] ?? null;
    }

    res.json({ success: true, message: 'OK', data: requests });
  } catch (err) {
    console.error('[fp/listRequests]', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ─── POST /api/field-permissions/requests/:id/approve ────────────────────────

export async function approveRequest(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params['id'] ?? '0'), 10);
    const request = await ss.findRequestById(id);

    if (!request) {
      res.status(404).json({ success: false, message: 'Request not found' });
      return;
    }
    if (request.status !== 'PENDING') {
      res.status(409).json({ success: false, message: `Request is already ${request.status.toLowerCase()}` });
      return;
    }

    // Apply the change directly to the employee's data
    await ss.applyApprovedChange(request, req.user!.id);

    // Mark request as APPROVED
    await ss.updateRequestStatus(id, {
      status:     'APPROVED',
      reviewedBy: req.user!.id,
    });

    // Notify the employee — change is already live
    await notifyEmployee(request.employeeId, {
      title: `Change request approved: ${request.fieldLabel}`,
      body:  `Your ${request.fieldLabel} has been updated successfully.`,
      link:  '/my-profile',
    });

    await logActivity(req.user!.id, 'APPROVE_CHANGE_REQUEST', 'ChangeRequest', id,
      { status: 'PENDING' }, { status: 'APPROVED' }, req.ip);

    res.json({
      success: true,
      message: 'Request approved and change applied.',
      data: null,
    });
  } catch (err) {
    console.error('[fp/approveRequest]', err);
    if (isMissingTable(err)) {
      res.status(503).json({ success: false, message: 'Self-service tables not initialised. Run run-employee-self-service-migration.ts first.' });
    } else {
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  }
}

// ─── POST /api/field-permissions/requests/:id/reject ─────────────────────────

export async function rejectRequest(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params['id'] ?? '0'), 10);
    const { reviewNote } = req.body as { reviewNote?: string };

    if (!reviewNote || reviewNote.trim().length === 0) {
      res.status(400).json({ success: false, message: 'reviewNote is required when rejecting a request' });
      return;
    }

    const request = await ss.findRequestById(id);
    if (!request) {
      res.status(404).json({ success: false, message: 'Request not found' });
      return;
    }
    if (request.status !== 'PENDING') {
      res.status(409).json({ success: false, message: `Request is already ${request.status.toLowerCase()}` });
      return;
    }

    await ss.updateRequestStatus(id, {
      status:     'REJECTED',
      reviewedBy: req.user!.id,
      reviewNote: reviewNote.trim(),
    });

    // Notify the employee with the rejection reason
    await notifyEmployee(request.employeeId, {
      title: `Change request rejected: ${request.fieldLabel}`,
      body:  `Reason: ${reviewNote.trim()}`,
      link:  '/my-profile',
    });

    await logActivity(req.user!.id, 'REJECT_CHANGE_REQUEST', 'ChangeRequest', id,
      { status: 'PENDING' }, { status: 'REJECTED', reviewNote }, req.ip);

    res.json({ success: true, message: 'Request rejected', data: null });
  } catch (err) {
    console.error('[fp/rejectRequest]', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ─── GET /api/field-permissions/active ───────────────────────────────────────

export async function listActivePermissions(req: Request, res: Response): Promise<void> {
  try {
    const permissions = await ss.listAllActivePermissions();
    res.json({ success: true, message: 'OK', data: permissions });
  } catch (err) {
    console.error('[fp/listActivePermissions]', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ─── POST /api/field-permissions/active/:id/revoke ───────────────────────────

export async function revokePermission(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params['id'] ?? '0'), 10);
    const perm = await ss.findPermissionById(id);

    if (!perm) {
      res.status(404).json({ success: false, message: 'Permission not found' });
      return;
    }
    if (perm.status !== 'ACTIVE' || perm.revokedAt) {
      res.status(409).json({ success: false, message: 'Permission is already revoked or expired' });
      return;
    }

    await ss.revokePermission(id, req.user!.id);

    // Notify the employee
    await notifyEmployee(perm.employeeId, {
      title: `Permission revoked: ${perm.fieldName.replace(/_/g, ' ')}`,
      body:  `Your access to edit ${perm.fieldName.replace(/_/g, ' ')} has been revoked by an administrator.`,
      link:  '/my-profile',
    });

    await logActivity(req.user!.id, 'REVOKE_FIELD_PERMISSION', 'FieldPermission', id,
      { status: 'ACTIVE' }, { status: 'REVOKED' }, req.ip);

    res.json({ success: true, message: 'Permission revoked successfully', data: null });
  } catch (err) {
    console.error('[fp/revokePermission]', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ─── GET /api/field-permissions/pending-count ────────────────────────────────

export async function pendingCount(req: Request, res: Response): Promise<void> {
  try {
    const rows = await q<RowDataPacket>(
      `SELECT COUNT(*) AS cnt FROM employee_field_change_requests WHERE status = 'PENDING'`
    );
    res.json({ success: true, message: 'OK', data: { count: rows[0]?.['cnt'] ?? 0 } });
  } catch (err) {
    console.error('[fp/pendingCount]', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}
