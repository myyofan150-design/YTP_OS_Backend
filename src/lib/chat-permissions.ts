// src/lib/chat-permissions.ts

const INTERNAL_ROLES = new Set([
  "SUPER_ADMIN", "ADMIN", "HR", "TEAM_LEAD", "EMPLOYEE", "ACCOUNTANT",
]);

export function isInternalUser(role: string): boolean {
  return INTERNAL_ROLES.has(role);
}

export function canUserChat(senderRole: string, receiverRole: string): boolean {
  // Employee ↔ Client blocked
  if (!isInternalUser(senderRole) || !isInternalUser(receiverRole)) {
    // Admin ↔ Client is allowed
    const senderIsAdmin  = senderRole   === "SUPER_ADMIN" || senderRole   === "ADMIN";
    const receiverIsAdmin = receiverRole === "SUPER_ADMIN" || receiverRole === "ADMIN";
    if (senderIsAdmin || receiverIsAdmin) return true;
    return false;
  }
  return true;
}

export function canUserCreateGroup(role: string): boolean {
  return role === "SUPER_ADMIN" || role === "ADMIN";
}

export function canUserAddMember(role: string): boolean {
  return role === "SUPER_ADMIN" || role === "ADMIN";
}

export function canUserPostInConversation(
  userRole: string,
  conversationIsAnnouncementOnly: boolean,
  memberRole: "admin" | "member"
): boolean {
  if (!conversationIsAnnouncementOnly) return true;
  return memberRole === "admin";
}
