// src/routes/auth.routes.ts
// Public:    POST /login, POST /2fa/verify
// Protected: GET /me, PATCH /change-password, PATCH /avatar, PATCH /2fa/toggle

import { Router } from "express";
import { login, me, changePassword, uploadAvatar, verify2fa, toggle2fa } from "../controllers/auth.controller";
import { authenticate } from "../middleware/auth.middleware";
import { createUploader } from "../lib/storage";

const router = Router();
const avatarUpload = createUploader("avatars", 5);

router.post("/login",            login);
router.post("/2fa/verify",       verify2fa);
router.get("/me",                authenticate, me);
router.patch("/change-password", authenticate, changePassword);
router.patch("/avatar",          authenticate, avatarUpload.single("avatar"), uploadAvatar);
router.patch("/2fa/toggle",      authenticate, toggle2fa);

export default router;
