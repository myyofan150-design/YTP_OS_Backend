// src/types/lead.types.ts

export interface LeadMetaOption {
  id: number;
  uuid: string;
  type: "source" | "status" | "priority" | "service";
  label: string;
  color: string;
  sortOrder: number;
  createdAt: string;
}

export interface Lead {
  id: number;
  uuid: string;
  contactPerson: string;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  industry: string | null;
  country: string | null;
  city: string | null;
  website: string | null;
  sourceId: number | null;
  assignedTo: number | null;
  statusId: number | null;
  priorityId: number | null;
  budgetMin: number | null;
  budgetMax: number | null;
  timeline: string | null;
  requirementDescription: string | null;
  lastContacted: string | null;
  nextFollowup: string | null;
  meetingDatetime: string | null;
  converted: boolean;
  convertedClientId:   number | null;
  convertedClientUuid: string | null;
  lostReason: string | null;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
}

export interface AssignedUser {
  id: number;
  uuid: string;
  name: string;
  email: string;
}

export interface LeadWithRelations extends Lead {
  source: LeadMetaOption | null;
  status: LeadMetaOption | null;
  priority: LeadMetaOption | null;
  services: LeadMetaOption[];
  assignedUser: AssignedUser | null;
}
