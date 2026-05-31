// src/routes/settings.routes.ts
import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import { createUploader } from "../lib/storage";
import { getGeneralSettings, updateGeneralSettings, uploadCompanyLogo } from "../controllers/settings.controller";

const router = Router();
const logoUploader = createUploader("settings", 2);

// GET /general is public — needed by login page for branding
router.get("/general",       getGeneralSettings);
router.patch("/general",     authenticate, requireRole("SUPER_ADMIN"), updateGeneralSettings);
router.post("/general/logo", authenticate, requireRole("SUPER_ADMIN"), logoUploader.single("logo"), uploadCompanyLogo);

export default router;
