// src/controllers/leads.controller.ts
import { Request, Response } from "express";
import { q, run, RowDataPacket } from "../lib/db";
import { logActivity } from "../lib/logger";
import type { LeadWithRelations, LeadMetaOption, AssignedUser } from "../types/lead.types";
import {
  TERMINAL_STATUSES,
  TERMINAL_LOCKED_FIELDS,
  ALLOWED_TRANSITIONS,
  POST_PROPOSAL_STATUSES,
  checkStageGate,
  isValidEmail,
  isValidPhone,
  isValidUrl,
  isTodayOrFutureDate,
  isTodayOrPastDate,
  isFutureDatetime,
  type GateData,
} from "../lib/lead-rules";

// ─── Budget validation ────────────────────────────────────────────────────────

const MAX_BUDGET = 9_999_999_999;

function parseBudget(val: unknown): number | null {
  if (val == null || val === "" || Number(val) === 0) return null;
  const n = Math.floor(Number(val));
  return isNaN(n) ? null : n;
}

function validateBudget(
  rawMin: unknown,
  rawMax: unknown,
): { min: number | null; max: number | null; error: string | null } {
  const min = parseBudget(rawMin);
  const max = parseBudget(rawMax);
  if (min !== null && min < 1)                    return { min, max, error: "Budget min must be greater than zero" };
  if (max !== null && max < 1)                    return { min, max, error: "Budget max must be greater than zero" };
  if (min !== null && min > MAX_BUDGET)           return { min, max, error: "Budget min value is too large" };
  if (max !== null && max > MAX_BUDGET)           return { min, max, error: "Budget max value is too large" };
  if (min !== null && max !== null && min > max)  return { min, max, error: "Budget min cannot exceed budget max" };
  return { min, max, error: null };
}

// ─── Field-level format validation ───────────────────────────────────────────

function validateLeadFields(body: Record<string, unknown>): string | null {
  const { contactPerson, email, phone, whatsapp, website,
          timeline, lastContacted, nextFollowup, meetingDatetime } = body;

  if (contactPerson !== undefined) {
    const t = String(contactPerson).trim();
    if (t.length < 2) return "contactPerson must be at least 2 characters";
  }

  if (email != null && email !== "")
    if (!isValidEmail(String(email))) return "Invalid email format";

  if (phone != null && phone !== "")
    if (!isValidPhone(String(phone))) return "Invalid phone number format";

  if (whatsapp != null && whatsapp !== "")
    if (!isValidPhone(String(whatsapp))) return "Invalid WhatsApp number format";

  if (website != null && website !== "")
    if (!isValidUrl(String(website))) return "Website must start with http:// or https://";

  if (timeline != null && timeline !== "")
    if (!isTodayOrFutureDate(String(timeline))) return "Timeline must be today or a future date";

  if (lastContacted != null && lastContacted !== "")
    if (!isTodayOrPastDate(String(lastContacted))) return "Last contacted date cannot be in the future";

  if (nextFollowup != null && nextFollowup !== "")
    if (!isTodayOrFutureDate(String(nextFollowup))) return "Next follow-up must be today or a future date";

  if (meetingDatetime != null && meetingDatetime !== "")
    if (!isFutureDatetime(String(meetingDatetime))) return "Meeting date/time must be in the future";

  return null;
}

// ─── SQL fragments ────────────────────────────────────────────────────────────

const LEAD_SEL = `
  l.id, l.uuid, l.contact_person, l.company_name, l.email, l.phone, l.whatsapp,
  l.industry, l.country, l.city, l.website,
  l.source_id, l.assigned_to, l.status_id, l.priority_id,
  l.budget_min, l.budget_max, l.timeline, l.requirement_description,
  l.last_contacted, l.next_followup, l.meeting_datetime,
  l.converted, l.converted_client_id, l.lost_reason,
  l.created_by, l.created_at, l.updated_at,
  src.uuid AS srcUuid, src.label AS srcLabel, src.color AS srcColor, src.sort_order AS srcSortOrder,
  st.uuid  AS stUuid,  st.label  AS stLabel,  st.color  AS stColor,  st.sort_order  AS stSortOrder,
  pr.uuid  AS prUuid,  pr.label  AS prLabel,  pr.color  AS prColor,  pr.sort_order  AS prSortOrder,
  u.uuid   AS userUuid, u.name   AS userName, u.email   AS userEmail,
  cc.uuid  AS convertedClientUuid`;

const LEAD_FROM = `
  FROM leads l
  LEFT JOIN lead_meta_options src ON src.id = l.source_id        AND src.type = 'source'
  LEFT JOIN lead_meta_options st  ON st.id  = l.status_id        AND st.type = 'status'
  LEFT JOIN lead_meta_options pr  ON pr.id  = l.priority_id      AND pr.type = 'priority'
  LEFT JOIN users u               ON u.id   = l.assigned_to
  LEFT JOIN clients cc            ON cc.id  = l.converted_client_id`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rowToLead(r: RowDataPacket): Omit<LeadWithRelations, "services"> {
  const toMeta = (
    type: LeadMetaOption["type"],
    id: unknown, uuid: unknown, label: unknown, color: unknown, sortOrder: unknown,
  ): LeadMetaOption | null =>
    uuid
      ? { id: Number(id), uuid: String(uuid), type, label: String(label), color: String(color), sortOrder: Number(sortOrder ?? 0), createdAt: "" }
      : null;

  const toUser = (): AssignedUser | null =>
    r["userUuid"]
      ? { id: Number(r["assigned_to"]), uuid: String(r["userUuid"]), name: String(r["userName"]), email: String(r["userEmail"]) }
      : null;

  return {
    id:                     Number(r["id"]),
    uuid:                   String(r["uuid"]),
    contactPerson:          String(r["contact_person"]),
    companyName:            r["company_name"]            != null ? String(r["company_name"])            : null,
    email:                  r["email"]                   != null ? String(r["email"])                   : null,
    phone:                  r["phone"]                   != null ? String(r["phone"])                   : null,
    whatsapp:               r["whatsapp"]                != null ? String(r["whatsapp"])                : null,
    industry:               r["industry"]                != null ? String(r["industry"])                : null,
    country:                r["country"]                 != null ? String(r["country"])                 : null,
    city:                   r["city"]                    != null ? String(r["city"])                    : null,
    website:                r["website"]                 != null ? String(r["website"])                 : null,
    sourceId:               r["source_id"]               != null ? Number(r["source_id"])               : null,
    assignedTo:             r["assigned_to"]             != null ? Number(r["assigned_to"])             : null,
    statusId:               r["status_id"]               != null ? Number(r["status_id"])               : null,
    priorityId:             r["priority_id"]             != null ? Number(r["priority_id"])             : null,
    budgetMin:              r["budget_min"]              != null ? Number(r["budget_min"])              : null,
    budgetMax:              r["budget_max"]              != null ? Number(r["budget_max"])              : null,
    timeline:               r["timeline"]                != null ? String(r["timeline"]).slice(0, 10)   : null,
    requirementDescription: r["requirement_description"] != null ? String(r["requirement_description"]) : null,
    lastContacted:          r["last_contacted"]          != null ? String(r["last_contacted"]).slice(0, 10)  : null,
    nextFollowup:           r["next_followup"]           != null ? String(r["next_followup"]).slice(0, 10)   : null,
    meetingDatetime:        r["meeting_datetime"]        != null ? String(r["meeting_datetime"])        : null,
    converted:              Boolean(r["converted"]),
    convertedClientId:      r["converted_client_id"]    != null ? Number(r["converted_client_id"])     : null,
    convertedClientUuid:    r["convertedClientUuid"]    != null ? String(r["convertedClientUuid"])     : null,
    lostReason:             r["lost_reason"]             != null ? String(r["lost_reason"])             : null,
    createdBy:              Number(r["created_by"]),
    createdAt:              String(r["created_at"]),
    updatedAt:              String(r["updated_at"]),
    source:   toMeta("source",   r["source_id"],   r["srcUuid"], r["srcLabel"], r["srcColor"], r["srcSortOrder"]),
    status:   toMeta("status",   r["status_id"],   r["stUuid"],  r["stLabel"],  r["stColor"],  r["stSortOrder"]),
    priority: toMeta("priority", r["priority_id"], r["prUuid"],  r["prLabel"],  r["prColor"],  r["prSortOrder"]),
    assignedUser: toUser(),
  };
}

async function fetchServicesForLeads(leadIds: number[]): Promise<Map<number, LeadMetaOption[]>> {
  if (!leadIds.length) return new Map();
  const ph   = leadIds.map(() => "?").join(",");
  const rows = await q<RowDataPacket>(
    `SELECT ls.lead_id, m.id, m.uuid, m.label, m.color, m.sort_order
     FROM lead_services ls
     JOIN lead_meta_options m ON m.id = ls.service_id AND m.type = 'service'
     WHERE ls.lead_id IN (${ph})
     ORDER BY m.sort_order, m.label`,
    leadIds,
  );
  const map = new Map<number, LeadMetaOption[]>();
  for (const r of rows) {
    const lid = Number(r["lead_id"]);
    if (!map.has(lid)) map.set(lid, []);
    map.get(lid)!.push({
      id: Number(r["id"]), uuid: String(r["uuid"]), type: "service",
      label: String(r["label"]), color: String(r["color"]),
      sortOrder: Number(r["sort_order"] ?? 0), createdAt: "",
    });
  }
  return map;
}

async function getFullLead(leadId: number): Promise<LeadWithRelations | null> {
  const rows = await q<RowDataPacket>(`SELECT ${LEAD_SEL} ${LEAD_FROM} WHERE l.id = ?`, [leadId]);
  if (!rows.length) return null;
  const lead   = rowToLead(rows[0]);
  const svcMap = await fetchServicesForLeads([leadId]);
  return { ...lead, services: svcMap.get(leadId) ?? [] };
}

function buildFilters(
  query: Record<string, string | undefined>,
  restrictToUserId?: number,
): { where: string; params: unknown[] } {
  let where = "WHERE 1=1";
  const params: unknown[] = [];

  if (restrictToUserId != null) { where += " AND l.assigned_to = ?"; params.push(restrictToUserId); }

  const { search, statusId, priorityId, sourceId, assignedTo, converted, serviceId, followup } = query;
  if (search)     { where += " AND (l.contact_person LIKE ? OR l.company_name LIKE ? OR l.email LIKE ?)"; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (statusId)   { where += " AND l.status_id = ?";   params.push(Number(statusId)); }
  if (priorityId) { where += " AND l.priority_id = ?"; params.push(Number(priorityId)); }
  if (sourceId)   { where += " AND l.source_id = ?";   params.push(Number(sourceId)); }
  if (assignedTo && restrictToUserId == null) { where += " AND l.assigned_to = ?"; params.push(Number(assignedTo)); }
  if (converted !== undefined) { where += " AND l.converted = ?"; params.push(converted === "1" ? 1 : 0); }
  if (serviceId)  { where += " AND EXISTS (SELECT 1 FROM lead_services ls WHERE ls.lead_id = l.id AND ls.service_id = ?)"; params.push(Number(serviceId)); }

  if      (followup === "today")   { where += " AND DATE(l.next_followup) = CURDATE()"; }
  else if (followup === "overdue") { where += " AND l.next_followup IS NOT NULL AND DATE(l.next_followup) < CURDATE()"; }
  else if (followup === "week")    { where += " AND l.next_followup IS NOT NULL AND DATE(l.next_followup) BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)"; }

  return { where, params };
}

// ─── GET /api/leads ───────────────────────────────────────────────────────────

export async function listLeads(req: Request, res: Response): Promise<void> {
  try {
    // Clamp page and limit to safe values; treat NaN as default
    const page  = Math.max(1,   parseInt((req.query["page"]  as string) || "1",  10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt((req.query["limit"] as string) || "20", 10) || 20));
    const offset = (page - 1) * limit;

    const isEmployee = req.user!.role === "EMPLOYEE";
    const { where, params } = buildFilters(
      req.query as Record<string, string | undefined>,
      isEmployee ? req.user!.id : undefined,
    );

    const [[countRow], rows] = await Promise.all([
      q<RowDataPacket>(`SELECT COUNT(*) AS total ${LEAD_FROM} ${where}`, params),
      q<RowDataPacket>(
        `SELECT ${LEAD_SEL} ${LEAD_FROM} ${where} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
    ]);

    const total   = Number(countRow?.["total"] ?? 0);
    const leadIds = rows.map(r => Number(r["id"]));
    const svcMap  = await fetchServicesForLeads(leadIds);
    const leads   = rows.map(r => ({ ...rowToLead(r), services: svcMap.get(Number(r["id"])) ?? [] }));

    res.json({ success: true, data: { leads, total, page, limit }, message: "OK" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─── POST /api/leads ──────────────────────────────────────────────────────────

export async function createLead(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    const {
      contactPerson, companyName, email, phone, whatsapp, industry, country, city, website,
      sourceId, assignedTo, priorityId, budgetMin, budgetMax, timeline,
      requirementDescription, lastContacted, nextFollowup, meetingDatetime, services,
    } = body;

    // contactPerson: required, min 2 chars
    if (!contactPerson || !String(contactPerson).trim()) {
      res.status(400).json({ success: false, message: "contactPerson is required" });
      return;
    }
    if (String(contactPerson).trim().length < 2) {
      res.status(400).json({ success: false, message: "contactPerson must be at least 2 characters" });
      return;
    }

    // Format validations
    const fieldErr = validateLeadFields(body);
    if (fieldErr) {
      res.status(400).json({ success: false, message: fieldErr });
      return;
    }

    // Budget cross-validation
    const budget = validateBudget(budgetMin, budgetMax);
    if (budget.error) {
      res.status(400).json({ success: false, message: budget.error });
      return;
    }

    // Validate sourceId references a real 'source' meta option
    if (sourceId != null) {
      const srcRows = await q<RowDataPacket>(
        "SELECT id FROM lead_meta_options WHERE id = ? AND type = 'source'", [Number(sourceId)],
      );
      if (!srcRows.length) {
        res.status(400).json({ success: false, message: "Invalid sourceId — not a valid source option" });
        return;
      }
    }

    // Validate priorityId references a real 'priority' meta option
    if (priorityId != null) {
      const prRows = await q<RowDataPacket>(
        "SELECT id FROM lead_meta_options WHERE id = ? AND type = 'priority'", [Number(priorityId)],
      );
      if (!prRows.length) {
        res.status(400).json({ success: false, message: "Invalid priorityId — not a valid priority option" });
        return;
      }
    }

    // Validate assignedTo references a real user
    if (assignedTo != null) {
      const userRows = await q<RowDataPacket>("SELECT id FROM users WHERE id = ?", [Number(assignedTo)]);
      if (!userRows.length) {
        res.status(400).json({ success: false, message: "Invalid assignedTo — user not found" });
        return;
      }
    }

    // Validate service IDs reference real 'service' meta options
    if (Array.isArray(services) && services.length > 0) {
      const ph   = services.map(() => "?").join(",");
      const nums = services.map(s => Number(s));
      const svcRows = await q<RowDataPacket>(
        `SELECT id FROM lead_meta_options WHERE id IN (${ph}) AND type = 'service'`, nums,
      );
      if (svcRows.length !== services.length) {
        res.status(400).json({ success: false, message: "One or more service IDs are invalid" });
        return;
      }
    }

    // New leads always start at "New" status — fetch its ID
    const newStatusRows = await q<RowDataPacket>(
      "SELECT id FROM lead_meta_options WHERE type = 'status' AND label = 'New' LIMIT 1",
    );
    if (!newStatusRows.length) {
      res.status(500).json({ success: false, message: "System error: 'New' status not configured" });
      return;
    }
    const newStatusId = Number(newStatusRows[0]["id"]);

    const result = await run(
      `INSERT INTO leads
         (contact_person, company_name, email, phone, whatsapp, industry, country, city, website,
          source_id, assigned_to, status_id, priority_id, budget_min, budget_max, timeline,
          requirement_description, last_contacted, next_followup, meeting_datetime, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(contactPerson).trim(),
        companyName ?? null,
        email       ?? null,
        phone       ?? null,
        whatsapp    ?? null,
        industry    ?? null,
        country     ?? null,
        city        ?? null,
        website     ?? null,
        sourceId   != null ? Number(sourceId)   : null,
        assignedTo != null ? Number(assignedTo) : null,
        newStatusId,           // always "New"
        priorityId != null ? Number(priorityId) : null,
        budget.min,
        budget.max,
        timeline               ?? null,
        requirementDescription ?? null,
        lastContacted          ?? null,
        nextFollowup           ?? null,
        meetingDatetime        ?? null,
        req.user!.id,
      ],
    );
    const leadId = result.insertId;

    if (Array.isArray(services) && services.length > 0) {
      for (const svcId of services) {
        await run(
          "INSERT IGNORE INTO lead_services (lead_id, service_id) VALUES (?, ?)",
          [leadId, Number(svcId)],
        );
      }
    }

    const lead = await getFullLead(leadId);
    await logActivity(req.user!.id, "lead.created", "lead", leadId, undefined, { contactPerson, companyName }, req.ip);
    res.status(201).json({ success: true, data: lead, message: "Lead created" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─── GET /api/leads/:uuid ─────────────────────────────────────────────────────

export async function getLead(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params;
    const rows = await q<RowDataPacket>(`SELECT ${LEAD_SEL} ${LEAD_FROM} WHERE l.uuid = ?`, [uuid]);
    if (!rows.length) {
      res.status(404).json({ success: false, message: "Lead not found" });
      return;
    }

    const isEmployee = req.user!.role === "EMPLOYEE";
    if (isEmployee && Number(rows[0]["assigned_to"]) !== req.user!.id) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    const leadId = Number(rows[0]["id"]);
    const lead   = rowToLead(rows[0]);
    const svcMap = await fetchServicesForLeads([leadId]);

    res.json({ success: true, data: { ...lead, services: svcMap.get(leadId) ?? [] }, message: "OK" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─── PATCH /api/leads/:uuid ───────────────────────────────────────────────────

export async function updateLead(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params;

    // Fetch full current state including status label
    const existingRows = await q<RowDataPacket>(
      `SELECT l.id, l.assigned_to, l.converted,
              l.status_id, st.label AS statusLabel,
              l.priority_id,
              l.source_id, l.company_name, l.email, l.phone,
              l.requirement_description, l.budget_min, l.budget_max,
              l.timeline, l.last_contacted, l.next_followup, l.meeting_datetime
       FROM leads l
       LEFT JOIN lead_meta_options st ON st.id = l.status_id AND st.type = 'status'
       WHERE l.uuid = ?`,
      [uuid],
    );
    if (!existingRows.length) {
      res.status(404).json({ success: false, message: "Lead not found" });
      return;
    }

    const existing          = existingRows[0];
    const leadId            = Number(existing["id"]);
    const currentStatusLabel = existing["statusLabel"] as string | null;
    const isEmployee        = req.user!.role === "EMPLOYEE";

    // Role-based access
    if (isEmployee && Number(existing["assigned_to"]) !== req.user!.id) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    const body = req.body as Record<string, unknown>;

    // ── Converted lead: only contact-info corrections allowed ─────────────────
    if (existing["converted"]) {
      const allowedAfterConversion = new Set(["contactPerson", "companyName", "email", "phone", "whatsapp"]);
      for (const key of Object.keys(body)) {
        if (!allowedAfterConversion.has(key)) {
          res.status(400).json({
            success: false,
            message: "Lead is already converted to a client. Only contact info corrections are allowed.",
          });
          return;
        }
      }
    }

    // ── Terminal state: lock structural fields ────────────────────────────────
    if (currentStatusLabel && TERMINAL_STATUSES.has(currentStatusLabel)) {
      for (const field of Object.keys(body)) {
        if (TERMINAL_LOCKED_FIELDS.has(field)) {
          res.status(400).json({
            success: false,
            message: `Cannot update '${field}' — lead is ${currentStatusLabel} and locked.`,
          });
          return;
        }
      }
    }

    // ── Role restriction: only ADMIN/SUPER_ADMIN can reassign ─────────────────
    if (isEmployee && body["assignedTo"] !== undefined) {
      res.status(403).json({ success: false, message: "Employees cannot change lead assignment" });
      return;
    }

    // ── Status transition validation ──────────────────────────────────────────
    let newStatusLabel: string | null = null;

    if (body["statusId"] !== undefined) {
      const newStatusId = body["statusId"] != null ? Number(body["statusId"]) : null;

      // Cannot clear status once set
      if (newStatusId === null) {
        res.status(400).json({ success: false, message: "Cannot remove status from a lead" });
        return;
      }

      // Target must be a valid status meta option
      const targetRows = await q<RowDataPacket>(
        "SELECT id, label FROM lead_meta_options WHERE id = ? AND type = 'status'", [newStatusId],
      );
      if (!targetRows.length) {
        res.status(400).json({ success: false, message: "Invalid statusId — not a valid status option" });
        return;
      }
      newStatusLabel = String(targetRows[0]["label"]);

      // "Lost" must go through the /mark-lost endpoint (enforces required reason)
      if (newStatusLabel === "Lost") {
        res.status(400).json({
          success: false,
          message: "Use the /mark-lost endpoint to mark a lead as lost — a reason is required.",
        });
        return;
      }

      // Validate the transition is allowed from the current status
      if (currentStatusLabel) {
        const allowed = ALLOWED_TRANSITIONS[currentStatusLabel] ?? [];
        if (!allowed.includes(newStatusLabel)) {
          const canMoveTo = allowed.filter(s => s !== "Lost").join(", ") || "none";
          res.status(400).json({
            success: false,
            message: `Invalid transition: "${currentStatusLabel}" → "${newStatusLabel}". Allowed next: ${canMoveTo}`,
          });
          return;
        }
      }

      // Stage gate: check required fields for the target status
      let servicesCount: number;
      if (Array.isArray(body["services"])) {
        servicesCount = (body["services"] as unknown[]).length;
      } else {
        const svcRow = await q<RowDataPacket>(
          "SELECT COUNT(*) AS cnt FROM lead_services WHERE lead_id = ?", [leadId],
        );
        servicesCount = Number(svcRow[0]?.["cnt"] ?? 0);
      }

      const merged: GateData = {
        companyName:            body["companyName"]            !== undefined ? body["companyName"]            : existing["company_name"],
        email:                  body["email"]                  !== undefined ? body["email"]                  : existing["email"],
        phone:                  body["phone"]                  !== undefined ? body["phone"]                  : existing["phone"],
        sourceId:               body["sourceId"]               !== undefined ? body["sourceId"]               : existing["source_id"],
        assignedTo:             body["assignedTo"]             !== undefined ? body["assignedTo"]             : existing["assigned_to"],
        requirementDescription: body["requirementDescription"] !== undefined ? body["requirementDescription"] : existing["requirement_description"],
        budgetMin:              body["budgetMin"]              !== undefined ? body["budgetMin"]              : existing["budget_min"],
        budgetMax:              body["budgetMax"]              !== undefined ? body["budgetMax"]              : existing["budget_max"],
        timeline:               body["timeline"]               !== undefined ? body["timeline"]               : existing["timeline"],
        nextFollowup:           body["nextFollowup"]           !== undefined ? body["nextFollowup"]           : existing["next_followup"],
        lastContacted:          body["lastContacted"]          !== undefined ? body["lastContacted"]          : existing["last_contacted"],
        servicesCount,
      };

      const gateErr = checkStageGate(newStatusLabel, merged);
      if (gateErr) {
        res.status(400).json({ success: false, message: gateErr });
        return;
      }
    }

    // ── Field format validations ──────────────────────────────────────────────
    const fieldErr = validateLeadFields(body);
    if (fieldErr) {
      res.status(400).json({ success: false, message: fieldErr });
      return;
    }

    // ── contactPerson cannot be cleared on update ─────────────────────────────
    if (body["contactPerson"] !== undefined) {
      const t = String(body["contactPerson"]).trim();
      if (!t || t.length < 2) {
        res.status(400).json({ success: false, message: "contactPerson must be at least 2 characters" });
        return;
      }
    }

    // ── Budget validation — fix cross-validation gap by including DB values ───
    if (body["budgetMin"] !== undefined || body["budgetMax"] !== undefined) {
      const rawMin = body["budgetMin"] !== undefined ? body["budgetMin"] : existing["budget_min"];
      const rawMax = body["budgetMax"] !== undefined ? body["budgetMax"] : existing["budget_max"];
      const budget = validateBudget(rawMin, rawMax);
      if (budget.error) {
        res.status(400).json({ success: false, message: budget.error });
        return;
      }

      // Post-proposal: budget can only increase, never decrease or be cleared
      if (currentStatusLabel && POST_PROPOSAL_STATUSES.has(currentStatusLabel)) {
        const existingMin = existing["budget_min"] != null ? Number(existing["budget_min"]) : null;
        const existingMax = existing["budget_max"] != null ? Number(existing["budget_max"]) : null;

        if (body["budgetMin"] !== undefined) {
          const newMin = parseBudget(body["budgetMin"]);
          if (existingMin !== null && newMin === null) {
            res.status(400).json({ success: false, message: "Cannot remove budget min after a proposal has been sent" });
            return;
          }
          if (existingMin !== null && newMin !== null && newMin < existingMin) {
            res.status(400).json({ success: false, message: "Budget min cannot be reduced after a proposal has been sent" });
            return;
          }
        }

        if (body["budgetMax"] !== undefined) {
          const newMax = parseBudget(body["budgetMax"]);
          if (existingMax !== null && newMax === null) {
            res.status(400).json({ success: false, message: "Cannot remove budget max after a proposal has been sent" });
            return;
          }
          if (existingMax !== null && newMax !== null && newMax < existingMax) {
            res.status(400).json({ success: false, message: "Budget max cannot be reduced after a proposal has been sent" });
            return;
          }
        }
      }
    }

    // ── Build UPDATE sets ─────────────────────────────────────────────────────
    const sets: string[] = [];
    const params: unknown[] = [];
    const s = (col: string, val: unknown) => { sets.push(`${col} = ?`); params.push(val); };

    if (body["contactPerson"]          !== undefined) s("contact_person",           String(body["contactPerson"]).trim());
    if (body["companyName"]            !== undefined) s("company_name",             body["companyName"]);
    if (body["email"]                  !== undefined) s("email",                    body["email"]);
    if (body["phone"]                  !== undefined) s("phone",                    body["phone"]);
    if (body["whatsapp"]               !== undefined) s("whatsapp",                 body["whatsapp"]);
    if (body["industry"]               !== undefined) s("industry",                 body["industry"]);
    if (body["country"]                !== undefined) s("country",                  body["country"]);
    if (body["city"]                   !== undefined) s("city",                     body["city"]);
    if (body["website"]                !== undefined) s("website",                  body["website"]);
    if (body["sourceId"]               !== undefined) s("source_id",   body["sourceId"]   != null ? Number(body["sourceId"])   : null);
    if (body["assignedTo"]             !== undefined) s("assigned_to", body["assignedTo"] != null ? Number(body["assignedTo"]) : null);
    if (body["statusId"]               !== undefined) s("status_id",   body["statusId"]   != null ? Number(body["statusId"])   : null);
    if (body["priorityId"]             !== undefined) s("priority_id", body["priorityId"] != null ? Number(body["priorityId"]) : null);

    if (body["budgetMin"] !== undefined || body["budgetMax"] !== undefined) {
      const rawMin = body["budgetMin"] !== undefined ? body["budgetMin"] : existing["budget_min"];
      const rawMax = body["budgetMax"] !== undefined ? body["budgetMax"] : existing["budget_max"];
      const budget = validateBudget(rawMin, rawMax);           // already validated above; safe to call again
      if (body["budgetMin"] !== undefined) s("budget_min", budget.min);
      if (body["budgetMax"] !== undefined) s("budget_max", budget.max);
    }

    if (body["timeline"]               !== undefined) s("timeline",                body["timeline"]);
    if (body["requirementDescription"] !== undefined) s("requirement_description", body["requirementDescription"]);
    if (body["lastContacted"]          !== undefined) s("last_contacted",          body["lastContacted"]);
    if (body["nextFollowup"]           !== undefined) s("next_followup",           body["nextFollowup"]);
    if (body["meetingDatetime"]        !== undefined) s("meeting_datetime",        body["meetingDatetime"]);
    if (body["lostReason"]             !== undefined) s("lost_reason",             body["lostReason"]);

    // ── Auto-behaviours when advancing to Won ─────────────────────────────────
    if (newStatusLabel === "Won") {
      const doneRows = await q<RowDataPacket>(
        "SELECT id FROM lead_meta_options WHERE type = 'priority' AND label = 'Done' LIMIT 1",
      );
      if (doneRows.length) s("priority_id", Number(doneRows[0]["id"]));
      sets.push("next_followup = NULL");
      sets.push("meeting_datetime = NULL");
    }

    if (sets.length > 0) {
      params.push(leadId);
      await run(`UPDATE leads SET ${sets.join(", ")} WHERE id = ?`, params);
    }

    // ── Sync services ─────────────────────────────────────────────────────────
    if (Array.isArray(body["services"])) {
      await run("DELETE FROM lead_services WHERE lead_id = ?", [leadId]);
      for (const svcId of body["services"] as unknown[]) {
        const n = Number(svcId);
        if (!isNaN(n) && n > 0) {
          await run(
            "INSERT IGNORE INTO lead_services (lead_id, service_id) VALUES (?, ?)",
            [leadId, n],
          );
        }
      }
    }

    const lead = await getFullLead(leadId);
    await logActivity(req.user!.id, "lead.updated", "lead", leadId, undefined, lead ?? undefined, req.ip);
    res.json({ success: true, data: lead, message: "Lead updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─── DELETE /api/leads/:uuid ──────────────────────────────────────────────────

export async function deleteLead(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params;
    const existing = await q<RowDataPacket>(
      "SELECT id, contact_person FROM leads WHERE uuid = ?", [uuid],
    );
    if (!existing.length) {
      res.status(404).json({ success: false, message: "Lead not found" });
      return;
    }
    const leadId = Number(existing[0]["id"]);

    await run("DELETE FROM lead_services WHERE lead_id = ?", [leadId]);
    await run("DELETE FROM leads WHERE id = ?", [leadId]);
    await logActivity(req.user!.id, "lead.deleted", "lead", leadId, { contactPerson: existing[0]["contact_person"] }, undefined, req.ip);

    res.json({ success: true, data: null, message: "Lead deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─── POST /api/leads/:uuid/convert ───────────────────────────────────────────

export async function convertLead(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params;
    const existing = await q<RowDataPacket>(
      `SELECT l.id, l.converted, l.contact_person, l.company_name, l.email, l.phone,
              st.label AS statusLabel
       FROM leads l
       LEFT JOIN lead_meta_options st ON st.id = l.status_id AND st.type = 'status'
       WHERE l.uuid = ?`,
      [uuid],
    );
    if (!existing.length) {
      res.status(404).json({ success: false, message: "Lead not found" });
      return;
    }
    if (existing[0]["converted"]) {
      res.status(409).json({ success: false, message: "Lead is already converted to a client" });
      return;
    }

    // Conversion is only allowed from "Won" status
    const statusLabel = existing[0]["statusLabel"] as string | null;
    if (statusLabel !== "Won") {
      res.status(400).json({
        success: false,
        message: `Lead can only be converted when status is "Won". Current status: "${statusLabel ?? "not set"}"`,
      });
      return;
    }

    const leadId = Number(existing[0]["id"]);
    const lead   = existing[0];
    const body   = req.body as Record<string, string | undefined>;

    const companyName   = (body["companyName"]  || String(lead["company_name"]   || "")).trim() || String(lead["contact_person"]);
    const contactPerson = (body["contactPerson"] || String(lead["contact_person"] || "")).trim();
    const email         = body["email"]  || lead["email"]  || null;
    const phone         = body["phone"]  || lead["phone"]  || null;

    if (!contactPerson) {
      res.status(400).json({ success: false, message: "Contact person is required for client creation" });
      return;
    }

    const clientResult = await run(
      `INSERT INTO clients (company_name, contact_person, email, phone, status, created_by)
       VALUES (?, ?, ?, ?, 'PROSPECT', ?)`,
      [companyName, contactPerson, email, phone, req.user!.id],
    );
    const newClientId = clientResult.insertId;

    const clientRows = await q<RowDataPacket>("SELECT uuid FROM clients WHERE id = ?", [newClientId]);
    const clientUuid = String(clientRows[0]["uuid"]);

    await run("UPDATE leads SET converted = 1, converted_client_id = ? WHERE id = ?", [newClientId, leadId]);
    await logActivity(req.user!.id, "lead.converted", "lead", leadId, undefined, { clientUuid }, req.ip);

    res.json({ success: true, data: { clientUuid }, message: "Lead converted to client" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─── PATCH /api/leads/:uuid/mark-lost ────────────────────────────────────────

export async function markLeadLost(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params;
    const existingRows = await q<RowDataPacket>(
      `SELECT l.id, l.assigned_to, st.label AS statusLabel
       FROM leads l
       LEFT JOIN lead_meta_options st ON st.id = l.status_id AND st.type = 'status'
       WHERE l.uuid = ?`,
      [uuid],
    );
    if (!existingRows.length) {
      res.status(404).json({ success: false, message: "Lead not found" });
      return;
    }

    const existing         = existingRows[0];
    const leadId           = Number(existing["id"]);
    const currentStatus    = existing["statusLabel"] as string | null;
    const isEmployee       = req.user!.role === "EMPLOYEE";

    // Access control
    if (isEmployee && Number(existing["assigned_to"]) !== req.user!.id) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    // Cannot mark a Won lead as lost
    if (currentStatus === "Won") {
      res.status(400).json({ success: false, message: "A Won lead cannot be marked as lost" });
      return;
    }

    // Already lost
    if (currentStatus === "Lost") {
      res.status(400).json({ success: false, message: "Lead is already marked as lost" });
      return;
    }

    // lost_reason is required, minimum 10 characters
    const { reason } = req.body as Record<string, string>;
    if (!reason || !String(reason).trim()) {
      res.status(400).json({ success: false, message: "A reason is required when marking a lead as lost" });
      return;
    }
    if (String(reason).trim().length < 10) {
      res.status(400).json({ success: false, message: "Lost reason must be at least 10 characters" });
      return;
    }

    // Fetch "Lost" status ID
    const lostRows = await q<RowDataPacket>(
      "SELECT id FROM lead_meta_options WHERE type = 'status' AND label = 'Lost' LIMIT 1",
    );
    if (!lostRows.length) {
      res.status(500).json({ success: false, message: "System error: 'Lost' status not configured" });
      return;
    }
    const lostStatusId = Number(lostRows[0]["id"]);

    // Fetch "Cold" priority ID for auto-set
    const coldRows = await q<RowDataPacket>(
      "SELECT id FROM lead_meta_options WHERE type = 'priority' AND label = 'Cold' LIMIT 1",
    );
    const coldPriorityId = coldRows.length ? Number(coldRows[0]["id"]) : null;

    await run(
      `UPDATE leads
       SET status_id = ?, lost_reason = ?, priority_id = ?,
           next_followup = NULL, meeting_datetime = NULL
       WHERE id = ?`,
      [lostStatusId, String(reason).trim(), coldPriorityId, leadId],
    );
    await logActivity(req.user!.id, "lead.lost", "lead", leadId, undefined, { reason }, req.ip);

    const lead = await getFullLead(leadId);
    res.json({ success: true, data: lead, message: "Lead marked as lost" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─── GET /api/leads/export/csv ────────────────────────────────────────────────

export async function exportLeadsCsv(req: Request, res: Response): Promise<void> {
  try {
    const { where, params } = buildFilters(req.query as Record<string, string | undefined>);
    const rows = await q<RowDataPacket>(
      `SELECT ${LEAD_SEL} ${LEAD_FROM} ${where} ORDER BY l.created_at DESC`, params,
    );
    const leadIds = rows.map(r => Number(r["id"]));
    const svcMap  = await fetchServicesForLeads(leadIds);

    const csvEsc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

    const header = [
      "Contact Person", "Company", "Email", "Phone",
      "Source", "Status", "Priority", "Services",
      "Budget Min", "Budget Max", "Timeline",
      "Assigned To", "Created At",
    ].join(",");

    const lines = rows.map(r => {
      const l    = rowToLead(r);
      const svcs = (svcMap.get(l.id) ?? []).map(s => s.label).join("; ");
      return [
        csvEsc(l.contactPerson), csvEsc(l.companyName), csvEsc(l.email), csvEsc(l.phone),
        csvEsc(l.source?.label), csvEsc(l.status?.label), csvEsc(l.priority?.label), csvEsc(svcs),
        l.budgetMin ?? "", l.budgetMax ?? "", l.timeline ?? "",
        csvEsc(l.assignedUser?.name), l.createdAt,
      ].join(",");
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="leads-${Date.now()}.csv"`);
    res.send([header, ...lines].join("\n"));
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─── GET /api/leads/stats/summary ─────────────────────────────────────────────

export async function statsLeads(_req: Request, res: Response): Promise<void> {
  try {
    const [
      [totalRow], byStatusRows, byPriorityRows, bySourceRows,
      [convertedRow], [lostRow], [followupRow], [meetingRow],
    ] = await Promise.all([
      q<RowDataPacket>("SELECT COUNT(*) AS total FROM leads"),
      q<RowDataPacket>(
        `SELECT m.label, m.color, COUNT(l.id) AS count
         FROM lead_meta_options m LEFT JOIN leads l ON l.status_id = m.id
         WHERE m.type = 'status' GROUP BY m.id, m.label, m.color ORDER BY m.sort_order`,
      ),
      q<RowDataPacket>(
        `SELECT m.label, m.color, COUNT(l.id) AS count
         FROM lead_meta_options m LEFT JOIN leads l ON l.priority_id = m.id
         WHERE m.type = 'priority' GROUP BY m.id, m.label, m.color ORDER BY m.sort_order`,
      ),
      q<RowDataPacket>(
        `SELECT m.label, m.color, COUNT(l.id) AS count
         FROM lead_meta_options m LEFT JOIN leads l ON l.source_id = m.id
         WHERE m.type = 'source' GROUP BY m.id, m.label, m.color ORDER BY m.sort_order`,
      ),
      q<RowDataPacket>("SELECT COUNT(*) AS total FROM leads WHERE converted = 1"),
      q<RowDataPacket>(
        `SELECT COUNT(*) AS total FROM leads l
         JOIN lead_meta_options m ON m.id = l.status_id AND m.type = 'status' AND m.label = 'Lost'`,
      ),
      q<RowDataPacket>("SELECT COUNT(*) AS total FROM leads WHERE next_followup = CURDATE()"),
      q<RowDataPacket>("SELECT COUNT(*) AS total FROM leads WHERE DATE(meeting_datetime) = CURDATE()"),
    ]);

    res.json({
      success: true,
      data: {
        total:          Number(totalRow?.["total"]     ?? 0),
        convertedCount: Number(convertedRow?.["total"] ?? 0),
        lostCount:      Number(lostRow?.["total"]      ?? 0),
        followupToday:  Number(followupRow?.["total"]  ?? 0),
        meetingsToday:  Number(meetingRow?.["total"]   ?? 0),
        byStatus:   byStatusRows.map(r   => ({ label: String(r["label"]), color: String(r["color"]), count: Number(r["count"]) })),
        byPriority: byPriorityRows.map(r => ({ label: String(r["label"]), color: String(r["color"]), count: Number(r["count"]) })),
        bySource:   bySourceRows.map(r   => ({ label: String(r["label"]), color: String(r["color"]), count: Number(r["count"]) })),
      },
      message: "OK",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─── POST /api/leads/import/csv ────────────────────────────────────────────────

export async function importLeadsCsv(req: Request, res: Response): Promise<void> {
  try {
    const csvText: string = req.body as string;
    if (!csvText || typeof csvText !== "string") {
      res.status(400).json({ success: false, message: "CSV body required" });
      return;
    }

    const lines = csvText.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) {
      res.status(400).json({ success: false, message: "No data rows found" });
      return;
    }

    const header = lines[0].split(",").map(h => h.replace(/^"|"$/g, "").replace(/^﻿/, "").trim().toLowerCase());
    const col = (row: string[], name: string): string => {
      const idx = header.indexOf(name);
      return idx >= 0 ? (row[idx] ?? "").replace(/^"|"$/g, "").trim() : "";
    };

    // Fetch meta options for matching
    const [statuses, priorities, sources, newStatusRows] = await Promise.all([
      q<RowDataPacket>("SELECT id, label FROM lead_meta_options WHERE type='status'"),
      q<RowDataPacket>("SELECT id, label FROM lead_meta_options WHERE type='priority'"),
      q<RowDataPacket>("SELECT id, label FROM lead_meta_options WHERE type='source'"),
      q<RowDataPacket>("SELECT id FROM lead_meta_options WHERE type='status' AND label='New' LIMIT 1"),
    ]);

    if (!newStatusRows.length) {
      res.status(500).json({ success: false, message: "System error: 'New' status not configured" });
      return;
    }
    const newStatusId = Number(newStatusRows[0]["id"]);

    const findMeta = (rows: RowDataPacket[], label: string): number | null => {
      if (!label) return null;
      const m = rows.find(r => String(r["label"]).toLowerCase() === label.toLowerCase());
      return m ? Number(m["id"]) : null;
    };

    let imported = 0;
    const errors: string[] = [];

    for (let i = 1; i < lines.length; i++) {
      const row           = lines[i].split(",");
      const contactPerson = col(row, "contact person") || col(row, "contactperson");
      if (!contactPerson) { errors.push(`Row ${i + 1}: contact person missing`); continue; }
      if (contactPerson.length < 2) { errors.push(`Row ${i + 1}: contact person must be at least 2 characters`); continue; }

      // Budget must be numeric if provided
      const rawBudgetMin = col(row, "budget min") || col(row, "budgetmin") || null;
      const rawBudgetMax = col(row, "budget max") || col(row, "budgetmax") || null;
      if (rawBudgetMin && isNaN(Number(rawBudgetMin))) { errors.push(`Row ${i + 1}: budget min must be a number`); continue; }
      if (rawBudgetMax && isNaN(Number(rawBudgetMax))) { errors.push(`Row ${i + 1}: budget max must be a number`); continue; }

      // Date validation
      const timelineVal      = col(row, "timeline") || null;
      const lastContactedVal = col(row, "last contacted") || null;
      const nextFollowupVal  = col(row, "next followup") || null;

      if (timelineVal && !isTodayOrFutureDate(timelineVal))      { errors.push(`Row ${i + 1}: timeline must be today or a future date`); continue; }
      if (lastContactedVal && !isTodayOrPastDate(lastContactedVal)) { errors.push(`Row ${i + 1}: last contacted cannot be a future date`); continue; }
      if (nextFollowupVal && !isTodayOrFutureDate(nextFollowupVal)) { errors.push(`Row ${i + 1}: next follow-up must be today or a future date`); continue; }

      try {
        const result = await run(
          `INSERT INTO leads
             (contact_person, company_name, email, phone, whatsapp, industry, country, city, website,
              source_id, status_id, priority_id, budget_min, budget_max, timeline,
              requirement_description, last_contacted, next_followup, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            contactPerson,
            col(row, "company") || col(row, "company name") || null,
            col(row, "email")    || null,
            col(row, "phone")    || null,
            col(row, "whatsapp") || null,
            col(row, "industry") || null,
            col(row, "country")  || null,
            col(row, "city")     || null,
            col(row, "website")  || null,
            findMeta(sources,    col(row, "source")),
            newStatusId,   // all imports start at "New"
            findMeta(priorities, col(row, "priority")),
            rawBudgetMin ? Math.floor(Number(rawBudgetMin)) : null,
            rawBudgetMax ? Math.floor(Number(rawBudgetMax)) : null,
            timelineVal,
            col(row, "requirement") || col(row, "notes") || null,
            lastContactedVal,
            nextFollowupVal,
            req.user!.id,
          ],
        );

        const svcLabels = col(row, "services").split(";").map(s => s.trim()).filter(Boolean);
        if (svcLabels.length) {
          const svcRows = await q<RowDataPacket>(
            `SELECT id FROM lead_meta_options WHERE type='service' AND label IN (${svcLabels.map(() => "?").join(",")})`,
            svcLabels,
          );
          for (const svcRow of svcRows) {
            await run("INSERT IGNORE INTO lead_services (lead_id, service_id) VALUES (?, ?)",
              [result.insertId, Number(svcRow["id"])]);
          }
        }

        imported++;
      } catch (e) {
        errors.push(`Row ${i + 1}: ${(e as Error).message}`);
      }
    }

    res.json({ success: true, data: { imported, errors }, message: `${imported} leads imported` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}
