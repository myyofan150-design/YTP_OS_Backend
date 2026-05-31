// src/controllers/leads.controller.ts
import { Request, Response } from "express";
import { q, run, RowDataPacket } from "../lib/db";
import { logActivity } from "../lib/logger";
import type { LeadWithRelations, LeadMetaOption, AssignedUser } from "../types/lead.types";

// ─── SQL Fragments ────────────────────────────────────────────────────────────

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
    id: unknown, uuid: unknown, label: unknown, color: unknown, sortOrder: unknown
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
    budgetMin:              r["budget_min"]               != null ? Number(r["budget_min"])               : null,
    budgetMax:              r["budget_max"]               != null ? Number(r["budget_max"])               : null,
    timeline:               r["timeline"]                != null ? String(r["timeline"]).slice(0, 10)   : null,
    requirementDescription: r["requirement_description"] != null ? String(r["requirement_description"]) : null,
    lastContacted:          r["last_contacted"]          != null ? String(r["last_contacted"]).slice(0, 10) : null,
    nextFollowup:           r["next_followup"]           != null ? String(r["next_followup"]).slice(0, 10)  : null,
    meetingDatetime:        r["meeting_datetime"]        != null ? String(r["meeting_datetime"])        : null,
    converted:              Boolean(r["converted"]),
    convertedClientId:   r["converted_client_id"]  != null ? Number(r["converted_client_id"])   : null,
    convertedClientUuid: r["convertedClientUuid"]  != null ? String(r["convertedClientUuid"])  : null,
    lostReason:          r["lost_reason"]           != null ? String(r["lost_reason"])           : null,
    createdBy:           Number(r["created_by"]),
    createdAt:           String(r["created_at"]),
    updatedAt:           String(r["updated_at"]),
    source:   toMeta("source",   r["source_id"],   r["srcUuid"], r["srcLabel"], r["srcColor"], r["srcSortOrder"]),
    status:   toMeta("status",   r["status_id"],   r["stUuid"],  r["stLabel"],  r["stColor"],  r["stSortOrder"]),
    priority: toMeta("priority", r["priority_id"], r["prUuid"],  r["prLabel"],  r["prColor"],  r["prSortOrder"]),
    assignedUser: toUser(),
  };
}

async function fetchServicesForLeads(leadIds: number[]): Promise<Map<number, LeadMetaOption[]>> {
  if (!leadIds.length) return new Map();
  const ph = leadIds.map(() => "?").join(",");
  const rows = await q<RowDataPacket>(
    `SELECT ls.lead_id, m.id, m.uuid, m.label, m.color, m.sort_order
     FROM lead_services ls
     JOIN lead_meta_options m ON m.id = ls.service_id AND m.type = 'service'
     WHERE ls.lead_id IN (${ph})
     ORDER BY m.sort_order, m.label`,
    leadIds
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
  const rows = await q<RowDataPacket>(
    `SELECT ${LEAD_SEL} ${LEAD_FROM} WHERE l.id = ?`, [leadId]
  );
  if (!rows.length) return null;
  const lead   = rowToLead(rows[0]);
  const svcMap = await fetchServicesForLeads([leadId]);
  return { ...lead, services: svcMap.get(leadId) ?? [] };
}

function buildFilters(
  query: Record<string, string | undefined>,
  restrictToUserId?: number
): { where: string; params: unknown[] } {
  let where = "WHERE 1=1";
  const params: unknown[] = [];

  if (restrictToUserId != null) { where += " AND l.assigned_to = ?"; params.push(restrictToUserId); }

  const { search, statusId, priorityId, sourceId, assignedTo, converted, serviceId, followup } = query;
  if (search)     { where += " AND (l.contact_person LIKE ? OR l.company_name LIKE ? OR l.email LIKE ?)"; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (statusId)   { where += " AND l.status_id = ?";   params.push(Number(statusId)); }
  if (priorityId) { where += " AND l.priority_id = ?"; params.push(Number(priorityId)); }
  if (sourceId)   { where += " AND l.source_id = ?";   params.push(Number(sourceId)); }
  if (assignedTo  && restrictToUserId == null) { where += " AND l.assigned_to = ?"; params.push(Number(assignedTo)); }
  if (converted !== undefined)                 { where += " AND l.converted = ?";   params.push(converted === "1" ? 1 : 0); }
  if (serviceId)  { where += " AND EXISTS (SELECT 1 FROM lead_services ls WHERE ls.lead_id = l.id AND ls.service_id = ?)"; params.push(Number(serviceId)); }
  if (followup === "today") {
    where += " AND DATE(l.next_followup) = CURDATE()";
  } else if (followup === "overdue") {
    where += " AND l.next_followup IS NOT NULL AND DATE(l.next_followup) < CURDATE()";
  } else if (followup === "week") {
    where += " AND l.next_followup IS NOT NULL AND DATE(l.next_followup) BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)";
  }

  return { where, params };
}

// ─── GET /api/leads ───────────────────────────────────────────────────────────

export async function listLeads(req: Request, res: Response): Promise<void> {
  try {
    const page   = Math.max(1,   parseInt((req.query["page"]  as string) || "1",  10));
    const limit  = Math.min(100, parseInt((req.query["limit"] as string) || "20", 10));
    const offset = (page - 1) * limit;

    const isEmployee = req.user!.role === "EMPLOYEE";
    const { where, params } = buildFilters(
      req.query as Record<string, string | undefined>,
      isEmployee ? req.user!.id : undefined
    );

    const [[countRow], rows] = await Promise.all([
      q<RowDataPacket>(`SELECT COUNT(*) AS total ${LEAD_FROM} ${where}`, params),
      q<RowDataPacket>(
        `SELECT ${LEAD_SEL} ${LEAD_FROM} ${where} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
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
    const {
      contactPerson, companyName, email, phone, whatsapp, industry, country, city, website,
      sourceId, assignedTo, statusId, priorityId, budgetMin, budgetMax, timeline,
      requirementDescription, lastContacted, nextFollowup, meetingDatetime, services,
    } = req.body as Record<string, unknown>;

    if (!contactPerson || !String(contactPerson).trim()) {
      res.status(400).json({ success: false, message: "contactPerson is required" });
      return;
    }

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
        statusId   != null ? Number(statusId)   : null,
        priorityId != null ? Number(priorityId) : null,
        budgetMin  != null ? Number(budgetMin)  : null,
        budgetMax  != null ? Number(budgetMax)  : null,
        timeline               ?? null,
        requirementDescription ?? null,
        lastContacted          ?? null,
        nextFollowup           ?? null,
        meetingDatetime        ?? null,
        req.user!.id,
      ]
    );
    const leadId = result.insertId;

    if (Array.isArray(services) && services.length > 0) {
      for (const svcId of services) {
        await run(
          "INSERT IGNORE INTO lead_services (lead_id, service_id) VALUES (?, ?)",
          [leadId, Number(svcId)]
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
    const rows = await q<RowDataPacket>(
      `SELECT ${LEAD_SEL} ${LEAD_FROM} WHERE l.uuid = ?`, [uuid]
    );
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
    const existing = await q<RowDataPacket>(
      "SELECT id, assigned_to FROM leads WHERE uuid = ?", [uuid]
    );
    if (!existing.length) {
      res.status(404).json({ success: false, message: "Lead not found" });
      return;
    }
    const leadId     = Number(existing[0]["id"]);
    const isEmployee = req.user!.role === "EMPLOYEE";
    if (isEmployee && Number(existing[0]["assigned_to"]) !== req.user!.id) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    const {
      contactPerson, companyName, email, phone, whatsapp, industry, country, city, website,
      sourceId, assignedTo, statusId, priorityId, budgetMin, budgetMax, timeline,
      requirementDescription, lastContacted, nextFollowup, meetingDatetime, lostReason,
      services,
    } = req.body as Record<string, unknown>;

    const sets: string[] = [];
    const params: unknown[] = [];
    const s = (col: string, val: unknown) => { sets.push(`${col} = ?`); params.push(val); };

    if (contactPerson          !== undefined) s("contact_person",           String(contactPerson).trim());
    if (companyName            !== undefined) s("company_name",             companyName);
    if (email                  !== undefined) s("email",                    email);
    if (phone                  !== undefined) s("phone",                    phone);
    if (whatsapp               !== undefined) s("whatsapp",                 whatsapp);
    if (industry               !== undefined) s("industry",                 industry);
    if (country                !== undefined) s("country",                  country);
    if (city                   !== undefined) s("city",                     city);
    if (website                !== undefined) s("website",                  website);
    if (sourceId               !== undefined) s("source_id",                sourceId   != null ? Number(sourceId)   : null);
    if (assignedTo             !== undefined) s("assigned_to",              assignedTo != null ? Number(assignedTo) : null);
    if (statusId               !== undefined) s("status_id",                statusId   != null ? Number(statusId)   : null);
    if (priorityId             !== undefined) s("priority_id",              priorityId != null ? Number(priorityId) : null);
    if (budgetMin              !== undefined) s("budget_min",               budgetMin  != null ? Number(budgetMin)  : null);
    if (budgetMax              !== undefined) s("budget_max",               budgetMax  != null ? Number(budgetMax)  : null);
    if (timeline               !== undefined) s("timeline",                 timeline);
    if (requirementDescription !== undefined) s("requirement_description",  requirementDescription);
    if (lastContacted          !== undefined) s("last_contacted",           lastContacted);
    if (nextFollowup           !== undefined) s("next_followup",            nextFollowup);
    if (meetingDatetime        !== undefined) s("meeting_datetime",         meetingDatetime);
    if (lostReason             !== undefined) s("lost_reason",              lostReason);

    if (sets.length > 0) {
      params.push(leadId);
      await run(`UPDATE leads SET ${sets.join(", ")} WHERE id = ?`, params);
    }

    if (Array.isArray(services)) {
      await run("DELETE FROM lead_services WHERE lead_id = ?", [leadId]);
      for (const svcId of services) {
        await run(
          "INSERT IGNORE INTO lead_services (lead_id, service_id) VALUES (?, ?)",
          [leadId, Number(svcId)]
        );
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
      "SELECT id, contact_person FROM leads WHERE uuid = ?", [uuid]
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
      "SELECT id, converted, contact_person, company_name, email, phone FROM leads WHERE uuid = ?",
      [uuid]
    );
    if (!existing.length) {
      res.status(404).json({ success: false, message: "Lead not found" });
      return;
    }
    if (existing[0]["converted"]) {
      res.status(409).json({ success: false, message: "Lead already converted" });
      return;
    }

    const leadId = Number(existing[0]["id"]);
    const lead   = existing[0];
    const body   = req.body as Record<string, string | undefined>;

    const companyName   = (body["companyName"]   || String(lead["company_name"]  || "")).trim() || String(lead["contact_person"]);
    const contactPerson = (body["contactPerson"]  || String(lead["contact_person"] || "")).trim();
    const email         = body["email"]   || lead["email"]  || null;
    const phone         = body["phone"]   || lead["phone"]  || null;

    const clientResult = await run(
      `INSERT INTO clients (company_name, contact_person, email, phone, status, created_by)
       VALUES (?, ?, ?, ?, 'PROSPECT', ?)`,
      [companyName, contactPerson, email, phone, req.user!.id]
    );
    const newClientId = clientResult.insertId;

    const clientRows = await q<RowDataPacket>(
      "SELECT uuid FROM clients WHERE id = ?", [newClientId]
    );
    const clientUuid = String(clientRows[0]["uuid"]);

    await run(
      "UPDATE leads SET converted = 1, converted_client_id = ? WHERE id = ?",
      [newClientId, leadId]
    );
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
    const existing = await q<RowDataPacket>(
      "SELECT id, assigned_to FROM leads WHERE uuid = ?", [uuid]
    );
    if (!existing.length) {
      res.status(404).json({ success: false, message: "Lead not found" });
      return;
    }

    const leadId     = Number(existing[0]["id"]);
    const isEmployee = req.user!.role === "EMPLOYEE";
    if (isEmployee && Number(existing[0]["assigned_to"]) !== req.user!.id) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    const { reason } = req.body as Record<string, string>;

    const lostRows = await q<RowDataPacket>(
      "SELECT id FROM lead_meta_options WHERE type = 'status' AND label = 'Lost' LIMIT 1"
    );
    const lostStatusId = lostRows.length ? Number(lostRows[0]["id"]) : null;

    await run(
      "UPDATE leads SET status_id = ?, lost_reason = ? WHERE id = ?",
      [lostStatusId, reason ?? null, leadId]
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
      `SELECT ${LEAD_SEL} ${LEAD_FROM} ${where} ORDER BY l.created_at DESC`, params
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
        csvEsc(l.contactPerson),
        csvEsc(l.companyName),
        csvEsc(l.email),
        csvEsc(l.phone),
        csvEsc(l.source?.label),
        csvEsc(l.status?.label),
        csvEsc(l.priority?.label),
        csvEsc(svcs),
        l.budgetMin ?? "",
        l.budgetMax ?? "",
        l.timeline  ?? "",
        csvEsc(l.assignedUser?.name),
        l.createdAt,
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
      [totalRow],
      byStatusRows,
      byPriorityRows,
      bySourceRows,
      [convertedRow],
      [lostRow],
      [followupRow],
      [meetingRow],
    ] = await Promise.all([
      q<RowDataPacket>("SELECT COUNT(*) AS total FROM leads"),
      q<RowDataPacket>(
        `SELECT m.label, m.color, COUNT(l.id) AS count
         FROM lead_meta_options m
         LEFT JOIN leads l ON l.status_id = m.id
         WHERE m.type = 'status'
         GROUP BY m.id, m.label, m.color ORDER BY m.sort_order`
      ),
      q<RowDataPacket>(
        `SELECT m.label, m.color, COUNT(l.id) AS count
         FROM lead_meta_options m
         LEFT JOIN leads l ON l.priority_id = m.id
         WHERE m.type = 'priority'
         GROUP BY m.id, m.label, m.color ORDER BY m.sort_order`
      ),
      q<RowDataPacket>(
        `SELECT m.label, m.color, COUNT(l.id) AS count
         FROM lead_meta_options m
         LEFT JOIN leads l ON l.source_id = m.id
         WHERE m.type = 'source'
         GROUP BY m.id, m.label, m.color ORDER BY m.sort_order`
      ),
      q<RowDataPacket>("SELECT COUNT(*) AS total FROM leads WHERE converted = 1"),
      q<RowDataPacket>(
        `SELECT COUNT(*) AS total FROM leads l
         JOIN lead_meta_options m ON m.id = l.status_id AND m.type = 'status' AND m.label = 'Lost'`
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

    // Parse CSV header (first line)
    const header = lines[0].split(",").map(h => h.replace(/^"|"$/g, "").trim().toLowerCase());
    const col = (row: string[], name: string): string => {
      const idx = header.indexOf(name);
      return idx >= 0 ? (row[idx] ?? "").replace(/^"|"$/g, "").trim() : "";
    };

    // Fetch meta options for matching
    const [statuses, priorities, sources] = await Promise.all([
      q<RowDataPacket>("SELECT id, label FROM lead_meta_options WHERE type='status'"),
      q<RowDataPacket>("SELECT id, label FROM lead_meta_options WHERE type='priority'"),
      q<RowDataPacket>("SELECT id, label FROM lead_meta_options WHERE type='source'"),
    ]);

    const findMeta = (rows: RowDataPacket[], label: string): number | null => {
      if (!label) return null;
      const m = rows.find(r => String(r["label"]).toLowerCase() === label.toLowerCase());
      return m ? Number(m["id"]) : null;
    };

    let imported = 0;
    const errors: string[] = [];

    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(",");
      const contactPerson = col(row, "contact person") || col(row, "contactperson");
      if (!contactPerson) { errors.push(`Row ${i + 1}: contact person missing`); continue; }

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
            col(row, "email")   || null,
            col(row, "phone")   || null,
            col(row, "whatsapp") || null,
            col(row, "industry") || null,
            col(row, "country")  || null,
            col(row, "city")     || null,
            col(row, "website")  || null,
            findMeta(sources,    col(row, "source")),
            findMeta(statuses,   col(row, "status")),
            findMeta(priorities, col(row, "priority")),
            col(row, "budget min") || col(row, "budgetmin") || null,
            col(row, "budget max") || col(row, "budgetmax") || null,
            col(row, "timeline")   || null,
            col(row, "requirement") || col(row, "notes") || null,
            col(row, "last contacted") || null,
            col(row, "next followup")  || null,
            req.user!.id,
          ]
        );

        // Handle services column: semicolon-separated service labels
        const svcLabels = col(row, "services").split(";").map(s => s.trim()).filter(Boolean);
        if (svcLabels.length) {
          const svcRows = await q<RowDataPacket>(
            `SELECT id FROM lead_meta_options WHERE type='service' AND label IN (${svcLabels.map(() => "?").join(",")})`,
            svcLabels
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
