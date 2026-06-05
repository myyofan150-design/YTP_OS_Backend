// src/routes/me.routes.ts
// Employee self-portal routes. All require authentication.

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { createUploader } from '../lib/storage';
import {
  getMyProfile,
  updateMyFreeFields,
  updatePermittedField,
  getMyChangeRequests,
  createMyChangeRequest,
  createMyDocChangeRequest,
  getMyAttendance,
  getMyLeaves,
  getMyPayslips,
  getMyTasks,
  getMyTaskStats,
  getMyDocuments,
  getMyAgreements,
  uploadMyDocument,
} from '../controllers/me.controller';

const router = Router();
router.use(authenticate);

const docUploader = createUploader('employee-docs', 10);

router.get('/',                                getMyProfile);
router.put('/profile',                         updateMyFreeFields);
router.put('/field/:fieldName',                updatePermittedField);
router.get('/change-requests',                 getMyChangeRequests);
router.post('/change-requests',                createMyChangeRequest);
router.post('/change-requests/upload',         docUploader.single('file'), createMyDocChangeRequest);
router.get('/attendance',                      getMyAttendance);
router.get('/leaves',                          getMyLeaves);
router.get('/payslips',                        getMyPayslips);
router.get('/tasks',                           getMyTasks);
router.get('/task-stats',                      getMyTaskStats);
router.get('/documents',                       getMyDocuments);
router.get('/agreements',                      getMyAgreements);
router.post('/documents/upload',               docUploader.single('file'), uploadMyDocument);

export default router;
