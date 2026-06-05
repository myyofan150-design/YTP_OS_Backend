// src/routes/employees.routes.ts

import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import { createUploader } from "../lib/storage";
import {
  listEmployees,
  createEmployee,
  getEmployee,
  updateEmployee,
  uploadDocument,
  deleteDocument,
  verifyDocument,
  getDocumentChecklist,
  getLeaveBalance,
  updateLeaveBalance,
  exportEmployeePdf,
  getEmployeeStats,
  updatePersonal,
  updateJob,
  updateBank,
  updateEmergencyContacts,
  updateSalary,
  updateStatus,
  createAsset,
  getAssets,
  updateAsset,
  deleteAsset,
  createAgreement,
  getAgreements,
  deleteAgreement,
  getStatusHistory,
  deleteEmployee,
  uploadPhoto,
  getEmployeeDirectory,
} from "../controllers/employees.controller";

const router = Router();
const photoUploader     = createUploader("employee-photos",      5);
const docUploader      = createUploader("employee-docs",       10);
const agreementUploader = createUploader("employee-agreements", 10);

router.use(authenticate);

const HR_ROLES         = ["SUPER_ADMIN", "ADMIN", "HR"] as const;
const SENSITIVE_ROLES  = ["SUPER_ADMIN", "ADMIN", "HR", "ACCOUNTANT"] as const;

// ── Directory — any authenticated user (no sensitive data) ───────────────────
router.get("/directory", getEmployeeDirectory);

// ── Stats (must be before /:uuid) ────────────────────────────────────────────
router.get("/stats", requireRole(...HR_ROLES), getEmployeeStats);

// ── Collection ───────────────────────────────────────────────────────────────
router.get("/",  requireRole(...HR_ROLES), listEmployees);
router.post("/", requireRole(...HR_ROLES), createEmployee);

// ── Single employee ───────────────────────────────────────────────────────────
router.get("/:uuid",    getEmployee);
router.patch("/:uuid",  requireRole(...HR_ROLES), updateEmployee);
router.delete("/:uuid", requireRole("SUPER_ADMIN"), deleteEmployee);
router.post("/:uuid/photo", requireRole(...HR_ROLES), photoUploader.single("photo"), uploadPhoto);

// ── Granular PATCH sections ───────────────────────────────────────────────────
router.patch("/:uuid/personal",           requireRole(...HR_ROLES),        updatePersonal);
router.patch("/:uuid/job",                requireRole(...HR_ROLES),        updateJob);
router.patch("/:uuid/bank",               requireRole(...SENSITIVE_ROLES), updateBank);
router.patch("/:uuid/emergency-contacts", requireRole(...HR_ROLES),        updateEmergencyContacts);
router.patch("/:uuid/salary",             requireRole(...SENSITIVE_ROLES), updateSalary);
router.patch("/:uuid/status",             requireRole(...HR_ROLES),        updateStatus);

// ── Documents ─────────────────────────────────────────────────────────────────
router.post(  "/:uuid/documents",                  requireRole(...HR_ROLES), docUploader.single("file"), uploadDocument);
router.get(   "/:uuid/documents/checklist",         getDocumentChecklist);
router.patch( "/:uuid/documents/:docId/verify",    requireRole(...HR_ROLES), verifyDocument);
router.delete("/:uuid/documents/:docId",           requireRole(...HR_ROLES), deleteDocument);

// ── Assets ────────────────────────────────────────────────────────────────────
router.post(  "/:uuid/assets",            requireRole(...HR_ROLES), createAsset);
router.get(   "/:uuid/assets",            requireRole(...HR_ROLES), getAssets);
router.patch( "/:uuid/assets/:assetUuid", requireRole(...HR_ROLES), updateAsset);
router.delete("/:uuid/assets/:assetUuid", requireRole(...HR_ROLES), deleteAsset);

// ── Agreements ────────────────────────────────────────────────────────────────
router.post(  "/:uuid/agreements",                requireRole(...HR_ROLES), agreementUploader.single("file"), createAgreement);
router.get(   "/:uuid/agreements",                requireRole(...HR_ROLES), getAgreements);
router.delete("/:uuid/agreements/:agreementUuid", requireRole(...HR_ROLES), deleteAgreement);

// ── Status history ────────────────────────────────────────────────────────────
router.get("/:uuid/status-history", requireRole(...HR_ROLES), getStatusHistory);

// ── Leave balance ─────────────────────────────────────────────────────────────
router.get   ("/:uuid/leave-balance", getLeaveBalance);
router.patch ("/:uuid/leave-balance", requireRole(...HR_ROLES), updateLeaveBalance);

// ── PDF export ────────────────────────────────────────────────────────────────
router.get("/:uuid/export-pdf", requireRole(...HR_ROLES), exportEmployeePdf);

export default router;
