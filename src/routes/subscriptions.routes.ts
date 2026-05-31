// src/routes/subscriptions.routes.ts
import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import { createUploader } from "../lib/storage";
import {
  listSubscriptions,
  createSubscription,
  getSubscription,
  updateSubscription,
  deleteSubscription,
  analyticsSubscriptions,
  exportCsv,
  cronTrigger,
  uploadSubscriptionLogo,
} from "../controllers/subscriptions.controller";
import {
  listMeta,
  createMeta,
  updateMeta,
  deleteMeta,
} from "../controllers/subscription-meta.controller";

const router = Router();
const logoUploader = createUploader("subscription-logos", 5);

router.use(authenticate);

// !! All static paths must be registered before /:uuid !!

// ── Meta options ──────────────────────────────────────────────────────────────
router.get(   "/meta",       listMeta);
router.post(  "/meta",       requireRole("SUPER_ADMIN", "ADMIN"), createMeta);
router.patch( "/meta/:uuid", requireRole("SUPER_ADMIN", "ADMIN"), updateMeta);
router.delete("/meta/:uuid", requireRole("SUPER_ADMIN", "ADMIN"), deleteMeta);

// ── Analytics, Export & Cron Trigger ─────────────────────────────────────────
router.get("/analytics/summary", requireRole("SUPER_ADMIN", "ADMIN"), analyticsSubscriptions);
router.get("/export/csv",        requireRole("SUPER_ADMIN", "ADMIN"), exportCsv);
// WARNING: Remove /cron/trigger before going to production
router.get("/cron/trigger",      requireRole("SUPER_ADMIN"), cronTrigger);

// ── Subscriptions CRUD ────────────────────────────────────────────────────────
router.get(   "/",      listSubscriptions);
router.post(  "/",      requireRole("SUPER_ADMIN", "ADMIN"), createSubscription);
router.get(   "/:uuid", getSubscription);
router.patch( "/:uuid", requireRole("SUPER_ADMIN", "ADMIN"), updateSubscription);
router.delete("/:uuid", requireRole("SUPER_ADMIN", "ADMIN"), deleteSubscription);

// ── Logo Upload ───────────────────────────────────────────────────────────────
router.post("/:uuid/logo", requireRole("SUPER_ADMIN", "ADMIN"), logoUploader.single("logo"), uploadSubscriptionLogo);

export default router;
