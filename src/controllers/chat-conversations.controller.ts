// src/controllers/chat-conversations.controller.ts
import { Request, Response } from "express";
import { q, run, RowDataPacket } from "../lib/db";
import { canUserChat, canUserCreateGroup } from "../lib/chat-permissions";
import { addUsersToConversationRoom, notifyUsersConversationRefresh } from "../lib/socket";

const ADMIN_ROLES = ["SUPER_ADMIN", "ADMIN"];
const CONTEXTUAL_ROLES = ["SUPER_ADMIN", "ADMIN", "TEAM_LEAD"];

// ─── Shared Helpers ───────────────────────────────────────────────────────────

async function resolveConvByUuid(uuid: string): Promise<RowDataPacket | null> {
  const [row] = await q<RowDataPacket>(
    `SELECT id, uuid, type, name, description, avatar_url AS avatarUrl,
            is_announcement_only AS isAnnouncementOnly, is_archived AS isArchived,
            linked_module AS linkedModule, linked_module_uuid AS linkedModuleUuid,
            created_by AS createdBy, last_message_at AS lastMessageAt,
            last_message_preview AS lastMessagePreview, created_at AS createdAt
     FROM conversations WHERE uuid = ?`,
    [uuid]
  );
  return row ?? null;
}

async function resolveConvById(id: number): Promise<RowDataPacket | null> {
  const [row] = await q<RowDataPacket>(
    `SELECT id, uuid, type, name, description, avatar_url AS avatarUrl,
            is_announcement_only AS isAnnouncementOnly, is_archived AS isArchived,
            linked_module AS linkedModule, linked_module_uuid AS linkedModuleUuid,
            created_by AS createdBy, last_message_at AS lastMessageAt,
            last_message_preview AS lastMessagePreview, created_at AS createdAt
     FROM conversations WHERE id = ?`,
    [id]
  );
  return row ?? null;
}

async function resolveUserByUuid(userUuid: string): Promise<RowDataPacket | null> {
  const [row] = await q<RowDataPacket>(
    `SELECT id, uuid, name, email, role, avatar_url AS avatarUrl FROM users WHERE uuid = ?`,
    [userUuid]
  );
  return row ?? null;
}

async function getMembership(conversationId: number, userId: number): Promise<RowDataPacket | null> {
  const [row] = await q<RowDataPacket>(
    `SELECT id, role, is_muted AS isMuted, last_read_at AS lastReadAt
     FROM conversation_members
     WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL`,
    [conversationId, userId]
  );
  return row ?? null;
}

async function getConvMembers(conversationId: number): Promise<object[]> {
  const rows = await q<RowDataPacket>(
    `SELECT cm.id, cm.conversation_id AS conversationId, cm.user_id AS userId,
            cm.role, cm.is_muted AS isMuted, cm.joined_at AS joinedAt, cm.last_read_at AS lastReadAt,
            u.uuid AS userUuid, u.name, u.email, u.role AS userRole, u.avatar_url AS avatarUrl
     FROM conversation_members cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.conversation_id = ? AND cm.left_at IS NULL`,
    [conversationId]
  );
  return rows.map(r => ({
    id:             r["id"],
    conversationId: r["conversationId"],
    userId:         r["userId"],
    role:           r["role"],
    isMuted:        Boolean(r["isMuted"]),
    joinedAt:       r["joinedAt"],
    lastReadAt:     r["lastReadAt"] ?? null,
    user: {
      id:        r["userId"],
      uuid:      r["userUuid"],
      name:      r["name"],
      email:     r["email"],
      role:      r["userRole"],
      avatarUrl: r["avatarUrl"] ?? null,
    },
  }));
}

function shapeConv(row: RowDataPacket): object {
  return {
    id:                 row["id"],
    uuid:               row["uuid"],
    type:               row["type"],
    name:               row["name"] ?? null,
    description:        row["description"] ?? null,
    avatarUrl:          row["avatarUrl"] ?? null,
    isAnnouncementOnly: Boolean(row["isAnnouncementOnly"]),
    isArchived:         Boolean(row["isArchived"]),
    linkedModule:       row["linkedModule"],
    linkedModuleUuid:   row["linkedModuleUuid"] ?? null,
    createdBy:          row["createdBy"],
    lastMessageAt:      row["lastMessageAt"] ?? null,
    lastMessagePreview: row["lastMessagePreview"] ?? null,
    createdAt:          row["createdAt"],
  };
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

// ─── listConversations ────────────────────────────────────────────────────────

export async function listConversations(req: Request, res: Response): Promise<void> {
  try {
    const userId   = req.user!.id;
    const archived = req.query["archived"] === "true" ? 1 : 0;

    const rows = await q<RowDataPacket>(`
      SELECT
        c.id, c.uuid, c.type, c.name, c.description, c.avatar_url AS avatarUrl,
        c.is_announcement_only AS isAnnouncementOnly, c.is_archived AS isArchived,
        c.linked_module AS linkedModule, c.linked_module_uuid AS linkedModuleUuid,
        c.created_by AS createdBy, c.last_message_at AS lastMessageAt,
        c.last_message_preview AS lastMessagePreview, c.created_at AS createdAt,
        cm.role AS myRole, cm.is_muted AS isMuted, cm.last_read_at AS myLastReadAt,
        (
          SELECT COUNT(*) FROM messages m
          WHERE m.conversation_id = c.id
            AND m.is_deleted = FALSE
            AND m.sender_id != ?
            AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)
        ) AS unreadCount,
        u_other.id AS otherUserId, u_other.uuid AS otherUserUuid,
        u_other.name AS otherUserName, u_other.avatar_url AS otherUserAvatar
      FROM conversations c
      JOIN conversation_members cm
        ON cm.conversation_id = c.id AND cm.user_id = ? AND cm.left_at IS NULL
      LEFT JOIN conversation_members cm_other
        ON cm_other.conversation_id = c.id
           AND cm_other.user_id != ?
           AND cm_other.left_at IS NULL
           AND c.type = 'direct'
      LEFT JOIN users u_other ON u_other.id = cm_other.user_id
      WHERE c.is_archived = ?
      ORDER BY c.last_message_at DESC, c.created_at DESC`,
      [userId, userId, userId, archived]
    );

    const data = rows.map(row => {
      const isDirect = row["type"] === "direct";
      return {
        ...shapeConv(row),
        name:         isDirect ? (row["otherUserName"] ?? "Unknown") : (row["name"] ?? null),
        avatarUrl:    isDirect ? (row["otherUserAvatar"] ?? null) : (row["avatarUrl"] ?? null),
        myRole:       row["myRole"],
        isMuted:      Boolean(row["isMuted"]),
        myLastReadAt: row["myLastReadAt"] ?? null,
        unreadCount:  Number(row["unreadCount"] ?? 0),
        otherUser: isDirect ? {
          id:        row["otherUserId"],
          uuid:      row["otherUserUuid"],
          name:      row["otherUserName"],
          avatarUrl: row["otherUserAvatar"] ?? null,
        } : null,
      };
    });

    res.json({ success: true, message: "OK", data });
  } catch (err) {
    console.error("[chat/listConversations]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── getConversation ──────────────────────────────────────────────────────────

export async function getConversation(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;

    const conv = await resolveConvByUuid(uuid);
    if (!conv) {
      res.status(404).json({ success: false, message: "Conversation not found" });
      return;
    }

    const membership = await getMembership(Number(conv["id"]), userId);
    if (!membership) {
      res.status(403).json({ success: false, message: "You are not a member of this conversation" });
      return;
    }

    const [members, pinnedRows] = await Promise.all([
      getConvMembers(Number(conv["id"])),
      q<RowDataPacket>(
        `SELECT m.id, m.uuid, m.content, m.type, m.sender_id AS senderId, m.created_at AS createdAt,
                pm.pinned_by AS pinnedBy, pm.pinned_at AS pinnedAt,
                u.uuid AS senderUuid, u.name AS senderName, u.avatar_url AS senderAvatar
         FROM pinned_messages pm
         JOIN messages m ON m.id = pm.message_id
         JOIN users u ON u.id = m.sender_id
         WHERE pm.conversation_id = ?
         ORDER BY pm.pinned_at DESC`,
        [Number(conv["id"])]
      ),
    ]);

    // For direct conversations: name = other user's name
    let convName    = conv["name"];
    let convAvatar  = conv["avatarUrl"];
    if (conv["type"] === "direct") {
      const other = (members as Array<{ userId: number; user: { name: string; avatarUrl?: string | null } }>)
        .find(m => m.userId !== userId);
      convName   = other?.user?.name ?? "Unknown";
      convAvatar = other?.user?.avatarUrl ?? null;
    }

    res.json({
      success: true, message: "OK",
      data: {
        ...shapeConv(conv),
        name:      convName,
        avatarUrl: convAvatar,
        myRole:    membership["role"],
        isMuted:   Boolean(membership["isMuted"]),
        lastReadAt: membership["lastReadAt"] ?? null,
        members,
        pinnedMessages: pinnedRows.map(p => ({
          id:          p["id"],
          uuid:        p["uuid"],
          content:     p["content"],
          type:        p["type"],
          senderId:    p["senderId"],
          createdAt:   p["createdAt"],
          pinnedBy:    p["pinnedBy"],
          pinnedAt:    p["pinnedAt"],
          sender: { uuid: p["senderUuid"], name: p["senderName"], avatarUrl: p["senderAvatar"] ?? null },
        })),
      },
    });
  } catch (err) {
    console.error("[chat/getConversation]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── createDirectConversation ─────────────────────────────────────────────────

export async function createDirectConversation(req: Request, res: Response): Promise<void> {
  try {
    const userId   = req.user!.id;
    const userRole = req.user!.role;
    const { targetUserUuid } = req.body as Record<string, unknown>;

    if (!targetUserUuid) {
      res.status(400).json({ success: false, message: "targetUserUuid is required" });
      return;
    }

    const targetUser = await resolveUserByUuid(String(targetUserUuid));
    if (!targetUser) {
      res.status(404).json({ success: false, message: "Target user not found" });
      return;
    }

    if (!canUserChat(userRole, String(targetUser["role"]))) {
      res.status(403).json({ success: false, message: "You are not allowed to chat with this user" });
      return;
    }

    const targetId = Number(targetUser["id"]);

    // Check if direct conversation already exists
    const existing = await q<RowDataPacket>(
      `SELECT c.id, c.uuid FROM conversations c
       JOIN conversation_members cm1 ON cm1.conversation_id = c.id AND cm1.user_id = ? AND cm1.left_at IS NULL
       JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.user_id = ? AND cm2.left_at IS NULL
       WHERE c.type = 'direct'
       LIMIT 1`,
      [userId, targetId]
    );

    if (existing.length > 0) {
      const existConv = await resolveConvByUuid(String(existing[0]["uuid"]));
      const members   = await getConvMembers(Number(existing[0]["id"]));
      res.json({
        success: true, message: "Conversation already exists",
        data: { existing: true, conversation: { ...shapeConv(existConv!), members } },
      });
      return;
    }

    // Create
    const result = await run(
      `INSERT INTO conversations (type, created_by) VALUES ('direct', ?)`, [userId]
    );
    const convId = result.insertId;

    await run(
      `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'member'), (?, ?, 'member')`,
      [convId, userId, convId, targetId]
    );

    await run(
      `INSERT INTO chat_activity (conversation_id, user_id, action) VALUES (?, ?, 'direct_chat_started')`,
      [convId, userId]
    );

    const conv    = await resolveConvById(convId);
    const members = await getConvMembers(convId);
    const convUuid = String(conv!["uuid"]);

    // Subscribe both users' sockets to the new room
    addUsersToConversationRoom([userId, targetId], convUuid);
    notifyUsersConversationRefresh([userId, targetId]);

    res.status(201).json({
      success: true, message: "Direct conversation created",
      data: { existing: false, conversation: { ...shapeConv(conv!), members } },
    });
  } catch (err) {
    console.error("[chat/createDirect]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── createGroupConversation ──────────────────────────────────────────────────

export async function createGroupConversation(req: Request, res: Response): Promise<void> {
  try {
    const userId   = req.user!.id;
    const userRole = req.user!.role;

    if (!canUserCreateGroup(userRole)) {
      res.status(403).json({ success: false, message: "Only admins can create group conversations" });
      return;
    }

    const { name, description, memberUserUuids, isAnnouncementOnly } = req.body as Record<string, unknown>;

    if (!name || !String(name).trim()) {
      res.status(400).json({ success: false, message: "name is required" });
      return;
    }

    const result = await run(
      `INSERT INTO conversations (type, name, description, is_announcement_only, created_by)
       VALUES ('group', ?, ?, ?, ?)`,
      [String(name).trim(), description ? String(description) : null, isAnnouncementOnly ? 1 : 0, userId]
    );
    const convId = result.insertId;

    const [creatorRow] = await q<RowDataPacket>(`SELECT name FROM users WHERE id = ?`, [userId]);
    const creatorName  = String(creatorRow?.["name"] ?? "Unknown");

    // Creator as admin
    await run(
      `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'admin')`,
      [convId, userId]
    );

    // Other members — collect IDs for socket subscription
    const allMemberIds: number[] = [userId];
    if (Array.isArray(memberUserUuids)) {
      for (const mu of memberUserUuids) {
        const member = await resolveUserByUuid(String(mu));
        if (member && Number(member["id"]) !== userId) {
          await run(
            `INSERT IGNORE INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'member')`,
            [convId, Number(member["id"])]
          );
          allMemberIds.push(Number(member["id"]));
        }
      }
    }

    await sysMsg(convId, userId, `Group created by ${creatorName}`);

    await run(
      `INSERT INTO chat_activity (conversation_id, user_id, action, detail) VALUES (?, ?, 'group_created', ?)`,
      [convId, userId, String(name).trim()]
    );

    const conv    = await resolveConvById(convId);
    const members = await getConvMembers(convId);
    const convUuid = String(conv!["uuid"]);

    // Subscribe all members' sockets to the new room
    addUsersToConversationRoom(allMemberIds, convUuid);
    notifyUsersConversationRefresh(allMemberIds);

    res.status(201).json({
      success: true, message: "Group conversation created",
      data: { ...shapeConv(conv!), members },
    });
  } catch (err) {
    console.error("[chat/createGroup]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── createContextualConversation ─────────────────────────────────────────────

export async function createContextualConversation(req: Request, res: Response): Promise<void> {
  try {
    const userId   = req.user!.id;
    const userRole = req.user!.role;

    if (!CONTEXTUAL_ROLES.includes(userRole)) {
      res.status(403).json({ success: false, message: "Not authorised to create contextual conversations" });
      return;
    }

    const { name, linkedModule, linkedModuleUuid, memberUserUuids } = req.body as Record<string, unknown>;

    const VALID_MODULES = ["client", "task", "project", "todo"];
    if (!linkedModule || !VALID_MODULES.includes(String(linkedModule))) {
      res.status(400).json({ success: false, message: "linkedModule must be one of: client, task, project, todo" });
      return;
    }
    if (!linkedModuleUuid) {
      res.status(400).json({ success: false, message: "linkedModuleUuid is required" });
      return;
    }

    // Check if contextual conversation for this entity already exists (any member can find it)
    const [existingRow] = await q<RowDataPacket>(
      `SELECT c.id, c.uuid FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ? AND cm.left_at IS NULL
       WHERE c.type = 'contextual' AND c.linked_module = ? AND c.linked_module_uuid = ?
       LIMIT 1`,
      [userId, String(linkedModule), String(linkedModuleUuid)]
    );

    if (existingRow) {
      const conv    = await resolveConvByUuid(String(existingRow["uuid"]));
      const members = await getConvMembers(Number(existingRow["id"]));
      res.json({
        success: true, message: "Contextual conversation already exists",
        data: { existing: true, conversation: { ...shapeConv(conv!), members } },
      });
      return;
    }

    const convName = name ? String(name).trim() : `Discussion: ${linkedModule}`;

    const result = await run(
      `INSERT INTO conversations (type, name, linked_module, linked_module_uuid, created_by)
       VALUES ('contextual', ?, ?, ?, ?)`,
      [convName, String(linkedModule), String(linkedModuleUuid), userId]
    );
    const convId = result.insertId;

    await run(
      `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'admin')`,
      [convId, userId]
    );

    if (Array.isArray(memberUserUuids)) {
      for (const mu of memberUserUuids) {
        const member = await resolveUserByUuid(String(mu));
        if (member && Number(member["id"]) !== userId) {
          await run(
            `INSERT IGNORE INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'member')`,
            [convId, Number(member["id"])]
          );
        }
      }
    }

    await sysMsg(convId, userId, `Discussion started for ${linkedModule}: ${linkedModuleUuid}`);

    const conv    = await resolveConvById(convId);
    const members = await getConvMembers(convId);

    res.status(201).json({
      success: true, message: "Contextual conversation created",
      data: { existing: false, conversation: { ...shapeConv(conv!), members } },
    });
  } catch (err) {
    console.error("[chat/createContextual]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── updateConversation ───────────────────────────────────────────────────────

export async function updateConversation(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;

    const conv = await resolveConvByUuid(uuid);
    if (!conv) {
      res.status(404).json({ success: false, message: "Conversation not found" });
      return;
    }

    const membership = await getMembership(Number(conv["id"]), userId);
    if (!membership || membership["role"] !== "admin") {
      res.status(403).json({ success: false, message: "Only conversation admins can update this conversation" });
      return;
    }

    const { name, description, avatarUrl, isAnnouncementOnly, isArchived } = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const params: unknown[] = [];

    if (name               !== undefined) { sets.push("name = ?");                   params.push(String(name).trim()); }
    if (description        !== undefined) { sets.push("description = ?");            params.push(description ? String(description) : null); }
    if (avatarUrl          !== undefined) { sets.push("avatar_url = ?");             params.push(avatarUrl ? String(avatarUrl) : null); }
    if (isAnnouncementOnly !== undefined) { sets.push("is_announcement_only = ?");   params.push(isAnnouncementOnly ? 1 : 0); }
    if (isArchived         !== undefined) { sets.push("is_archived = ?");            params.push(isArchived ? 1 : 0); }

    if (sets.length > 0) {
      params.push(Number(conv["id"]));
      await run(`UPDATE conversations SET ${sets.join(", ")} WHERE id = ?`, params);
    }

    await run(
      `INSERT INTO chat_activity (conversation_id, user_id, action) VALUES (?, ?, 'conversation_updated')`,
      [Number(conv["id"]), userId]
    );

    const updated = await resolveConvByUuid(uuid);
    res.json({ success: true, message: "Conversation updated", data: shapeConv(updated!) });
  } catch (err) {
    console.error("[chat/updateConversation]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── archiveConversation ──────────────────────────────────────────────────────

export async function archiveConversation(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;

    const conv = await resolveConvByUuid(uuid);
    if (!conv) {
      res.status(404).json({ success: false, message: "Conversation not found" });
      return;
    }

    const membership = await getMembership(Number(conv["id"]), userId);
    if (!membership) {
      res.status(403).json({ success: false, message: "You are not a member of this conversation" });
      return;
    }

    const newVal = Boolean(conv["isArchived"]) ? 0 : 1;
    await run(`UPDATE conversations SET is_archived = ? WHERE id = ?`, [newVal, Number(conv["id"])]);

    res.json({
      success: true,
      message: newVal ? "Conversation archived" : "Conversation unarchived",
      data: { isArchived: Boolean(newVal) },
    });
  } catch (err) {
    console.error("[chat/archiveConversation]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── addMembers ───────────────────────────────────────────────────────────────

export async function addMembers(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;
    const userRole = req.user!.role;

    const conv = await resolveConvByUuid(uuid);
    if (!conv) {
      res.status(404).json({ success: false, message: "Conversation not found" });
      return;
    }

    const membership  = await getMembership(Number(conv["id"]), userId);
    const isSiteAdmin = ADMIN_ROLES.includes(userRole);
    if (!isSiteAdmin && (!membership || membership["role"] !== "admin")) {
      res.status(403).json({ success: false, message: "Only conversation or site admins can add members" });
      return;
    }

    const { userUuid } = req.body as Record<string, unknown>;
    if (!userUuid) {
      res.status(400).json({ success: false, message: "userUuid is required" });
      return;
    }

    const targetUser = await resolveUserByUuid(String(userUuid));
    if (!targetUser) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }

    const targetId = Number(targetUser["id"]);

    // Already active member?
    const [active] = await q<RowDataPacket>(
      `SELECT id FROM conversation_members WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL`,
      [Number(conv["id"]), targetId]
    );
    if (active) {
      res.status(409).json({ success: false, message: "User is already a member" });
      return;
    }

    // Previously removed → re-add
    const [removed] = await q<RowDataPacket>(
      `SELECT id FROM conversation_members WHERE conversation_id = ? AND user_id = ? AND left_at IS NOT NULL`,
      [Number(conv["id"]), targetId]
    );
    if (removed) {
      await run(
        `UPDATE conversation_members SET left_at = NULL, joined_at = NOW() WHERE id = ?`,
        [Number(removed["id"])]
      );
    } else {
      await run(
        `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'member')`,
        [Number(conv["id"]), targetId]
      );
    }

    await sysMsg(Number(conv["id"]), userId, `${targetUser["name"]} was added to the group`);

    await run(
      `INSERT INTO chat_activity (conversation_id, user_id, action, detail) VALUES (?, ?, 'member_added', ?)`,
      [Number(conv["id"]), userId, String(targetUser["name"])]
    );

    // Subscribe new member's socket to the conversation room
    addUsersToConversationRoom([targetId], String(conv["uuid"]));
    notifyUsersConversationRefresh([targetId]);

    res.json({ success: true, message: "Member added", data: null });
  } catch (err) {
    console.error("[chat/addMembers]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── removeMember ─────────────────────────────────────────────────────────────

export async function removeMember(req: Request, res: Response): Promise<void> {
  try {
    const { uuid, userUuid: targetUserUuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;
    const userRole = req.user!.role;

    const conv = await resolveConvByUuid(uuid);
    if (!conv) {
      res.status(404).json({ success: false, message: "Conversation not found" });
      return;
    }

    const targetUser = await resolveUserByUuid(targetUserUuid);
    if (!targetUser) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }

    const targetId    = Number(targetUser["id"]);
    const isSelf      = targetId === userId;
    const membership  = await getMembership(Number(conv["id"]), userId);
    const isSiteAdmin = ADMIN_ROLES.includes(userRole);
    const isConvAdmin = membership?.["role"] === "admin";

    if (!isSelf && !isSiteAdmin && !isConvAdmin) {
      res.status(403).json({ success: false, message: "Not authorised to remove this member" });
      return;
    }

    await run(
      `UPDATE conversation_members SET left_at = NOW()
       WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL`,
      [Number(conv["id"]), targetId]
    );

    const actionMsg = isSelf
      ? `${targetUser["name"]} left the group`
      : `${targetUser["name"]} was removed`;

    await sysMsg(Number(conv["id"]), userId, actionMsg);

    await run(
      `INSERT INTO chat_activity (conversation_id, user_id, action, detail) VALUES (?, ?, ?, ?)`,
      [Number(conv["id"]), userId, isSelf ? "member_left" : "member_removed", String(targetUser["name"])]
    );

    res.json({ success: true, message: actionMsg, data: null });
  } catch (err) {
    console.error("[chat/removeMember]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── leaveConversation ────────────────────────────────────────────────────────

export async function leaveConversation(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;

    const conv = await resolveConvByUuid(uuid);
    if (!conv) {
      res.status(404).json({ success: false, message: "Conversation not found" });
      return;
    }

    const membership = await getMembership(Number(conv["id"]), userId);
    if (!membership) {
      res.status(400).json({ success: false, message: "You are not a member of this conversation" });
      return;
    }

    await run(
      `UPDATE conversation_members SET left_at = NOW()
       WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL`,
      [Number(conv["id"]), userId]
    );

    const [userRow] = await q<RowDataPacket>(`SELECT name FROM users WHERE id = ?`, [userId]);
    const userName  = String(userRow?.["name"] ?? "Someone");
    await sysMsg(Number(conv["id"]), userId, `${userName} left the group`);

    res.json({ success: true, message: "You have left the conversation", data: null });
  } catch (err) {
    console.error("[chat/leaveConversation]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── updateMemberRole ─────────────────────────────────────────────────────────

export async function updateMemberRole(req: Request, res: Response): Promise<void> {
  try {
    const { uuid, userUuid: targetUserUuid } = req.params as Record<string, string>;
    const userId = req.user!.id;

    const conv = await resolveConvByUuid(uuid);
    if (!conv) {
      res.status(404).json({ success: false, message: "Conversation not found" });
      return;
    }

    const myMembership = await getMembership(Number(conv["id"]), userId);
    if (!myMembership || myMembership["role"] !== "admin") {
      res.status(403).json({ success: false, message: "Only conversation admins can change member roles" });
      return;
    }

    const targetUser = await resolveUserByUuid(targetUserUuid);
    if (!targetUser) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }

    const { role } = req.body as Record<string, unknown>;
    if (role !== "admin" && role !== "member") {
      res.status(400).json({ success: false, message: "role must be 'admin' or 'member'" });
      return;
    }

    await run(
      `UPDATE conversation_members SET role = ?
       WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL`,
      [role, Number(conv["id"]), Number(targetUser["id"])]
    );

    res.json({ success: true, message: "Member role updated", data: { role } });
  } catch (err) {
    console.error("[chat/updateMemberRole]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── muteConversation ─────────────────────────────────────────────────────────

export async function muteConversation(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;

    const conv = await resolveConvByUuid(uuid);
    if (!conv) {
      res.status(404).json({ success: false, message: "Conversation not found" });
      return;
    }

    const membership = await getMembership(Number(conv["id"]), userId);
    if (!membership) {
      res.status(403).json({ success: false, message: "You are not a member of this conversation" });
      return;
    }

    const newVal = Boolean(membership["isMuted"]) ? 0 : 1;
    await run(
      `UPDATE conversation_members SET is_muted = ?
       WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL`,
      [newVal, Number(conv["id"]), userId]
    );

    res.json({
      success: true,
      message: newVal ? "Conversation muted" : "Conversation unmuted",
      data: { isMuted: Boolean(newVal) },
    });
  } catch (err) {
    console.error("[chat/muteConversation]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── markAsRead ───────────────────────────────────────────────────────────────

export async function markAsRead(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;

    const conv = await resolveConvByUuid(uuid);
    if (!conv) {
      res.status(404).json({ success: false, message: "Conversation not found" });
      return;
    }

    const membership = await getMembership(Number(conv["id"]), userId);
    if (!membership) {
      res.status(403).json({ success: false, message: "You are not a member of this conversation" });
      return;
    }

    await run(
      `UPDATE conversation_members SET last_read_at = NOW()
       WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL`,
      [Number(conv["id"]), userId]
    );

    res.json({ success: true, message: "Marked as read", data: null });
  } catch (err) {
    console.error("[chat/markAsRead]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── getUnreadCounts ──────────────────────────────────────────────────────────

export async function getUnreadCounts(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;

    const rows = await q<RowDataPacket>(`
      SELECT c.uuid,
        COUNT(m.id) AS unreadCount
      FROM conversations c
      JOIN conversation_members cm
        ON cm.conversation_id = c.id AND cm.user_id = ? AND cm.left_at IS NULL
      LEFT JOIN messages m
        ON m.conversation_id = c.id
           AND m.is_deleted = FALSE
           AND m.sender_id != ?
           AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)
      GROUP BY c.id, c.uuid`,
      [userId, userId]
    );

    const conversations: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const count = Number(r["unreadCount"]);
      conversations[String(r["uuid"])] = count;
      total += count;
    }

    res.json({ success: true, message: "OK", data: { total, conversations } });
  } catch (err) {
    console.error("[chat/getUnreadCounts]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── getPinnedMessages ────────────────────────────────────────────────────────

export async function getPinnedMessages(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const userId   = req.user!.id;

    const conv = await resolveConvByUuid(uuid);
    if (!conv) {
      res.status(404).json({ success: false, message: "Conversation not found" });
      return;
    }

    const membership = await getMembership(Number(conv["id"]), userId);
    if (!membership) {
      res.status(403).json({ success: false, message: "You are not a member of this conversation" });
      return;
    }

    const rows = await q<RowDataPacket>(
      `SELECT m.id, m.uuid, m.content, m.type, m.sender_id AS senderId, m.created_at AS createdAt,
              pm.pinned_by AS pinnedBy, pm.pinned_at AS pinnedAt,
              u.uuid AS senderUuid, u.name AS senderName, u.avatar_url AS senderAvatar
       FROM pinned_messages pm
       JOIN messages m ON m.id = pm.message_id
       JOIN users u ON u.id = m.sender_id
       WHERE pm.conversation_id = ?
       ORDER BY pm.pinned_at DESC`,
      [Number(conv["id"])]
    );

    res.json({
      success: true, message: "OK",
      data: rows.map(r => ({
        id:        r["id"],
        uuid:      r["uuid"],
        content:   r["content"],
        type:      r["type"],
        senderId:  r["senderId"],
        createdAt: r["createdAt"],
        pinnedBy:  r["pinnedBy"],
        pinnedAt:  r["pinnedAt"],
        sender: { uuid: r["senderUuid"], name: r["senderName"], avatarUrl: r["senderAvatar"] ?? null },
      })),
    });
  } catch (err) {
    console.error("[chat/getPinnedMessages]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── searchConversations ──────────────────────────────────────────────────────

export async function searchConversations(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const { q: term } = req.query as Record<string, string | undefined>;

    if (!term || !term.trim()) {
      res.status(400).json({ success: false, message: "q is required" });
      return;
    }

    const like = `%${term.trim()}%`;

    const rows = await q<RowDataPacket>(`
      SELECT DISTINCT
        c.id, c.uuid, c.type, c.name, c.description, c.avatar_url AS avatarUrl,
        c.is_announcement_only AS isAnnouncementOnly, c.is_archived AS isArchived,
        c.linked_module AS linkedModule, c.linked_module_uuid AS linkedModuleUuid,
        c.created_by AS createdBy, c.last_message_at AS lastMessageAt,
        c.last_message_preview AS lastMessagePreview, c.created_at AS createdAt
      FROM conversations c
      JOIN conversation_members cm
        ON cm.conversation_id = c.id AND cm.user_id = ? AND cm.left_at IS NULL
      LEFT JOIN conversation_members cm_all
        ON cm_all.conversation_id = c.id AND cm_all.left_at IS NULL
      LEFT JOIN users u_m ON u_m.id = cm_all.user_id
      WHERE (c.name LIKE ? OR u_m.name LIKE ?)
      ORDER BY c.last_message_at DESC
      LIMIT 10`,
      [userId, like, like]
    );

    res.json({ success: true, message: "OK", data: rows.map(shapeConv) });
  } catch (err) {
    console.error("[chat/searchConversations]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
