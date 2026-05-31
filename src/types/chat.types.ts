// src/types/chat.types.ts

export interface ChatUser {
  id: number;
  uuid: string;
  name: string;
  email: string;
  role: string;
  avatarUrl?: string;
  isOnline?: boolean;
  lastSeen?: string;
}

export interface ConversationMember {
  id: number;
  conversationId: number;
  userId: number;
  role: "admin" | "member";
  isMuted: boolean;
  joinedAt: string;
  lastReadAt?: string;
  user?: ChatUser;
}

export interface Conversation {
  id: number;
  uuid: string;
  type: "direct" | "group" | "contextual";
  name?: string;
  description?: string;
  avatarUrl?: string;
  isAnnouncementOnly: boolean;
  isArchived: boolean;
  linkedModule: string;
  linkedModuleUuid?: string;
  createdBy: number;
  lastMessageAt?: string;
  lastMessagePreview?: string;
  members?: ConversationMember[];
  unreadCount?: number;
  createdAt: string;
}

export interface MessageAttachment {
  id: number;
  uuid: string;
  messageId: number;
  fileName: string;
  filePath: string;
  fileSize: number;
  fileType: string;
  thumbnailPath?: string;
  downloadCount: number;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  users: number[];
  userReacted: boolean;
}

export interface Message {
  id: number;
  uuid: string;
  conversationId: number;
  senderId: number;
  type: "text" | "image" | "file" | "system";
  content: string;
  replyToId?: number;
  replyTo?: Message;
  isEdited: boolean;
  editedAt?: string;
  isDeleted: boolean;
  isPinned: boolean;
  reactions?: MessageReaction[];
  attachments?: MessageAttachment[];
  sender?: ChatUser;
  readBy?: number[];
  createdAt: string;
}
