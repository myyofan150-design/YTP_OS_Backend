// src/controllers/chat-messages.controller.ts
import { Request, Response } from "express";
import { q, run, RowDataPacket } from "../lib/db";
import { canUserPostInConversation } from "../lib/chat-permissions";
import { uploadFile } from "../lib/storage";
import { emitToConversation } from "../lib/socket";

const ADMIN_ROLES = ["SUPER_ADMIN", "ADMIN"];

const ALLOWED_CHAT_MIME = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "video/mp4", "video/quicktime",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/zip", "application/x-zip-compressed",
]);

const INLINE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// ─── Shared helpers ───────────────────────────────────────────────────────────

interface MemberRecord {
  conversationId: number;
  memberRole: "admin" | "member";
  isMuted: boolean;
  isAnnouncementOnly: boolean;
  convName: string;
  convUuid: string;
}

async function getMemberRecord(convUuid: string, userId: number): Promise<MemberRecord | null> {
  const [row] = await q<RowDataPacket>(
    `SELECT c.id AS conversationId, c.name AS convName, c.uuid AS convUuid,
            c.is_announcement_only AS isAnnouncementOnly,
            cm.role AS memberRole, cm.is_muted AS isMuted
     FROM conversations c
     JOIN conversation_members cm
       ON cm.conversation_id = c.id AND cm.user_id = ? AND cm.left_at IS NULL
     WHERE c.uuid = ?`,
    [userId, convUuid]
  );
  if (!row) return null;
  return {
    conversationId:     Number(row["conversationId"]),
    memberRole:         row["memberRole"] as "admin" | "member",
    isMuted:            Boolean(row["isMuted"]),
    isAnnouncementOnly: Boolean(row["isAnnouncementOnly"]),
    convName:           String(row["convName"] ?? ""),
    convUuid:           String(row["convUuid"]),
  };
}

async function fetchReactions(messageId: unknown, userId: number): Promise<object[]> {
  const rows = await q<RowDataPacket>(
    `SELECT emoji, COUNT(*) AS cnt, GROUP_CONCAT(user_id) AS userIds
     FROM message_reactions WHERE message_id = ? GROUP BY emoji`,
    [messageId]
  );
  return rows.map(r => {
    const userIds = String(r["userIds"] ?? "").split(",").map(Number).filter(Boolean);
    return {
      emoji:       r["emoji"],
      count:       Number(r["cnt"]),
      users:       userIds,
      userReacted: userIds.includes(userId),
    };
  });
}

async function fetchAttachments(messageId: unknown): Promise<object[]> {
  const rows = await q<RowDataPacket>(
    `SELECT id, uuid, message_id AS messageId, file_name AS fileName, file_path AS filePath,
            file_size AS fileSize, file_type AS fileType, thumbnail_path AS thumbnailPath,
            download_count AS downloadCount, created_at AS createdAt
     FROM message_attachments WHERE message_id = ?`,
    [messageId]
  );
  return rows.map(r => ({
    id:            r["id"],
    uuid:          r["uuid"],
    messageId:     r["messageId"],
    fileName:      r["fileName"],
    filePath:      r["filePath"],
    fileSize:      Number(r["fileSize"]),
    fileType:      r["fileType"],
    thumbnailPath: r["thumbnailPath"] ?? null,
    downloadCount: Number(r["downloadCount"]),
    createdAt:     r["createdAt"],
  }));
}

function shapeMessage(
  row: RowDataPacket,
  reactions: object[] = [],
  attachments: object[] = [],
  replyTo: object | null = null
): object {
  const isDeleted = Boolean(row["isDeleted"]);
  return {
    id:             row["id"],
    uuid:           row["uuid"],
    conversationId: row["conversationId"],
    senderId:       row["senderId"],
    type:           row["type"],
    content:        isDeleted ? "This message was deleted" : (row["content"] ?? ""),
    replyToId:      row["replyToId"] ?? null,
    replyTo,
    isEdited:       Boolean(row["isEdited"]),
    editedAt:       row["editedAt"] ?? null,
    isDeleted,
    isPinned:       Boolean(row["isPinned"]),
    pinnedBy:       row["pinnedBy"] ?? null,
    pinnedAt:       row["pinnedAt"] ?? null,
    createdAt:      row["createdAt"],
    sender: row["senderName"] != null ? {
      uuid:      row["senderUuid"] ?? null,
      name:      row["senderName"],
      avatarUrl: row["senderAvatar"] ?? null,
    } : null,
    reactions,
    attachments,
  };
}

async function fetchFullMessage(msgId: number | string, userId: number): Promise<object | null> {
  const [row] = await q<RowDataPacket>(
    `SELECT m.id, m.uuid, m.conversation_id AS conversationId, m.sender_id AS senderId,
            m.type, m.content, m.reply_to_id AS replyToId,
            m.is_edited AS isEdited, m.edited_at AS editedAt,
            m.is_deleted AS isDeleted, m.is_pinned AS isPinned,
            m.pinned_by AS pinnedBy, m.pinned_at AS pinnedAt, m.created_at AS createdAt,
            u.uuid AS senderUuid, u.name AS senderName, u.avatar_url AS senderAvatar
     FROM messages m JOIN users u ON u.id = m.sender_id
     WHERE m.id = ?`,
    [msgId]
  );
  if (!row) return null;

  const [reactions, attachments] = await Promise.all([
    fetchReactions(row["id"], userId),
    fetchAttachments(row["id"]),
  ]);

  let replyTo: object | null = null;
  if (row["replyToId"]) {
    const [rr] = await q<RowDataPacket>(
      `SELECT m.id, m.uuid, m.content, m.type, m.sender_id AS senderId,
              m.created_at AS createdAt, u.name AS senderName
       FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`,
      [row["replyToId"]]
    );
    if (rr) {
      replyTo = {
        id: rr["id"], uuid: rr["uuid"], content: rr["content"],
        type: rr["type"], senderId: rr["senderId"],
        senderName: rr["senderName"], createdAt: rr["createdAt"],
      };
    }
  }

  return shapeMessage(row, reactions, attachments, replyTo);
}

async function sysMsg(conversationId: number, senderId: number, content: string): Promise<void> {
  await run(
    `INSERT INTO messages (conversation_id, sender_id, type, content) VALUES (?, ?, 'system', ?)`,
    [conversationId, senderId, content]
  );
  await run(
    `UPDATE conversations SET last_message_at = NOW(), last_message_preview = ? WHERE id = ?`,
    [content.slice(0, 300), conversationId]
  );
}

async function notifyOtherMembers(
  conversationId: number, excludeUserId: number, title: string, body: string, link: string
): Promise<void> {
  const members = await q<RowDataPacket>(
    `SELECT user_id FROM conversation_members
     WHERE conversation_id = ? AND user_id != ? AND left_at IS NULL AND is_muted = FALSE`,
    [conversationId, excludeUserId]
  );
  for (const m of members) {
    run(
      `INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, 'GENERAL', ?, ?, ?)`,
      [m["user_id"], title, body.slice(0, 60), link]
    ).catch(() => {});
  }
}

async function verifyAttachmentAccess(attUuid: string, userId: number): Promise<RowDataPacket | null> {
  const [row] = await q<RowDataPacket>(
    `SELECT ma.id, ma.file_path AS filePath, ma.file_name AS fileName, ma.file_type AS fileType
     FROM message_attachments ma
     JOIN messages m ON m.id = ma.message_id
     JOIN conversation_members cm
       ON cm.conversation_id = m.conversation_id AND cm.user_id = ? AND cm.left_at IS NULL
     WHERE ma.uuid = ?`,
    [userId, attUuid]
  );
  return row ?? null;
}

// With memory storage the file buffer is never written to disk, so no cleanup needed on rejection.

// ─── Section A: Messages ──────────────────────────────────────────────────────

export async function listMessages(req: Request, res: Response): Promise<void> {
  try {
    const { uuid }                  = req.params as Record<string, string>;
    const userId                    = req.user!.id;
    const { before, limit = "30" }  = req.query as Record<string, string | undefined>;

    const member = await getMemberRecord(uuid, userId);
    if (!member) {
      res.status(403).json({ success: false, message: "You are not a member of this conversation" });
      return;
    }

    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 30));
    const params: unknown[] = [member.conversationId];
    let cursorClause = "";

    if (before) {
      const [cursor] = await q<RowDataPacket>(
        `SELECT id FROM messages WHERE uuid = ? AND conversation_id = ?`,
        [before, member.conversationId]
      );
      if (cursor) {
        cursorClause = " AND m.id < ?";
        params.push(cursor["id"]);
      }
    }

    params.push(limitNum + 1); // one extra to check hasMore

    const rows = await q<RowDataPacket>(
      `SELECT m.id, m.uuid, m.conversation_id AS conversationId, m.sender_id AS senderId,
              m.type, m.content, m.reply_to_id AS replyToId,
              m.is_edited AS isEdited, m.edited_at AS editedAt,
              m.is_deleted AS isDeleted, m.is_pinned AS isPinned,
              m.pinned_by AS pinnedBy, m.pinned_at AS pinnedAt, m.created_at AS createdAt,
              u.uuid AS senderUuid, u.name AS senderName, u.avatar_url AS senderAvatar
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = ?${cursorClause}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ?`,
      params
    );

    const hasMore  = rows.length > limitNum;
    const pageRows = hasMore ? rows.slice(0, limitNum) : rows;

    if (pageRows.length === 0) {
      res.json({ success: true, message: "OK", data: { messages: [], hasMore: false, nextCursor: null } });
      return;
    }

    // Batch-fetch reactions, attachments and reply-to messages
    const msgIds    = pageRows.map(r => r["id"]);
    const ph        = msgIds.map(() => "?").join(",");
    const replyIds  = pageRows.filter(r => r["replyToId"]).map(r => r["replyToId"]);

    const [reactRows, attRows, replyRows] = await Promise.all([
      q<RowDataPacket>(
        `SELECT message_id AS mid, emoji, COUNT(*) AS cnt, GROUP_CONCAT(user_id) AS userIds
         FROM message_reactions WHERE message_id IN (${ph}) GROUP BY message_id, emoji`,
        msgIds
      ),
      q<RowDataPacket>(
        `SELECT id, uuid, message_id AS messageId, file_name AS fileName, file_path AS filePath,
                file_size AS fileSize, file_type AS fileType, thumbnail_path AS thumbnailPath,
                download_count AS downloadCount, created_at AS createdAt
         FROM message_attachments WHERE message_id IN (${ph})`,
        msgIds
      ),
      replyIds.length > 0
        ? q<RowDataPacket>(
            `SELECT m.id, m.uuid, m.content, m.type, m.sender_id AS senderId,
                    m.created_at AS createdAt, u.name AS senderName
             FROM messages m JOIN users u ON u.id = m.sender_id
             WHERE m.id IN (${replyIds.map(() => "?").join(",")})`,
            replyIds
          )
        : Promise.resolve([] as RowDataPacket[]),
    ]);

    // Group by message id (BIGINT → string key)
    const reactMap: Record<string, { emoji: string; count: number; users: number[]; userReacted: boolean }[]> = {};
    for (const r of reactRows) {
      const key = String(r["mid"]);
      if (!reactMap[key]) reactMap[key] = [];
      const userIds = String(r["userIds"] ?? "").split(",").map(Number).filter(Boolean);
      reactMap[key].push({
        emoji:       r["emoji"],
        count:       Number(r["cnt"]),
        users:       userIds,
        userReacted: userIds.includes(userId),
      });
    }

    const attMap: Record<string, object[]> = {};
    for (const a of attRows) {
      const key = String(a["messageId"]);
      if (!attMap[key]) attMap[key] = [];
      attMap[key].push({
        id:            a["id"],
        uuid:          a["uuid"],
        messageId:     a["messageId"],
        fileName:      a["fileName"],
        filePath:      a["filePath"],
        fileSize:      Number(a["fileSize"]),
        fileType:      a["fileType"],
        thumbnailPath: a["thumbnailPath"] ?? null,
        downloadCount: Number(a["downloadCount"]),
        createdAt:     a["createdAt"],
      });
    }

    const replyMap: Record<string, object> = {};
    for (const r of replyRows) {
      replyMap[String(r["id"])] = {
        id: r["id"], uuid: r["uuid"], content: r["content"],
        type: r["type"], senderId: r["senderId"],
        senderName: r["senderName"], createdAt: r["createdAt"],
      };
    }

    const messages = pageRows.map(row => {
      const key    = String(row["id"]);
      const rtoKey = row["replyToId"] ? String(row["replyToId"]) : null;
      return shapeMessage(
        row,
        reactMap[key]  ?? [],
        attMap[key]    ?? [],
        rtoKey ? (replyMap[rtoKey] ?? null) : null
      );
    });

    res.json({
      success: true, message: "OK",
      data: {
        messages,
        hasMore,
        nextCursor: hasMore ? String(pageRows[pageRows.length - 1]["uuid"]) : null,
      },
    });
  } catch (err) {
    console.error("[chat/listMessages]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── sendMessage ──────────────────────────────────────────────────────────────

export async function sendMessage(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;
    const userRole = req.user!.role;

    const member = await getMemberRecord(uuid, userId);
    if (!member) {
      res.status(403).json({ success: false, message: "You are not a member of this conversation" });
      return;
    }

    if (!canUserPostInConversation(userRole, member.isAnnouncementOnly, member.memberRole)) {
      res.status(403).json({ success: false, message: "Only admins can post in announcement-only groups" });
      return;
    }

    const { content, type = "text", replyToId } = req.body as Record<string, unknown>;

    if (!content || !String(content).trim()) {
      res.status(400).json({ success: false, message: "content is required" });
      return;
    }

    let replyToDbId: unknown = null;
    if (replyToId) {
      const [rm] = await q<RowDataPacket>(
        `SELECT id FROM messages WHERE uuid = ? AND conversation_id = ?`,
        [String(replyToId), member.conversationId]
      );
      if (rm) replyToDbId = rm["id"];
    }

    const msgContent = String(content).trim();
    const result = await run(
      `INSERT INTO messages (conversation_id, sender_id, type, content, reply_to_id)
       VALUES (?, ?, ?, ?, ?)`,
      [member.conversationId, userId, type ?? "text", msgContent, replyToDbId]
    );
    const msgId = result.insertId;

    await run(
      `UPDATE conversations SET last_message_at = NOW(), last_message_preview = ? WHERE id = ?`,
      [msgContent.slice(0, 100), member.conversationId]
    );

    // Mark as read for sender
    await run(
      `UPDATE conversation_members SET last_read_at = NOW()
       WHERE conversation_id = ? AND user_id = ?`,
      [member.conversationId, userId]
    );

    // Notifications for other non-muted members
    const [senderRow] = await q<RowDataPacket>(`SELECT name FROM users WHERE id = ?`, [userId]);
    const senderName  = String(senderRow?.["name"] ?? "Someone");
    notifyOtherMembers(
      member.conversationId, userId,
      `${senderName} in ${member.convName || "a conversation"}`,
      msgContent,
      `/chat?c=${member.convUuid}`
    );

    const fullMsg = await fetchFullMessage(msgId, userId);
    emitToConversation(uuid, "message:new", fullMsg);
    res.status(201).json({ success: true, message: "Message sent", data: fullMsg });
  } catch (err) {
    console.error("[chat/sendMessage]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── sendAttachment ───────────────────────────────────────────────────────────

export async function sendAttachment(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;
    const userRole = req.user!.role;

    if (!req.file) {
      res.status(400).json({ success: false, message: "No file uploaded" });
      return;
    }

    const member = await getMemberRecord(uuid, userId);
    if (!member) {
      res.status(403).json({ success: false, message: "You are not a member of this conversation" });
      return;
    }

    if (!canUserPostInConversation(userRole, member.isAnnouncementOnly, member.memberRole)) {
      res.status(403).json({ success: false, message: "Only admins can post in announcement-only groups" });
      return;
    }

    if (!ALLOWED_CHAT_MIME.has(req.file.mimetype)) {
      res.status(400).json({ success: false, message: "File type not allowed. Supported: images, video, PDF, DOCX, XLSX, ZIP" });
      return;
    }

    const { url: filePath } = await uploadFile(req.file.buffer, { folder: "chat-attachments", filename: req.file.originalname, mimetype: req.file.mimetype });
    const fileSize = req.file.size;

    const msgType: "image" | "file" = req.file.mimetype.startsWith("image/") ? "image" : "file";
    const { content, replyToId } = req.body as Record<string, string | undefined>;
    const msgContent = content ? String(content).trim() : req.file.originalname;

    let replyToDbId: unknown = null;
    if (replyToId) {
      const [rm] = await q<RowDataPacket>(
        `SELECT id FROM messages WHERE uuid = ? AND conversation_id = ?`,
        [String(replyToId), member.conversationId]
      );
      if (rm) replyToDbId = rm["id"];
    }

    const msgResult = await run(
      `INSERT INTO messages (conversation_id, sender_id, type, content, reply_to_id)
       VALUES (?, ?, ?, ?, ?)`,
      [member.conversationId, userId, msgType, msgContent, replyToDbId]
    );
    const msgId = msgResult.insertId;

    await run(
      `INSERT INTO message_attachments (message_id, file_name, file_path, file_size, file_type)
       VALUES (?, ?, ?, ?, ?)`,
      [msgId, req.file.originalname, filePath, fileSize, req.file.mimetype]
    );

    const preview = `📎 ${req.file.originalname}`;
    await run(
      `UPDATE conversations SET last_message_at = NOW(), last_message_preview = ? WHERE id = ?`,
      [preview.slice(0, 300), member.conversationId]
    );

    await run(
      `UPDATE conversation_members SET last_read_at = NOW()
       WHERE conversation_id = ? AND user_id = ?`,
      [member.conversationId, userId]
    );

    const [senderRow] = await q<RowDataPacket>(`SELECT name FROM users WHERE id = ?`, [userId]);
    const senderName  = String(senderRow?.["name"] ?? "Someone");
    notifyOtherMembers(
      member.conversationId, userId,
      `${senderName} in ${member.convName || "a conversation"}`,
      preview,
      `/chat?c=${member.convUuid}`
    );

    const fullMsg = await fetchFullMessage(msgId, userId);
    res.status(201).json({ success: true, message: "File sent", data: fullMsg });
  } catch (err) {
    console.error("[chat/sendAttachment]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── editMessage ──────────────────────────────────────────────────────────────

export async function editMessage(req: Request, res: Response): Promise<void> {
  try {
    const { convUuid, msgUuid } = req.params as Record<string, string>;
    const userId = req.user!.id;

    const member = await getMemberRecord(convUuid, userId);
    if (!member) {
      res.status(403).json({ success: false, message: "You are not a member of this conversation" });
      return;
    }

    const [msg] = await q<RowDataPacket>(
      `SELECT id, content, sender_id AS senderId, is_deleted AS isDeleted
       FROM messages WHERE uuid = ? AND conversation_id = ?`,
      [msgUuid, member.conversationId]
    );
    if (!msg) {
      res.status(404).json({ success: false, message: "Message not found" });
      return;
    }
    if (Number(msg["senderId"]) !== userId) {
      res.status(403).json({ success: false, message: "Only the sender can edit this message" });
      return;
    }
    if (Boolean(msg["isDeleted"])) {
      res.status(400).json({ success: false, message: "Cannot edit a deleted message" });
      return;
    }

    const { content } = req.body as Record<string, unknown>;
    if (!content || !String(content).trim()) {
      res.status(400).json({ success: false, message: "content is required" });
      return;
    }

    await run(
      `INSERT INTO message_edit_history (message_id, old_content) VALUES (?, ?)`,
      [msg["id"], msg["content"]]
    );

    await run(
      `UPDATE messages SET content = ?, is_edited = TRUE, edited_at = NOW() WHERE id = ?`,
      [String(content).trim(), msg["id"]]
    );

    const fullMsg = await fetchFullMessage(msg["id"], userId);
    res.json({ success: true, message: "Message updated", data: fullMsg });
  } catch (err) {
    console.error("[chat/editMessage]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── deleteMessage ────────────────────────────────────────────────────────────

export async function deleteMessage(req: Request, res: Response): Promise<void> {
  try {
    const { convUuid, msgUuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;
    const userRole = req.user!.role;

    const member = await getMemberRecord(convUuid, userId);
    if (!member) {
      res.status(403).json({ success: false, message: "You are not a member of this conversation" });
      return;
    }

    const [msg] = await q<RowDataPacket>(
      `SELECT id, sender_id AS senderId, is_deleted AS isDeleted
       FROM messages WHERE uuid = ? AND conversation_id = ?`,
      [msgUuid, member.conversationId]
    );
    if (!msg) {
      res.status(404).json({ success: false, message: "Message not found" });
      return;
    }

    const isSender    = Number(msg["senderId"]) === userId;
    const isSiteAdmin = ADMIN_ROLES.includes(userRole);
    const isConvAdmin = member.memberRole === "admin";

    if (!isSender && !isSiteAdmin && !isConvAdmin) {
      res.status(403).json({ success: false, message: "Not authorised to delete this message" });
      return;
    }

    await run(
      `UPDATE messages SET is_deleted = TRUE, deleted_at = NOW(), content = 'This message was deleted'
       WHERE id = ?`,
      [msg["id"]]
    );

    res.json({ success: true, message: "Message deleted", data: null });
  } catch (err) {
    console.error("[chat/deleteMessage]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Section B: Attachment download / preview ─────────────────────────────────

export async function downloadAttachment(req: Request, res: Response): Promise<void> {
  try {
    const { convUuid, msgUuid, attUuid } = req.params as Record<string, string>;
    const userId = req.user!.id;

    const member = await getMemberRecord(convUuid, userId);
    if (!member) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    const [msg] = await q<RowDataPacket>(
      `SELECT id FROM messages WHERE uuid = ? AND conversation_id = ?`,
      [msgUuid, member.conversationId]
    );
    if (!msg) {
      res.status(404).json({ success: false, message: "Message not found" });
      return;
    }

    const [att] = await q<RowDataPacket>(
      `SELECT id, file_path AS filePath, file_name AS fileName
       FROM message_attachments WHERE uuid = ? AND message_id = ?`,
      [attUuid, msg["id"]]
    );
    if (!att) {
      res.status(404).json({ success: false, message: "Attachment not found" });
      return;
    }

    await run(
      `UPDATE message_attachments SET download_count = download_count + 1 WHERE id = ?`,
      [att["id"]]
    );

    res.setHeader("Content-Disposition", `attachment; filename="${att["fileName"]}"`);
    res.redirect(String(att["filePath"]));
  } catch (err) {
    console.error("[chat/downloadAttachment]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function downloadAttachmentByUuid(req: Request, res: Response): Promise<void> {
  try {
    const { attUuid } = req.params as Record<string, string>;
    const userId      = req.user!.id;

    const att = await verifyAttachmentAccess(attUuid, userId);
    if (!att) {
      res.status(404).json({ success: false, message: "Attachment not found or access denied" });
      return;
    }

    await run(
      `UPDATE message_attachments SET download_count = download_count + 1 WHERE uuid = ?`,
      [attUuid]
    );

    res.setHeader("Content-Disposition", `attachment; filename="${att["fileName"]}"`);
    res.redirect(String(att["filePath"]));
  } catch (err) {
    console.error("[chat/downloadAttachmentByUuid]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function previewAttachmentByUuid(req: Request, res: Response): Promise<void> {
  try {
    const { attUuid } = req.params as Record<string, string>;
    const userId      = req.user!.id;

    const att = await verifyAttachmentAccess(attUuid, userId);
    if (!att) {
      res.status(404).json({ success: false, message: "Attachment not found or access denied" });
      return;
    }

    if (!INLINE_MIME.has(att["fileType"])) {
      res.redirect(`/api/chat/attachments/${attUuid}/download`);
      return;
    }

    // filePath is a Cloudinary URL — redirect directly to it
    res.redirect(String(att["filePath"]));
  } catch (err) {
    console.error("[chat/previewAttachmentByUuid]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Section C: Reactions ─────────────────────────────────────────────────────

export async function addReaction(req: Request, res: Response): Promise<void> {
  try {
    const { convUuid, msgUuid } = req.params as Record<string, string>;
    const userId = req.user!.id;

    const member = await getMemberRecord(convUuid, userId);
    if (!member) {
      res.status(403).json({ success: false, message: "You are not a member of this conversation" });
      return;
    }

    const { emoji } = req.body as Record<string, unknown>;
    if (!emoji || String(emoji).length > 10) {
      res.status(400).json({ success: false, message: "Valid emoji is required (max 10 chars)" });
      return;
    }

    const [msg] = await q<RowDataPacket>(
      `SELECT id FROM messages WHERE uuid = ? AND conversation_id = ? AND is_deleted = FALSE`,
      [msgUuid, member.conversationId]
    );
    if (!msg) {
      res.status(404).json({ success: false, message: "Message not found" });
      return;
    }

    const emojiStr = String(emoji);

    // Toggle
    const [existing] = await q<RowDataPacket>(
      `SELECT id FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`,
      [msg["id"], userId, emojiStr]
    );

    let action: string;
    if (existing) {
      await run(
        `DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`,
        [msg["id"], userId, emojiStr]
      );
      action = "removed";
    } else {
      await run(
        `INSERT IGNORE INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)`,
        [msg["id"], userId, emojiStr]
      );
      action = "added";
    }

    const reactions = await fetchReactions(msg["id"], userId);
    res.json({
      success: true,
      message: action === "added" ? "Reaction added" : "Reaction removed",
      data: { action, reactions },
    });
  } catch (err) {
    console.error("[chat/addReaction]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function removeReaction(req: Request, res: Response): Promise<void> {
  try {
    const { convUuid, msgUuid, emoji } = req.params as Record<string, string>;
    const userId = req.user!.id;

    const member = await getMemberRecord(convUuid, userId);
    if (!member) {
      res.status(403).json({ success: false, message: "You are not a member of this conversation" });
      return;
    }

    const [msg] = await q<RowDataPacket>(
      `SELECT id FROM messages WHERE uuid = ? AND conversation_id = ?`,
      [msgUuid, member.conversationId]
    );
    if (!msg) {
      res.status(404).json({ success: false, message: "Message not found" });
      return;
    }

    await run(
      `DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`,
      [msg["id"], userId, decodeURIComponent(emoji)]
    );

    const reactions = await fetchReactions(msg["id"], userId);
    res.json({ success: true, message: "Reaction removed", data: { reactions } });
  } catch (err) {
    console.error("[chat/removeReaction]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Section D: Pin / Unpin ───────────────────────────────────────────────────

export async function pinMessage(req: Request, res: Response): Promise<void> {
  try {
    const { convUuid, msgUuid } = req.params as Record<string, string>;
    const userId = req.user!.id;

    const member = await getMemberRecord(convUuid, userId);
    if (!member) {
      res.status(403).json({ success: false, message: "You are not a member of this conversation" });
      return;
    }
    if (member.memberRole !== "admin") {
      res.status(403).json({ success: false, message: "Only conversation admins can pin messages" });
      return;
    }

    const [msg] = await q<RowDataPacket>(
      `SELECT id FROM messages WHERE uuid = ? AND conversation_id = ? AND is_deleted = FALSE`,
      [msgUuid, member.conversationId]
    );
    if (!msg) {
      res.status(404).json({ success: false, message: "Message not found" });
      return;
    }

    await run(
      `INSERT IGNORE INTO pinned_messages (conversation_id, message_id, pinned_by) VALUES (?, ?, ?)`,
      [member.conversationId, msg["id"], userId]
    );
    await run(
      `UPDATE messages SET is_pinned = TRUE, pinned_by = ?, pinned_at = NOW() WHERE id = ?`,
      [userId, msg["id"]]
    );

    const [adminRow] = await q<RowDataPacket>(`SELECT name FROM users WHERE id = ?`, [userId]);
    await sysMsg(member.conversationId, userId, `${adminRow?.["name"] ?? "Admin"} pinned a message`);

    res.json({ success: true, message: "Message pinned", data: null });
  } catch (err) {
    console.error("[chat/pinMessage]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function unpinMessage(req: Request, res: Response): Promise<void> {
  try {
    const { convUuid, msgUuid } = req.params as Record<string, string>;
    const userId = req.user!.id;

    const member = await getMemberRecord(convUuid, userId);
    if (!member) {
      res.status(403).json({ success: false, message: "You are not a member of this conversation" });
      return;
    }
    if (member.memberRole !== "admin") {
      res.status(403).json({ success: false, message: "Only conversation admins can unpin messages" });
      return;
    }

    const [msg] = await q<RowDataPacket>(
      `SELECT id FROM messages WHERE uuid = ? AND conversation_id = ?`,
      [msgUuid, member.conversationId]
    );
    if (!msg) {
      res.status(404).json({ success: false, message: "Message not found" });
      return;
    }

    await run(
      `DELETE FROM pinned_messages WHERE conversation_id = ? AND message_id = ?`,
      [member.conversationId, msg["id"]]
    );
    await run(
      `UPDATE messages SET is_pinned = FALSE, pinned_by = NULL, pinned_at = NULL WHERE id = ?`,
      [msg["id"]]
    );

    res.json({ success: true, message: "Message unpinned", data: null });
  } catch (err) {
    console.error("[chat/unpinMessage]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Read receipts ────────────────────────────────────────────────────────────

export async function markMessageRead(req: Request, res: Response): Promise<void> {
  try {
    const { convUuid, msgUuid } = req.params as Record<string, string>;
    const userId = req.user!.id;

    const member = await getMemberRecord(convUuid, userId);
    if (!member) {
      res.status(403).json({ success: false, message: "You are not a member of this conversation" });
      return;
    }

    const [msg] = await q<RowDataPacket>(
      `SELECT id FROM messages WHERE uuid = ? AND conversation_id = ?`,
      [msgUuid, member.conversationId]
    );
    if (!msg) {
      res.status(404).json({ success: false, message: "Message not found" });
      return;
    }

    await run(
      `INSERT IGNORE INTO message_read_status (message_id, user_id) VALUES (?, ?)`,
      [msg["id"], userId]
    );

    res.json({ success: true, message: "Message marked as read", data: null });
  } catch (err) {
    console.error("[chat/markMessageRead]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function getMessageReadStatus(req: Request, res: Response): Promise<void> {
  try {
    const { convUuid, msgUuid } = req.params as Record<string, string>;
    const userId = req.user!.id;

    const member = await getMemberRecord(convUuid, userId);
    if (!member) {
      res.status(403).json({ success: false, message: "You are not a member of this conversation" });
      return;
    }

    const [msg] = await q<RowDataPacket>(
      `SELECT id FROM messages WHERE uuid = ? AND conversation_id = ?`,
      [msgUuid, member.conversationId]
    );
    if (!msg) {
      res.status(404).json({ success: false, message: "Message not found" });
      return;
    }

    const rows = await q<RowDataPacket>(
      `SELECT u.id, u.uuid, u.name, u.avatar_url AS avatarUrl, rs.read_at AS readAt
       FROM message_read_status rs
       JOIN users u ON u.id = rs.user_id
       WHERE rs.message_id = ?`,
      [msg["id"]]
    );

    res.json({
      success: true, message: "OK",
      data: rows.map(r => ({
        id: r["id"], uuid: r["uuid"], name: r["name"],
        avatarUrl: r["avatarUrl"] ?? null, readAt: r["readAt"],
      })),
    });
  } catch (err) {
    console.error("[chat/getMessageReadStatus]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Section E: Search ────────────────────────────────────────────────────────

export async function searchMessages(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;
    const { q: term } = req.query as Record<string, string | undefined>;

    if (!term || !term.trim()) {
      res.status(400).json({ success: false, message: "q is required" });
      return;
    }

    const member = await getMemberRecord(uuid, userId);
    if (!member) {
      res.status(403).json({ success: false, message: "You are not a member of this conversation" });
      return;
    }

    const rows = await q<RowDataPacket>(
      `SELECT m.id, m.uuid, m.content, m.type, m.sender_id AS senderId,
              m.is_edited AS isEdited, m.created_at AS createdAt,
              u.uuid AS senderUuid, u.name AS senderName, u.avatar_url AS senderAvatar
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = ? AND m.content LIKE ? AND m.is_deleted = FALSE
       ORDER BY m.created_at DESC
       LIMIT 20`,
      [member.conversationId, `%${term.trim()}%`]
    );

    res.json({
      success: true, message: "OK",
      data: rows.map(r => ({
        id:        r["id"],
        uuid:      r["uuid"],
        content:   r["content"],
        type:      r["type"],
        senderId:  r["senderId"],
        isEdited:  Boolean(r["isEdited"]),
        createdAt: r["createdAt"],
        sender: {
          uuid:      r["senderUuid"],
          name:      r["senderName"],
          avatarUrl: r["senderAvatar"] ?? null,
        },
      })),
    });
  } catch (err) {
    console.error("[chat/searchMessages]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function searchFiles(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const { q: term } = req.query as Record<string, string | undefined>;

    if (!term || !term.trim()) {
      res.status(400).json({ success: false, message: "q is required" });
      return;
    }

    const rows = await q<RowDataPacket>(
      `SELECT ma.id, ma.uuid, ma.file_name AS fileName, ma.file_path AS filePath,
              ma.file_size AS fileSize, ma.file_type AS fileType,
              ma.download_count AS downloadCount, ma.created_at AS createdAt,
              c.uuid AS conversationUuid, c.name AS conversationName,
              m.uuid AS messageUuid, m.created_at AS messageDate
       FROM message_attachments ma
       JOIN messages m ON m.id = ma.message_id AND m.is_deleted = FALSE
       JOIN conversations c ON c.id = m.conversation_id
       JOIN conversation_members cm
         ON cm.conversation_id = c.id AND cm.user_id = ? AND cm.left_at IS NULL
       WHERE ma.file_name LIKE ?
       ORDER BY ma.created_at DESC
       LIMIT 20`,
      [userId, `%${term.trim()}%`]
    );

    res.json({ success: true, message: "OK", data: rows });
  } catch (err) {
    console.error("[chat/searchFiles]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
