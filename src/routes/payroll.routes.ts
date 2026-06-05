// src/routes/payroll.routes.ts
import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import {
  generatePayroll,
  generateBatch,
  listPayroll,
  getPayroll,
  updatePayroll,
  approvePayroll,
  markPayrollPaid,
  downloadPayslip,
  deletePayrollRecord,
} from "../controllers/payroll.controller";

const router = Router();

router.use(authenticate);

// HR/Admin: generate for single employee
router.post("/generate",       requireRole("SUPER_ADMIN","ADMIN","HR","ACCOUNTANT"), generatePayroll);
// HR/Admin: generate for all active employees
router.post("/generate-batch", requireRole("SUPER_ADMIN","ADMIN","HR","ACCOUNTANT"), generateBatch);

// List — role-filtered inside controller
router.get("/", listPayroll);

// Single record — own-check inside controller for EMPLOYEE
router.get("/:id",             getPayroll);

// Update bonus/deductions (DRAFT only)
router.patch("/:id",           requireRole("SUPER_ADMIN","ADMIN","HR","ACCOUNTANT"), updatePayroll);

// Approve (generates PDF + notifies)
router.patch("/:id/approve",   requireRole("SUPER_ADMIN","ADMIN","HR","ACCOUNTANT"), approvePayroll);

// Mark paid
router.patch("/:id/mark-paid", requireRole("SUPER_ADMIN","ADMIN","ACCOUNTANT"), markPayrollPaid);

// Delete — SUPER_ADMIN only
router.delete("/:id",          requireRole("SUPER_ADMIN"), deletePayrollRecord);

// Download payslip PDF — own-check inside controller for EMPLOYEE
router.get("/:id/payslip",     downloadPayslip);

export default router;
