// src/routes/leave.routes.ts

import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import {
  applyLeave,
  myLeaveRequests,
  cancelLeave,
  pendingLeaves,
  allLeaves,
  reviewLeave,
  leaveCalendar,
} from "../controllers/leave.controller";

const router = Router();
router.use(authenticate);

const HR_ROLES = ["SUPER_ADMIN", "ADMIN", "HR"] as const;

// Employee-facing
router.post("/",                 applyLeave);
router.get("/my-requests",       myLeaveRequests);
router.patch("/:uuid/cancel",    cancelLeave);

// HR-facing
router.get("/pending",     requireRole(...HR_ROLES), pendingLeaves);
router.get("/all",         requireRole(...HR_ROLES), allLeaves);
router.patch("/:uuid/review", requireRole(...HR_ROLES), reviewLeave);

// All roles
router.get("/calendar",    leaveCalendar);

export default router;
