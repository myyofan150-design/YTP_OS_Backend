// src/routes/chat.routes.ts
import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware";
import { createUploader } from "../lib/storage";

import {
  listConversations,
  getConversation,
  createDirectConversation,
  createGroupConversation,
  createContextualConversation,
  updateConversation,
  archiveConversation,
  addMembers,
  removeMember,
  leaveConversation,
  updateMemberRole,
  muteConversation,
  markAsRead,
  getUnreadCounts,
  getPinnedMessages,
  searchConversations,
} from "../controllers/chat-conversations.controller";

import {
  listMessages,
  sendMessage,
  sendAttachment,
  editMessage,
  deleteMessage,
  addReaction,
  removeReaction,
  pinMessage,
  unpinMessage,
  markMessageRead,
  getMessageReadStatus,
  downloadAttachment,
  downloadAttachmentByUuid,
  previewAttachmentByUuid,
  searchMessages,
  searchFiles,
} from "../controllers/chat-messages.controller";

const router = Router();
const attachUploader = createUploader("chat-attachments", 50);

// ─── Health (no auth) ─────────────────────────────────────────────────────────
router.get("/health", (_req, res) => {
  res.json({ success: true, data: "Chat module ready", message: "ok" });
});

router.use(authenticate);

// ─── Unread counts (global) ───────────────────────────────────────────────────
router.get("/unread", getUnreadCounts);

// ─── Conversations ────────────────────────────────────────────────────────────
router.get("/conversations",               listConversations);
router.get("/conversations/search",        searchConversations);
router.post("/conversations/direct",       createDirectConversation);
router.post("/conversations/group",        createGroupConversation);
router.post("/conversations/contextual",   createContextualConversation);

router.get("/conversations/:uuid",                    getConversation);
router.patch("/conversations/:uuid",                  updateConversation);
router.patch("/conversations/:uuid/archive",          archiveConversation);
router.patch("/conversations/:uuid/mute",             muteConversation);
router.post("/conversations/:uuid/read",              markAsRead);
router.get("/conversations/:uuid/pins",               getPinnedMessages);

// ─── Conversation members ─────────────────────────────────────────────────────
router.post("/conversations/:uuid/members",                        addMembers);
router.delete("/conversations/:uuid/members/:userUuid",            removeMember);
router.post("/conversations/:uuid/leave",                          leaveConversation);
router.patch("/conversations/:uuid/members/:userUuid/role",        updateMemberRole);

// ─── Messages ─────────────────────────────────────────────────────────────────
router.get("/conversations/:uuid/messages",                        listMessages);
router.post("/conversations/:uuid/messages",                       sendMessage);
router.post("/conversations/:uuid/messages/attachment",            attachUploader.single("file"), sendAttachment);
router.get("/conversations/:uuid/search",                          searchMessages);

router.patch("/conversations/:convUuid/messages/:msgUuid",         editMessage);
router.delete("/conversations/:convUuid/messages/:msgUuid",        deleteMessage);

// ─── Reactions ────────────────────────────────────────────────────────────────
router.post("/conversations/:convUuid/messages/:msgUuid/reactions",           addReaction);
router.delete("/conversations/:convUuid/messages/:msgUuid/reactions/:emoji",  removeReaction);

// ─── Pin / Unpin ──────────────────────────────────────────────────────────────
router.post("/conversations/:convUuid/messages/:msgUuid/pin",   pinMessage);
router.delete("/conversations/:convUuid/messages/:msgUuid/pin", unpinMessage);

// ─── Read receipts ────────────────────────────────────────────────────────────
router.post("/conversations/:convUuid/messages/:msgUuid/read",  markMessageRead);
router.get("/conversations/:convUuid/messages/:msgUuid/read",   getMessageReadStatus);

// ─── Attachment download ──────────────────────────────────────────────────────
router.get(
  "/conversations/:convUuid/messages/:msgUuid/attachments/:attUuid/download",
  downloadAttachment
);

// ─── Global attachment access (by attachment UUID only) ───────────────────────
router.get("/attachments/:attUuid/download", downloadAttachmentByUuid);
router.get("/attachments/:attUuid/preview",  previewAttachmentByUuid);

// ─── Global file search ───────────────────────────────────────────────────────
router.get("/search/files", searchFiles);

export default router;
