// src/routes/leads.routes.ts
import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import {
  listLeads,
  createLead,
  getLead,
  updateLead,
  deleteLead,
  convertLead,
  markLeadLost,
  exportLeadsCsv,
  importLeadsCsv,
  statsLeads,
} from "../controllers/leads.controller";
import express from "express";
import {
  listLeadMeta,
  createLeadMeta,
  updateLeadMeta,
  deleteLeadMeta,
} from "../controllers/lead-meta.controller";

const router = Router();

router.use(authenticate);

// !! All static paths must be registered before /:uuid !!

// ── Meta options ──────────────────────────────────────────────────────────────
router.get(   "/meta",       listLeadMeta);
router.post(  "/meta",       requireRole("SUPER_ADMIN", "ADMIN"), createLeadMeta);
router.patch( "/meta/:uuid", requireRole("SUPER_ADMIN", "ADMIN"), updateLeadMeta);
router.delete("/meta/:uuid", requireRole("SUPER_ADMIN", "ADMIN"), deleteLeadMeta);

// ── Analytics, Export, Import (BEFORE /:uuid) ────────────────────────────────
router.get( "/export/csv",    requireRole("SUPER_ADMIN", "ADMIN"), exportLeadsCsv);
router.post("/import/csv",    requireRole("SUPER_ADMIN", "ADMIN"), express.text({ type: "text/csv", limit: "5mb" }), importLeadsCsv);
router.get( "/stats/summary", requireRole("SUPER_ADMIN", "ADMIN"), statsLeads);

// ── Leads CRUD ────────────────────────────────────────────────────────────────
router.get(   "/",      listLeads);
router.post(  "/",      createLead);
router.get(   "/:uuid", getLead);
router.patch( "/:uuid", updateLead);
router.delete("/:uuid", requireRole("SUPER_ADMIN", "ADMIN"), deleteLead);

// ── Lead actions ──────────────────────────────────────────────────────────────
router.post( "/:uuid/convert",   requireRole("SUPER_ADMIN", "ADMIN"), convertLead);
router.patch("/:uuid/mark-lost", markLeadLost);

export default router;
