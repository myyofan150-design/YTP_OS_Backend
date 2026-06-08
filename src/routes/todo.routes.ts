// src/routes/todo.routes.ts

import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware";
import { createUploader } from "../lib/storage";

import {
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  reorderGroups,
  getGroupMembers,
  addGroupMembers,
  removeGroupMember,
} from "../controllers/todo-groups.controller";

import {
  listLists,
  createList,
  getList,
  updateList,
  deleteList,
  reorderLists,
  toggleListFavorite,
  getListMembers,
  addListMembers,
  removeListMember,
} from "../controllers/todo-lists.controller";

import {
  listTasks,
  createTask,
  getTask,
  updateTask,
  deleteTask,
  updateTaskStatus,
  toggleTaskFavorite,
  reorderTasks,
  // Subtasks
  listSubtasks,
  createSubtask,
  updateSubtask,
  deleteSubtask,
  reorderSubtasks,
  // Attachments
  uploadAttachment,
  deleteAttachment,
  downloadAttachment,
  // Notes
  getNote,
  upsertNote,
  // Activity
  listActivity,
  // Reminders
  setReminder,
  deleteReminder,
  // Repeat
  updateRepeat,
  // Smart views
  getSmartView,
  getSmartCounts,
} from "../controllers/todo-tasks.controller";

const router = Router();
const attachUploader = createUploader("todo-attachments", 10);

// ─── Health (no auth) ─────────────────────────────────────────────────────────
router.get("/health", (_req, res) => {
  res.json({ success: true, data: "Todo module ready", message: "ok" });
});

router.use(authenticate);

// ─── Smart Views ──────────────────────────────────────────────────────────────
// GET /api/todo/smart-counts          — counts for all smart views (nav badges)
// GET /api/todo/smart/:view           — today | assigned-to-me | important | completed | overdue
router.get("/smart-counts", getSmartCounts);
router.get("/smart/:view", getSmartView);

// ─── Groups ───────────────────────────────────────────────────────────────────
// GET    /api/todo/groups                          — list own + shared groups
// POST   /api/todo/groups                          — create a group
// PATCH  /api/todo/groups/reorder                  — bulk sort update (static before :uuid)
// PATCH  /api/todo/groups/:uuid                    — rename / recolor a group (creator only)
// DELETE /api/todo/groups/:uuid                    — delete group (creator only)
// GET    /api/todo/groups/:uuid/members            — list group members
// POST   /api/todo/groups/:uuid/members            — add members { userIds: number[] }
// DELETE /api/todo/groups/:uuid/members/:memberId  — remove one member
router.get("/groups",                                listGroups);
router.post("/groups",                               createGroup);
router.patch("/groups/reorder",                      reorderGroups);
router.patch("/groups/:uuid",                        updateGroup);
router.delete("/groups/:uuid",                       deleteGroup);
router.get("/groups/:uuid/members",                  getGroupMembers);
router.post("/groups/:uuid/members",                 addGroupMembers);
router.delete("/groups/:uuid/members/:memberId",     removeGroupMember);

// ─── Lists ────────────────────────────────────────────────────────────────────
// GET    /api/todo/lists               — list all lists (?groupId=uuid&isFavorite=true)
// POST   /api/todo/lists               — create a list
// PATCH  /api/todo/lists/reorder       — bulk sort + group-move
// GET    /api/todo/lists/:uuid         — list details + tasks (with subtask counts)
// PATCH  /api/todo/lists/:uuid         — update list
// DELETE /api/todo/lists/:uuid         — delete list (tasks cascade)
// PATCH  /api/todo/lists/:uuid/favorite — toggle isFavorite
router.get("/lists",                   listLists);
router.post("/lists",                  createList);
router.patch("/lists/reorder",         reorderLists);
router.get("/lists/:uuid",                     getList);
router.patch("/lists/:uuid",                   updateList);
router.delete("/lists/:uuid",                  deleteList);
router.patch("/lists/:uuid/favorite",          toggleListFavorite);

// ─── List Members ──────────────────────────────────────────────────────────────
// GET    /api/todo/lists/:uuid/members              — list members
// POST   /api/todo/lists/:uuid/members              — add members { userIds: number[] }
// DELETE /api/todo/lists/:uuid/members/:memberId    — remove one member
router.get("/lists/:uuid/members",             getListMembers);
router.post("/lists/:uuid/members",            addListMembers);
router.delete("/lists/:uuid/members/:memberId", removeListMember);

// ─── Tasks (list-scoped) ──────────────────────────────────────────────────────
// GET  /api/todo/lists/:listUuid/tasks  — tasks in a specific list
// POST /api/todo/lists/:listUuid/tasks  — create task in a list
router.get("/lists/:listUuid/tasks",  listTasks);
router.post("/lists/:listUuid/tasks", createTask);

// ─── Tasks (global) ───────────────────────────────────────────────────────────
// GET   /api/todo/tasks               — filtered search (?listId=&search=&status=&priority=&dueDate=)
// PATCH /api/todo/tasks/reorder       — bulk sort + optional list move (static before :uuid)
// GET   /api/todo/tasks/:uuid         — full task details (subtasks, attachments, note, activity)
// PATCH /api/todo/tasks/:uuid         — update task fields
// DELETE /api/todo/tasks/:uuid        — delete task (cascade)
// PATCH /api/todo/tasks/:uuid/status  — toggle pending ↔ completed
// PATCH /api/todo/tasks/:uuid/favorite — toggle isFavorite
router.get("/tasks",                  listTasks);
router.patch("/tasks/reorder",        reorderTasks);
router.get("/tasks/:uuid",            getTask);
router.patch("/tasks/:uuid",          updateTask);
router.delete("/tasks/:uuid",         deleteTask);
router.patch("/tasks/:uuid/status",   updateTaskStatus);
router.patch("/tasks/:uuid/favorite", toggleTaskFavorite);

// ─── Subtasks ─────────────────────────────────────────────────────────────────
// GET    /api/todo/tasks/:uuid/subtasks          — list subtasks ordered by sort_order
// POST   /api/todo/tasks/:uuid/subtasks          — add a subtask
// PATCH  /api/todo/tasks/:uuid/subtasks/reorder  — bulk sort (static before :subUuid)
// PATCH  /api/todo/tasks/:uuid/subtasks/:subUuid — update title / status
// DELETE /api/todo/tasks/:uuid/subtasks/:subUuid — delete subtask
router.get("/tasks/:uuid/subtasks",                  listSubtasks);
router.post("/tasks/:uuid/subtasks",                 createSubtask);
router.patch("/tasks/:uuid/subtasks/reorder",        reorderSubtasks);
router.patch("/tasks/:uuid/subtasks/:subUuid",       updateSubtask);
router.delete("/tasks/:uuid/subtasks/:subUuid",      deleteSubtask);

// ─── Attachments ──────────────────────────────────────────────────────────────
// POST   /api/todo/tasks/:uuid/attachments                    — upload (multipart, field: file)
// GET    /api/todo/tasks/:uuid/attachments/:attUuid/download  — stream file as download
// DELETE /api/todo/tasks/:uuid/attachments/:attUuid           — delete file + record
router.post("/tasks/:uuid/attachments",                       attachUploader.single("file"), uploadAttachment);
router.get("/tasks/:uuid/attachments/:attUuid/download",      downloadAttachment);
router.delete("/tasks/:uuid/attachments/:attUuid",            deleteAttachment);

// ─── Notes ────────────────────────────────────────────────────────────────────
// GET /api/todo/tasks/:uuid/note  — get rich-text note (returns { content: "" } if none)
// PUT /api/todo/tasks/:uuid/note  — create or replace note (TipTap HTML)
router.get("/tasks/:uuid/note", getNote);
router.put("/tasks/:uuid/note", upsertNote);

// ─── Reminders ────────────────────────────────────────────────────────────────
// PATCH  /api/todo/tasks/:uuid/reminder — set reminder (body: { reminderAt } or { quickOption })
// DELETE /api/todo/tasks/:uuid/reminder — remove reminder
router.patch("/tasks/:uuid/reminder",  setReminder);
router.delete("/tasks/:uuid/reminder", deleteReminder);

// ─── Repeat ───────────────────────────────────────────────────────────────────
// PATCH /api/todo/tasks/:uuid/repeat — update repeat type + config
router.patch("/tasks/:uuid/repeat", updateRepeat);

// ─── Activity ─────────────────────────────────────────────────────────────────
// GET /api/todo/tasks/:uuid/activity  — paginated activity log (?page=&limit=)
router.get("/tasks/:uuid/activity", listActivity);

export default router;
