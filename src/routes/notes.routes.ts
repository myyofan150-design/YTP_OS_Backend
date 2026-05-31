// src/routes/notes.routes.ts

import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware";
import { createUploader } from "../lib/storage";

import {
  listNotes,
  getNote,
  createNote,
  updateNote,
  deleteNote,
  toggleStar,
  archiveNote,
  restoreNote,
  snoozeNote,
  duplicateNote,
  uploadAttachment,
  deleteAttachment,
  downloadAttachment,
  previewAttachment,
  getRecentSearches,
  searchNotes,
  clearRecentSearches,
  getNoteStats,
  addMentions,
  removeMention,
  listMentions,
  bulkStar,
  bulkArchive,
  bulkDelete,
  bulkTag,
} from "../controllers/notes.controller";

import {
  listTags,
  createTag,
  updateTag,
  deleteTag,
} from "../controllers/note-tags.controller";

const router = Router();
const attachUploader = createUploader("note-attachments", 25);

// ─── Health (no auth) ─────────────────────────────────────────────────────────
router.get("/health", (_req, res) => {
  res.json({ success: true, data: "Notes module ready", message: "ok" });
});

router.use(authenticate);

// ─── Tags ─────────────────────────────────────────────────────────────────────
router.get("/tags",           listTags);
router.post("/tags",          createTag);
router.patch("/tags/:uuid",   updateTag);
router.delete("/tags/:uuid",  deleteTag);

// ─── Static routes (must be before /:uuid) ────────────────────────────────────
router.get("/stats",               getNoteStats);
router.get("/search",              searchNotes);
router.get("/search/recent",       getRecentSearches);
router.delete("/search/recent",    clearRecentSearches);

// ─── Bulk operations (static, before /:uuid) ──────────────────────────────────
router.post("/bulk/star",     bulkStar);
router.post("/bulk/archive",  bulkArchive);
router.post("/bulk/delete",   bulkDelete);
router.post("/bulk/tag",      bulkTag);

// ─── Notes CRUD ───────────────────────────────────────────────────────────────
router.get("/",     listNotes);
router.post("/",    createNote);

router.get("/:uuid",               getNote);
router.patch("/:uuid",             updateNote);
router.delete("/:uuid",            deleteNote);
router.patch("/:uuid/star",        toggleStar);
router.patch("/:uuid/archive",     archiveNote);
router.patch("/:uuid/restore",     restoreNote);
router.patch("/:uuid/snooze",      snoozeNote);
router.post("/:uuid/duplicate",    duplicateNote);

// ─── Attachments ──────────────────────────────────────────────────────────────
router.post("/:uuid/attachments",                            attachUploader.single("file"), uploadAttachment);
router.delete("/:uuid/attachments/:attUuid",                 deleteAttachment);
router.get("/:uuid/attachments/:attUuid/download",           downloadAttachment);
router.get("/:uuid/attachments/:attUuid/preview",            previewAttachment);

// ─── Mentions ─────────────────────────────────────────────────────────────────
router.get("/:uuid/mentions",              listMentions);
router.post("/:uuid/mentions",             addMentions);
router.delete("/:uuid/mentions/:userId",   removeMention);

export default router;
