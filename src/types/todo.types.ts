// src/types/todo.types.ts

export interface TodoGroup {
  id: number;
  uuid: string;
  name: string;
  color: string;
  sortOrder: number;
  createdBy: number;
  createdAt: Date | string;
  listCount?: number;
}

export interface TodoList {
  id: number;
  uuid: string;
  groupId: number | null;
  name: string;
  color: string;
  isFavorite: boolean;
  assignedTo: number | null;
  sortOrder: number;
  createdBy: number;
  createdAt: Date | string;
  taskCount?: number;
  pendingCount?: number;
}

export interface TodoSubtask {
  id: number;
  uuid: string;
  taskId: number;
  title: string;
  status: "pending" | "completed";
  sortOrder: number;
  completedAt: Date | string | null;
}

export interface TodoAttachment {
  id: number;
  uuid: string;
  taskId: number;
  fileName: string;
  filePath: string;
  fileSize: number | null;
  fileType: string | null;
  uploadedBy: number;
  createdAt: Date | string;
}

export interface TodoActivity {
  id: number;
  taskId: number;
  userId: number;
  action: string;
  detail: string | null;
  createdAt: Date | string;
  user?: {
    name: string;
    avatarUrl: string | null;
  };
}

export type RepeatType = "none" | "daily" | "weekdays" | "weekly" | "monthly" | "yearly" | "custom";

export interface RepeatConfig {
  every?: number;
  unit?: string;
  endAfter?: number;
  endDate?: string;
}

export interface TodoTask {
  id: number;
  uuid: string;
  listId: number;
  title: string;
  description: string | null;
  status: "pending" | "completed";
  priority: "none" | "low" | "medium" | "high";
  stage: "todo" | "inprogress";
  dueDate: string | null;
  dueTime: string | null;
  reminderAt: Date | string | null;
  repeatType: RepeatType;
  repeatConfig: RepeatConfig | null;
  bgColor: string;
  isFavorite: boolean;
  assignedTo: number | null;
  sortOrder: number;
  completedAt: Date | string | null;
  createdBy: number;
  createdAt: Date | string;
  subtasks?: TodoSubtask[];
  attachments?: TodoAttachment[];
  note?: string | null;
  activityCount?: number;
}

export type SmartViewType = "today" | "assigned_to_me" | "important" | "completed" | "overdue";
