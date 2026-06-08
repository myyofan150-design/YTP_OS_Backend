// src/routes/client-portal.routes.ts
import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import {
  profile,
  dashboard,
  tasks,
  taskDetail,
  invoices,
  invoicePdf,
  documents,
} from "../controllers/client-portal.controller";

const router = Router();

router.use(authenticate, requireRole("CLIENT"));

router.get("/profile",       profile);
router.get("/dashboard",     dashboard);
router.get("/tasks",         tasks);
router.get("/tasks/:uuid",   taskDetail);
router.get("/invoices",          invoices);
router.get("/invoices/:id/pdf",  invoicePdf);
router.get("/documents",     documents);

export default router;
