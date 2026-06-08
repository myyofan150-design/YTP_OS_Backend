import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware";
import { globalSearch } from "../controllers/search.controller";

const router = Router();
router.get("/", authenticate, globalSearch);
export default router;
