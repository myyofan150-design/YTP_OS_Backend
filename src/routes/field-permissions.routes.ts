// src/routes/field-permissions.routes.ts
// Admin routes for managing employee field change requests and permissions.

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import {
  listRequests,
  approveRequest,
  rejectRequest,
  listActivePermissions,
  revokePermission,
  pendingCount,
} from '../controllers/field-permissions.controller';

const router = Router();
router.use(authenticate);
router.use(requireRole('SUPER_ADMIN', 'ADMIN', 'HR'));

router.get('/requests',               listRequests);
router.post('/requests/:id/approve',  approveRequest);
router.post('/requests/:id/reject',   rejectRequest);
router.get('/active',                 listActivePermissions);
router.post('/active/:id/revoke',     revokePermission);
router.get('/pending-count',          pendingCount);

export default router;
