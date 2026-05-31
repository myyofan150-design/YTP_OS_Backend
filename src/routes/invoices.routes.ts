// src/routes/invoices.routes.ts
import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import {
  createInvoice,
  listInvoices,
  getInvoice,
  updateInvoice,
  sendInvoice,
  markInvoicePaid,
  deleteInvoice,
  downloadInvoicePdf,
  getInvoiceStats,
  getClientInvoiceBalance,
} from "../controllers/invoices.controller";

const router = Router();

router.use(authenticate);

const FINANCE_ROLES = ["SUPER_ADMIN", "ADMIN", "ACCOUNTANT"] as const;

router.get("/stats",                    requireRole(...FINANCE_ROLES), getInvoiceStats);
router.get("/client-balance/:clientId", requireRole(...FINANCE_ROLES), getClientInvoiceBalance);
router.get("/",                 requireRole(...FINANCE_ROLES), listInvoices);
router.post("/",                requireRole(...FINANCE_ROLES), createInvoice);

router.get("/:id",              requireRole(...FINANCE_ROLES), getInvoice);
router.patch("/:id",            requireRole(...FINANCE_ROLES), updateInvoice);
router.delete("/:id",           requireRole(...FINANCE_ROLES), deleteInvoice);

router.post("/:id/send",        requireRole(...FINANCE_ROLES), sendInvoice);
router.patch("/:id/mark-paid",  requireRole(...FINANCE_ROLES), markInvoicePaid);
router.get("/:id/pdf",          requireRole(...FINANCE_ROLES), downloadInvoicePdf);

export default router;
