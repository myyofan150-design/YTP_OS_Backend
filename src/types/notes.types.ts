// src/types/notes.types.ts

export interface NoteTag {
  id:        number;
  uuid:      string;
  name:      string;
  color:     string;
  createdBy: number;
  createdAt: Date | string;
}

export interface NoteAttachment {
  id:         number;
  uuid:       string;
  noteId:     number;
  fileName:   string;
  filePath:   string;
  fileSize:   number;
  fileType:   string;
  uploadedBy: number;
  createdAt:  Date | string;
}

export interface NoteMention {
  id:              number;
  noteId:          number;
  mentionedUserId: number;
  createdAt:       Date | string;
  user?: { name: string; avatarUrl?: string | null };
}

export interface NoteActivity {
  id:        number;
  noteId:    number;
  userId:    number;
  action:    string;
  detail:    string | null;
  createdAt: Date | string;
  user?: { name: string; avatarUrl?: string | null };
}

export interface Note {
  id:               number;
  uuid:             string;
  title:            string;
  content:          string | null;
  category:         string;
  priority:         string;
  status:           string;
  isStarred:        boolean;
  isRead:           boolean;
  isSnoozed:        boolean;
  snoozedUntil?:    string | null;
  linkedClientId?:  number | null;
  linkedClient?:    { id: number; companyName: string } | null;
  linkedModule:     string;
  linkedModuleId?:  number | null;
  linkedModuleUuid?: string | null;
  assignedTo?:      number | null;
  assignedUser?:    { id: number; name: string; avatarUrl?: string | null } | null;
  createdBy:        number;
  createdByUser?:   { name: string; avatarUrl?: string | null } | null;
  tags:             NoteTag[];
  attachments?:     NoteAttachment[];
  mentions?:        NoteMention[];
  deletedAt?:       string | null;
  createdAt:        Date | string;
  updatedAt:        Date | string;
  // computed
  attachmentCount?: number;
  contentExcerpt?:  string | null;
}

export interface NoteFilters {
  category?:       string;
  priority?:       string;
  status?:         string;
  tagId?:          string;
  assignedTo?:     string;
  isStarred?:      boolean;
  hasAttachments?: boolean;
  linkedModule?:   string;
  search?:         string;
  sortBy?:         "newest" | "oldest" | "updated";
  page?:           number;
  limit?:          number;
}
