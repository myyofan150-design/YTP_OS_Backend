// src/routes/comp-off.routes.ts
import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import {
  requestCompOff,
  myCompOffRequests,
  pendingCompOffRequests,
  allCompOffRequests,
  reviewCompOffRequest,
} from "../controllers/comp-off.controller";

const router = Router();
router.use(authenticate);

const HR_ROLES = ["SUPER_ADMIN", "ADMIN", "HR"] as const;

// Employee-facing
router.post("/request",      requestCompOff);
router.get("/my-requests",   myCompOffRequests);

// HR-facing
router.get("/pending",       requireRole(...HR_ROLES), pendingCompOffRequests);
router.get("/all",           requireRole(...HR_ROLES), allCompOffRequests);
router.patch("/:uuid/review", requireRole(...HR_ROLES), reviewCompOffRequest);

export default router;
