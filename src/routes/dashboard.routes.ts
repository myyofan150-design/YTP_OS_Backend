// src/routes/dashboard.routes.ts
import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import {
  getStats,
  getRevenueChart,
  getTaskChart,
  getAttendanceSummary,
  getActivityLogs,
} from "../controllers/dashboard.controller";

const router = Router();
router.use(authenticate);

const ADMIN_ROLES = ["SUPER_ADMIN", "ADMIN"] as const;

router.get("/stats",              requireRole(...ADMIN_ROLES), getStats);
router.get("/revenue-chart",      requireRole("SUPER_ADMIN","ADMIN","ACCOUNTANT"), getRevenueChart);
router.get("/task-chart",         getTaskChart);
router.get("/attendance-summary", requireRole("SUPER_ADMIN","ADMIN","HR"), getAttendanceSummary);
router.get("/activity-logs",      requireRole(...ADMIN_ROLES), getActivityLogs);

export default router;
