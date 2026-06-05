// src/routes/attendance.routes.ts
import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import {
  clockIn, clockOut, getToday, myHistory, attendanceSummary,
  teamAttendance, liveBoard, todayAbsentees, overrideAttendance,
  submitRegularize, myRegularizations, pendingRegularizations, reviewRegularization,
  submitWFH, myWFHRequests, pendingWFHRequests, reviewWFH,
  attendanceReport, getPolicies, updatePolicies,
} from "../controllers/attendance.controller";

const router = Router();
router.use(authenticate);

const HR_ROLES   = ["SUPER_ADMIN", "ADMIN", "HR"] as const;
const ADMIN_ONLY = ["SUPER_ADMIN", "ADMIN"] as const;

// ─── Employee self-service ──────────────────────────────────────────────────
router.post("/clock-in",        clockIn);
router.post("/clock-out",       clockOut);
router.get("/today",            getToday);
router.get("/my-history",       myHistory);
router.get("/summary",          attendanceSummary);

// ─── Regularization (employee submits, HR reviews) ─────────────────────────
router.post("/regularize",                  submitRegularize);
router.get("/regularize/my",               myRegularizations);
router.get("/regularize/pending",           requireRole(...HR_ROLES), pendingRegularizations);
router.put("/regularize/:id/review",        requireRole(...HR_ROLES), reviewRegularization);

// ─── WFH (employee submits, HR reviews) ─────────────────────────────────────
router.post("/wfh",                submitWFH);
router.get("/wfh/my",              myWFHRequests);
router.get("/wfh/pending",         requireRole(...HR_ROLES), pendingWFHRequests);
router.put("/wfh/:id/review",      requireRole(...HR_ROLES), reviewWFH);

// ─── HR / Admin views ───────────────────────────────────────────────────────
router.get("/team",              requireRole(...HR_ROLES), teamAttendance);
router.get("/live",              requireRole(...HR_ROLES), liveBoard);
router.get("/absentees/today",   requireRole(...HR_ROLES), todayAbsentees);
router.get("/report",            requireRole(...HR_ROLES), attendanceReport);
router.patch("/:id/override",    requireRole(...HR_ROLES), overrideAttendance);

// ─── Policies (Admin only) ──────────────────────────────────────────────────
router.get("/policies",          requireRole(...HR_ROLES), getPolicies);
router.put("/policies",          requireRole(...ADMIN_ONLY), updatePolicies);

export default router;
