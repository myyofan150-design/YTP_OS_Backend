// src/routes/clients.routes.ts
// /renewals/upcoming MUST remain before /:uuid to avoid Express matching "renewals" as a UUID.

import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import { createUploader } from "../lib/storage";
import {
  listClients, createClient, upcomingRenewals,
  getClient, updateClient, deleteClient, hardDeleteClient, uploadClientLogo,
  addCredential, deleteCredential,
  uploadDocument, deleteDocument,
  listContacts, addContact, updateContact, deleteContact,
  listPayments, addPayment, deletePayment,
  updateTracking, getTimeline,
  updateNotes, downloadClientPdf,
} from "../controllers/clients.controller";
import {
  listClientMeta, createClientMeta, updateClientMeta, deleteClientMeta,
} from "../controllers/client-meta.controller";

const router = Router();
const docUploader  = createUploader("client-docs",  10);
const logoUploader = createUploader("client-logos",  2);

router.use(authenticate);

// ── Collection ────────────────────────────────────────────────────────────────
router.get("/",  listClients);
router.post("/", requireRole("SUPER_ADMIN", "ADMIN"), createClient);

// !! Static paths before /:uuid !!
router.get("/renewals/upcoming", requireRole("SUPER_ADMIN", "ADMIN"), upcomingRenewals);

// ── Meta options (custom tags + contract types) ───────────────────────────────
router.get("/meta",          listClientMeta);
router.post("/meta",         requireRole("SUPER_ADMIN", "ADMIN"), createClientMeta);
router.patch("/meta/:uuid",  requireRole("SUPER_ADMIN", "ADMIN"), updateClientMeta);
router.delete("/meta/:uuid", requireRole("SUPER_ADMIN", "ADMIN"), deleteClientMeta);

// ── Single client ─────────────────────────────────────────────────────────────
router.get("/:uuid",         getClient);
router.patch("/:uuid",       requireRole("SUPER_ADMIN", "ADMIN", "TEAM_LEAD"), updateClient);
router.delete("/:uuid/hard", requireRole("SUPER_ADMIN"), hardDeleteClient);
router.delete("/:uuid",      requireRole("SUPER_ADMIN"), deleteClient);
router.post("/:uuid/logo", requireRole("SUPER_ADMIN", "ADMIN"), logoUploader.single("logo"), uploadClientLogo);

// ── Credentials ───────────────────────────────────────────────────────────────
router.post(  "/:uuid/credentials",         requireRole("SUPER_ADMIN", "ADMIN"), addCredential);
router.delete("/:uuid/credentials/:credId", requireRole("SUPER_ADMIN", "ADMIN"), deleteCredential);

// ── Documents ─────────────────────────────────────────────────────────────────
router.post(  "/:uuid/documents",        requireRole("SUPER_ADMIN", "ADMIN", "TEAM_LEAD"), docUploader.single("file"), uploadDocument);
router.delete("/:uuid/documents/:docId", requireRole("SUPER_ADMIN", "ADMIN"), deleteDocument);

// ── Contacts ──────────────────────────────────────────────────────────────────
router.get(   "/:uuid/contacts",              requireRole("SUPER_ADMIN", "ADMIN", "TEAM_LEAD", "EMPLOYEE"), listContacts);
router.post(  "/:uuid/contacts",              requireRole("SUPER_ADMIN", "ADMIN"), addContact);
router.patch( "/:uuid/contacts/:contactId",   requireRole("SUPER_ADMIN", "ADMIN"), updateContact);
router.delete("/:uuid/contacts/:contactId",   requireRole("SUPER_ADMIN", "ADMIN"), deleteContact);

// ── Payments ──────────────────────────────────────────────────────────────────
router.get(   "/:uuid/payments",              requireRole("SUPER_ADMIN", "ADMIN", "ACCOUNTANT"), listPayments);
router.post(  "/:uuid/payments",              requireRole("SUPER_ADMIN", "ADMIN", "ACCOUNTANT"), addPayment);
router.delete("/:uuid/payments/:paymentId",   requireRole("SUPER_ADMIN"), deletePayment);

// ── Tracking ──────────────────────────────────────────────────────────────────
router.patch("/:uuid/tracking", updateTracking);

// ── Timeline ──────────────────────────────────────────────────────────────────
router.get("/:uuid/timeline", requireRole("SUPER_ADMIN", "ADMIN"), getTimeline);

// ── Notes ─────────────────────────────────────────────────────────────────────
router.patch("/:uuid/notes", requireRole("SUPER_ADMIN", "ADMIN", "TEAM_LEAD"), updateNotes);

// ── PDF Export ────────────────────────────────────────────────────────────────
router.get("/:uuid/pdf", downloadClientPdf);

export default router;
