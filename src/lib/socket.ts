// src/lib/socket.ts
import { Server as SocketServer } from "socket.io";
import { verifyToken } from "./jwt";
import { q, run, RowDataPacket } from "./db";
import { canUserPostInConversation } from "./chat-permissions";

const onlineUsers = new Map<number, string>(); // userId → socketId
const userSockets = new Map<string, number>(); // socketId → userId

let _io: SocketServer;

export function emitToConversation(conversationUuid: string, event: string, data: unknown): void {
  _io?.to(`conversation:${conversationUuid}`).emit(event, data);
}

// Join each online user's socket to the conversation room (call after adding members to DB)
export function addUsersToConversationRoom(userIds: number[], conversationUuid: string): void {
  if (!_io) return;
  for (const userId of userIds) {
    const socketId = onlineUsers.get(userId);
    if (!socketId) continue;
    const sock = _io.sockets.sockets.get(socketId);
    sock?.join(`conversation:${conversationUuid}`);
  }
}

// Tell each online user to refresh their conversation list
export function notifyUsersConversationRefresh(userIds: number[]): void {
  if (!_io) return;
  for (const userId of userIds) {
    _io.to(`user:${userId}`).emit("conversation:refresh");
  }
}

export function setupSocketHandlers(io: SocketServer): void {
  _io = io;

  // ─── Auth middleware ──────────────────────────────────────────────────────────
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token as string | undefined;
    if (!token) return next(new Error("Authentication required"));
    try {
      socket.data.user = verifyToken(token);
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", async (socket) => {
    const user = socket.data.user as { id: number; uuid: string; email: string; role: string };

    // Track online + join personal room
    onlineUsers.set(user.id, socket.id);
    userSockets.set(socket.id, user.id);
    socket.join(`user:${user.id}`);
    socket.broadcast.emit("user:online", { userId: user.id });

    // Auto-join all user's conversation rooms
    try {
      const rows = await q<RowDataPacket>(
        `SELECT c.uuid FROM conversations c
         JOIN conversation_members cm ON cm.conversation_id = c.id
         WHERE cm.user_id = ? AND cm.left_at IS NULL`,
        [user.id]
      );
      for (const row of rows) {
        socket.join(`conversation:${String(row["uuid"])}`);
      }
    } catch (err) {
      console.error("[socket] auto-join rooms failed", err);
    }

    // ─── conversation:join ────────────────────────────────────────────────────
    socket.on("conversation:join", async (conversationUuid: string) => {
      try {
        const [row] = await q<RowDataPacket>(
          `SELECT c.id FROM conversations c
           JOIN conversation_members cm ON cm.conversation_id = c.id
           WHERE c.uuid = ? AND cm.user_id = ? AND cm.left_at IS NULL`,
          [conversationUuid, user.id]
        );
        if (!row) return;
        socket.join(`conversation:${conversationUuid}`);
        socket.emit("conversation:joined", { conversationUuid });
      } catch (err) {
        console.error("[socket] conversation:join failed", err);
      }
    });

    // ─── conversation:leave ───────────────────────────────────────────────────
    socket.on("conversation:leave", (conversationUuid: string) => {
      socket.leave(`conversation:${conversationUuid}`);
    });

    // ─── message:send ─────────────────────────────────────────────────────────
    socket.on("message:send", async (data: {
      conversationUuid: string;
      content: string;
      replyToId?: string;
    }) => {
      try {
        const { conversationUuid, content, replyToId } = data;

        const [memberRow] = await q<RowDataPacket>(
          `SELECT c.id AS conversationId, c.name AS convName, c.uuid AS convUuid,
                  c.is_announcement_only AS isAnnouncementOnly,
                  cm.role AS memberRole, cm.is_muted AS isMuted
           FROM conversations c
           JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ? AND cm.left_at IS NULL
           WHERE c.uuid = ?`,
          [user.id, conversationUuid]
        );
        if (!memberRow) {
          socket.emit("error", { message: "You are not a member of this conversation" });
          return;
        }

        const isAnnouncementOnly = Boolean(memberRow["isAnnouncementOnly"]);
        const memberRole = memberRow["memberRole"] as "admin" | "member";

        if (!canUserPostInConversation(user.role, isAnnouncementOnly, memberRole)) {
          socket.emit("error", { message: "Only admins can post in announcement-only groups" });
          return;
        }

        if (!content || !String(content).trim()) {
          socket.emit("error", { message: "content is required" });
          return;
        }

        const msgContent      = String(content).trim();
        const conversationId  = Number(memberRow["conversationId"]);
        const convName        = String(memberRow["convName"] ?? "a conversation");

        let replyToDbId: unknown = null;
        if (replyToId) {
          const [rm] = await q<RowDataPacket>(
            `SELECT id FROM messages WHERE uuid = ? AND conversation_id = ?`,
            [String(replyToId), conversationId]
          );
          if (rm) replyToDbId = rm["id"];
        }

        const result = await run(
          `INSERT INTO messages (conversation_id, sender_id, type, content, reply_to_id) VALUES (?, ?, 'text', ?, ?)`,
          [conversationId, user.id, msgContent, replyToDbId]
        );
        const msgId = result.insertId;

        await run(
          `UPDATE conversations SET last_message_at = NOW(), last_message_preview = ? WHERE id = ?`,
          [msgContent.slice(0, 100), conversationId]
        );
        await run(
          `UPDATE conversation_members SET last_read_at = NOW() WHERE conversation_id = ? AND user_id = ?`,
          [conversationId, user.id]
        );

        // Build message payload
        const [msgRow] = await q<RowDataPacket>(
          `SELECT m.*, u.name AS senderName, u.uuid AS senderUuid,
                  u.avatar_url AS senderAvatar, u.role AS senderRole
           FROM messages m JOIN users u ON u.id = m.sender_id
           WHERE m.id = ?`,
          [msgId]
        );

        const fullMsg = {
          id:             Number(msgRow["id"]),
          uuid:           String(msgRow["uuid"]),
          conversationId,
          senderId:       Number(msgRow["sender_id"]),
          type:           String(msgRow["type"]),
          content:        String(msgRow["content"]),
          replyToId:      msgRow["reply_to_id"] ? Number(msgRow["reply_to_id"]) : null,
          isEdited:       false,
          isDeleted:      false,
          isPinned:       false,
          reactions:      [],
          attachments:    [],
          sender: {
            id:        Number(msgRow["sender_id"]),
            uuid:      String(msgRow["senderUuid"]),
            name:      String(msgRow["senderName"]),
            email:     "",
            role:      String(msgRow["senderRole"]),
            avatarUrl: msgRow["senderAvatar"] ?? null,
          },
          createdAt: new Date().toISOString(),
        };

        io.to(`conversation:${conversationUuid}`).emit("message:new", fullMsg);

        // Fire-and-forget notifications
        q<RowDataPacket>(`SELECT name FROM users WHERE id = ?`, [user.id])
          .then(([senderUser]) => {
            const senderName = String(senderUser?.["name"] ?? "Someone");
            run(
              `INSERT INTO notifications (user_id, title, body, link, type, is_read, created_at)
               SELECT cm.user_id, ?, ?, ?, 'chat', FALSE, NOW()
               FROM conversation_members cm
               WHERE cm.conversation_id = ? AND cm.user_id != ? AND cm.is_muted = FALSE AND cm.left_at IS NULL`,
              [`${senderName} in ${convName}`, msgContent.slice(0, 100), `/chat?c=${conversationUuid}`, conversationId, user.id]
            ).catch(() => {});
          })
          .catch(() => {});

      } catch (err) {
        console.error("[socket] message:send failed", err);
        socket.emit("error", { message: "Failed to send message" });
      }
    });

    // ─── typing ───────────────────────────────────────────────────────────────
    socket.on("typing:start", (conversationUuid: string) => {
      socket.to(`conversation:${conversationUuid}`).emit("typing:started", {
        userId: user.id,
        conversationUuid,
      });
    });

    socket.on("typing:stop", (conversationUuid: string) => {
      socket.to(`conversation:${conversationUuid}`).emit("typing:stopped", {
        userId: user.id,
        conversationUuid,
      });
    });

    // ─── message:read ─────────────────────────────────────────────────────────
    socket.on("message:read", async (data: { conversationUuid: string }) => {
      try {
        const [conv] = await q<RowDataPacket>(
          `SELECT id FROM conversations WHERE uuid = ?`,
          [data.conversationUuid]
        );
        if (!conv) return;
        await run(
          `UPDATE conversation_members SET last_read_at = NOW() WHERE conversation_id = ? AND user_id = ?`,
          [Number(conv["id"]), user.id]
        );
        socket.to(`conversation:${data.conversationUuid}`).emit("message:seen", {
          userId:           user.id,
          conversationUuid: data.conversationUuid,
          seenAt:           new Date().toISOString(),
        });
      } catch (err) {
        console.error("[socket] message:read failed", err);
      }
    });

    // ─── message:react ────────────────────────────────────────────────────────
    socket.on("message:react", async (data: {
      messageUuid: string;
      emoji: string;
      conversationUuid: string;
    }) => {
      try {
        const [msg] = await q<RowDataPacket>(
          `SELECT m.id FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
           JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ? AND cm.left_at IS NULL
           WHERE m.uuid = ? AND c.uuid = ?`,
          [user.id, data.messageUuid, data.conversationUuid]
        );
        if (!msg) return;
        const msgId = Number(msg["id"]);

        const [existing] = await q<RowDataPacket>(
          `SELECT id FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`,
          [msgId, user.id, data.emoji]
        );
        if (existing) {
          await run(
            `DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`,
            [msgId, user.id, data.emoji]
          );
        } else {
          await run(
            `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)`,
            [msgId, user.id, data.emoji]
          );
        }

        const reactionRows = await q<RowDataPacket>(
          `SELECT emoji, COUNT(*) AS cnt, GROUP_CONCAT(user_id ORDER BY created_at) AS userIds
           FROM message_reactions WHERE message_id = ? GROUP BY emoji`,
          [msgId]
        );
        const reactions = reactionRows.map(r => ({
          emoji:       String(r["emoji"]),
          count:       Number(r["cnt"]),
          users:       String(r["userIds"] ?? "").split(",").filter(Boolean).map(Number),
          userReacted: String(r["userIds"] ?? "").split(",").includes(String(user.id)),
        }));

        io.to(`conversation:${data.conversationUuid}`).emit("message:reaction_updated", {
          messageUuid: data.messageUuid,
          reactions,
        });
      } catch (err) {
        console.error("[socket] message:react failed", err);
      }
    });

    // ─── users:online_check ───────────────────────────────────────────────────
    socket.on("users:online_check", (userIds: number[]) => {
      const statuses = userIds.map(id => ({
        userId:   id,
        isOnline: onlineUsers.has(id),
      }));
      socket.emit("users:online_status", statuses);
    });

    // ─── disconnect ───────────────────────────────────────────────────────────
    socket.on("disconnect", () => {
      onlineUsers.delete(user.id);
      userSockets.delete(socket.id);
      socket.broadcast.emit("user:offline", { userId: user.id });
    });
  });
}
