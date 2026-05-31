// src/routes/users.routes.ts
// All user management endpoints. Requires ADMIN or SUPER_ADMIN.

import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import {
  listUsers,
  getUser,
  createUser,
  updateUser,
  toggleUserStatus,
  resetPassword,
} from "../controllers/users.controller";

const router = Router();

// All user routes require authentication
router.use(authenticate);

// List and create — ADMIN+
router.get("/",    requireRole("SUPER_ADMIN", "ADMIN"), listUsers);
router.post("/",   requireRole("SUPER_ADMIN", "ADMIN"), createUser);

// Single user operations — ADMIN+ (any user can GET their own via /me)
router.get("/:id",                requireRole("SUPER_ADMIN", "ADMIN"), getUser);
router.put("/:id",                requireRole("SUPER_ADMIN", "ADMIN"), updateUser);
router.patch("/:id/status",       requireRole("SUPER_ADMIN", "ADMIN"), toggleUserStatus);
router.patch("/:id/reset-password", requireRole("SUPER_ADMIN", "ADMIN"), resetPassword);

export default router;
