// src/routes/holidays.routes.ts
import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import {
  listHolidays,
  createHoliday,
  deleteHoliday,
  bulkMarkHolidayAttendance,
} from "../controllers/holidays.controller";

const router = Router();
router.use(authenticate);

const HR_ROLES = ["SUPER_ADMIN", "ADMIN", "HR"] as const;

router.get("/",               listHolidays);
router.post("/",              requireRole(...HR_ROLES), createHoliday);
router.delete("/:id",         requireRole(...HR_ROLES), deleteHoliday);
router.post("/bulk-mark",     requireRole(...HR_ROLES), bulkMarkHolidayAttendance);

export default router;
