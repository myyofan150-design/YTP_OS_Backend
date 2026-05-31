// src/routes/workspace.routes.ts
import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import {
  listWorkspaces,
  createWorkspace,
  getWorkspace,
  addProperty,
  deleteProperty,
  createEntry,
  updateEntry,
  deleteEntry,
} from "../controllers/workspace.controller";

const router = Router();
router.use(authenticate);

const ADMIN_ROLES = ["SUPER_ADMIN", "ADMIN"] as const;

router.get("/",    listWorkspaces);
router.post("/",   requireRole(...ADMIN_ROLES), createWorkspace);

router.get("/:uuid",                               getWorkspace);
router.post("/:uuid/properties",                   requireRole(...ADMIN_ROLES), addProperty);
router.delete("/:uuid/properties/:propId",         requireRole(...ADMIN_ROLES), deleteProperty);
router.post("/:uuid/entries",                      createEntry);
router.patch("/:uuid/entries/:entryUuid",          updateEntry);
router.delete("/:uuid/entries/:entryUuid",         deleteEntry);

export default router;
