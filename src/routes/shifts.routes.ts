// src/routes/shifts.routes.ts
import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import { listShifts, createShift, updateShift, deleteShift } from "../controllers/shifts.controller";

const router = Router();
router.use(authenticate);

const HR_ROLES = ["SUPER_ADMIN", "ADMIN", "HR"] as const;

router.get("/",       listShifts);
router.post("/",      requireRole(...HR_ROLES), createShift);
router.put("/:id",    requireRole(...HR_ROLES), updateShift);
router.delete("/:id", requireRole(...HR_ROLES), deleteShift);

export default router;
