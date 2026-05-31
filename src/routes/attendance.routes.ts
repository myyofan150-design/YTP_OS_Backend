// src/routes/attendance.routes.ts

import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import {
  clockIn,
  clockOut,
  getToday,
  myHistory,
  teamAttendance,
  overrideAttendance,
  attendanceSummary,
} from "../controllers/attendance.controller";

const router = Router();
router.use(authenticate);

const HR_ROLES = ["SUPER_ADMIN", "ADMIN", "HR"] as const;

// Employee-facing
router.post("/clock-in",   clockIn);
router.post("/clock-out",  clockOut);
router.get("/today",       getToday);
router.get("/my-history",  myHistory);

// HR-facing
router.get("/team",        requireRole(...HR_ROLES), teamAttendance);
router.get("/summary",     requireRole(...HR_ROLES), attendanceSummary);
router.patch("/:id/override", requireRole(...HR_ROLES), overrideAttendance);

export default router;
