// src/lib/lead-rules.ts
// Shared business-logic constants and helpers for the lead module.

// ─── Status pipeline ──────────────────────────────────────────────────────────

// Labels that cannot be deleted or renamed — the transition engine depends on them.
export const RESERVED_STATUS_LABELS   = new Set(["New", "Won", "Lost"]);
export const RESERVED_PRIORITY_LABELS = new Set(["Cold", "Warm", "Hot", "Done"]);

export const TERMINAL_STATUSES = new Set(["Won", "Lost"]);

// Allowed forward transitions. "Lost" is reachable from any non-terminal status
// but ONLY through the /mark-lost endpoint (which requires a reason).
// updateLead with statusId pointing to "Lost" is explicitly blocked.
export const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  "New":           ["Contacted"],
  "Contacted":     ["Qualified"],
  "Qualified":     ["Proposal Sent"],
  "Proposal Sent": ["Negotiation"],
  "Negotiation":   ["Won", "Lost"],
  "Won":           [],
  "Lost":          [],
};

// Fields that are locked (read-only) once the lead is Won or Lost.
// Keys match the camelCase names coming in req.body.
export const TERMINAL_LOCKED_FIELDS = new Set([
  "statusId",
  "assignedTo",
  "sourceId",
  "priorityId",
  "budgetMin",
  "budgetMax",
  "services",
  "requirementDescription",
  "timeline",
  "nextFollowup",
  "meetingDatetime",
]);

// Statuses at or beyond "Proposal Sent" — budget becomes increase-only.
export const POST_PROPOSAL_STATUSES = new Set(["Proposal Sent", "Negotiation", "Won"]);

// ─── Stage gate ───────────────────────────────────────────────────────────────

export interface GateData {
  companyName:            unknown;
  email:                  unknown;
  phone:                  unknown;
  sourceId:               unknown;
  assignedTo:             unknown;
  requirementDescription: unknown;
  budgetMin:              unknown;
  budgetMax:              unknown;
  timeline:               unknown;
  nextFollowup:           unknown;
  lastContacted:          unknown;
  servicesCount:          number;
}

function hasValue(v: unknown): boolean {
  return v != null && v !== "" && v !== 0;
}

/** Returns an error message if the stage gate is not met, otherwise null. */
export function checkStageGate(targetLabel: string, d: GateData): string | null {
  switch (targetLabel) {
    case "Contacted":
      if (!hasValue(d.email) && !hasValue(d.phone))
        return "At least one of email or phone is required before moving to Contacted";
      if (!hasValue(d.sourceId))
        return "Source is required before moving to Contacted";
      if (!hasValue(d.lastContacted))
        return "Last contacted date is required before moving to Contacted";
      break;

    case "Qualified":
      if (!hasValue(d.companyName))
        return "Company name is required before moving to Qualified";
      if (!hasValue(d.requirementDescription))
        return "Requirement description is required before moving to Qualified";
      if (!hasValue(d.assignedTo))
        return "Lead must be assigned to a team member before moving to Qualified";
      if (d.servicesCount === 0)
        return "At least one service must be assigned before moving to Qualified";
      break;

    case "Proposal Sent":
      if (!hasValue(d.budgetMin) && !hasValue(d.budgetMax))
        return "Budget must be set before sending a proposal";
      if (!hasValue(d.timeline))
        return "Timeline is required before sending a proposal";
      if (!hasValue(d.nextFollowup))
        return "Next follow-up date is required before sending a proposal";
      break;

    case "Won":
      if (!hasValue(d.budgetMin) || !hasValue(d.budgetMax))
        return "Both budget min and max are required to mark a lead as Won";
      if (!hasValue(d.companyName))
        return "Company name is required to mark a lead as Won";
      break;
  }
  return null;
}

// ─── Format validators ────────────────────────────────────────────────────────

export function isValidEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export function isValidPhone(v: string): boolean {
  // 7–20 chars: digits, +, -, spaces, parentheses, dots
  return /^[+\d\s\-(). ]{7,20}$/.test(v.trim());
}

export function isValidUrl(v: string): boolean {
  return /^https?:\/\/.+/.test(v.trim());
}

// ─── Date validators (string-based, timezone-safe) ───────────────────────────

function todayISO(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD" in UTC
}

function isValidDateStr(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s.slice(0, 10));
}

/** Date must be today or later (timeline, next_followup). */
export function isTodayOrFutureDate(dateStr: string): boolean {
  const d = String(dateStr).slice(0, 10);
  return isValidDateStr(d) && d >= todayISO();
}

/** Date must be today or earlier (last_contacted). */
export function isTodayOrPastDate(dateStr: string): boolean {
  const d = String(dateStr).slice(0, 10);
  return isValidDateStr(d) && d <= todayISO();
}

/** Datetime must be strictly in the future (meeting_datetime). */
export function isFutureDatetime(dtStr: string): boolean {
  const d = new Date(dtStr);
  return !isNaN(d.getTime()) && d > new Date();
}

// ─── DB duplicate-entry detection ────────────────────────────────────────────

export function isDupEntry(err: unknown): boolean {
  return (err as { code?: string; errno?: number })?.code === "ER_DUP_ENTRY"
      || (err as { code?: string; errno?: number })?.errno === 1062;
}
