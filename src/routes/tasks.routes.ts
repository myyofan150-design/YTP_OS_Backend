// src/routes/tasks.routes.ts

import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import { createUploader } from "../lib/storage";
import {
  listTasks,
  createTask,
  getTask,
  updateTask,
  deleteTask,
  updateTaskStatus,
  addComment,
  deleteComment,
  uploadAttachment,
  deleteAttachment,
} from "../controllers/tasks.controller";

const router = Router();
const attachUploader = createUploader("task-attachments", 20);

router.use(authenticate);

// Collection
router.get("/",  listTasks);
router.post("/", createTask);

// Single task
router.get("/:uuid",    getTask);
router.patch("/:uuid",  updateTask);
router.delete("/:uuid", requireRole("SUPER_ADMIN", "ADMIN"), deleteTask);

// Kanban status shortcut
router.patch("/:uuid/status", updateTaskStatus);

// Comments
router.post("/:uuid/comments",                addComment);
router.delete("/:uuid/comments/:commentId",   deleteComment);

// Attachments
router.post("/:uuid/attachments",             attachUploader.single("file"), uploadAttachment);
router.delete("/:uuid/attachments/:attachId", deleteAttachment);

export default router;
