// src/routes/auth.routes.ts
// Public: POST /login
// Protected: GET /me, PATCH /change-password, PATCH /avatar

import { Router } from "express";
import { login, me, changePassword, uploadAvatar } from "../controllers/auth.controller";
import { authenticate } from "../middleware/auth.middleware";
import { createUploader } from "../lib/storage";

const router = Router();
const avatarUpload = createUploader("avatars", 5);

router.post("/login", login);
router.get("/me", authenticate, me);
router.patch("/change-password", authenticate, changePassword);
router.patch("/avatar", authenticate, avatarUpload.single("avatar"), uploadAvatar);

export default router;
