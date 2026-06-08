// src/controllers/subscriptions.controller.ts
import { Request, Response } from "express";
import { q, run, RowDataPacket } from "../lib/db";
import { encrypt, decrypt } from "../lib/encryption";
import { logActivity } from "../lib/logger";
import { rowToSubscription } from "../lib/subscription-db";
import { runExpiryCheck } from "../jobs/subscription-expiry.job";
import { uploadFile } from "../lib/storage";

// ─── Shared SQL fragments ─────────────────────────────────────────────────────

const SUB_SEL = `
  s.id, s.uuid, s.name,
  s.logo_url         AS logoUrl,
  s.link,
  s.username,
  s.start_date       AS startDate,
  s.end_date         AS endDate,
  s.category_id      AS categoryId,
  s.billing_cycle_id AS billingCycleId,
  s.status_id        AS statusId,
  s.price, s.next_renewal_amount AS nextRenewalAmount, s.currency, s.autopay, s.plan_tier AS planTier, s.usage_type AS usageType, s.remarks,
  s.created_by       AS createdBy,
  s.created_at       AS createdAt,
  cat.uuid           AS catUuid,
  cat.label          AS catLabel,
  cat.color          AS catColor,
  cat.sort_order     AS catSortOrder,
  bc.uuid            AS bcUuid,
  bc.label           AS bcLabel,
  bc.color           AS bcColor,
  bc.sort_order      AS bcSortOrder,
  st.uuid            AS stUuid,
  st.label           AS stLabel,
  st.color           AS stColor,
  st.sort_order      AS stSortOrder`;

const SUB_FROM = `
  FROM subscriptions s
  LEFT JOIN subscription_meta_options cat ON cat.id = s.category_id
  LEFT JOIN subscription_meta_options bc  ON bc.id  = s.billing_cycle_id
  LEFT JOIN subscription_meta_options st  ON st.id  = s.status_id`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function validateMetaId(id: number, type: string): Promise<boolean> {
  const rows = await q<RowDataPacket>(
    "SELECT id FROM subscription_meta_options WHERE id = ? AND type = ?",
    [id, type]
  );
  return rows.length > 0;
}

function buildFilters(query: Record<string, string | undefined>): { where: string; params: unknown[] } {
  let where = "WHERE 1=1";
  const params: unknown[] = [];
  const { search, categoryId, statusId, billingCycleId, autopay, planTier, usageType } = query;
  if (search)         { where += " AND s.name LIKE ?";           params.push(`%${search}%`); }
  if (categoryId)     { where += " AND s.category_id = ?";       params.push(Number(categoryId)); }
  if (statusId)       { where += " AND s.status_id = ?";         params.push(Number(statusId)); }
  if (billingCycleId) { where += " AND s.billing_cycle_id = ?";  params.push(Number(billingCycleId)); }
  if (autopay !== undefined) { where += " AND s.autopay = ?";    params.push(autopay === "true" ? 1 : 0); }
  if (planTier)       { where += " AND s.plan_tier = ?";         params.push(planTier); }
  if (usageType)      { where += " AND s.usage_type = ?";        params.push(usageType); }
  return { where, params };
}

// ─── GET /api/subscriptions ───────────────────────────────────────────────────

export async function listSubscriptions(req: Request, res: Response): Promise<void> {
  try {
    const page  = Math.max(1,   parseInt((req.query["page"]  as string) || "1",  10));
    const limit = Math.min(100, parseInt((req.query["limit"] as string) || "15", 10));
    const offset = (page - 1) * limit;

    const { where, params } = buildFilters(req.query as Record<string, string | undefined>);

    const countRows = await q<RowDataPacket>(
      `SELECT COUNT(*) AS total ${SUB_FROM} ${where}`,
      params
    );
    const total = Number(countRows[0]?.["total"] ?? 0);

    const rows = await q<RowDataPacket>(
      `SELECT ${SUB_SEL} ${SUB_FROM} ${where}
       ORDER BY DATEDIFF(s.end_date, CURDATE()) ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const subscriptions = rows.map(rowToSubscription);
    res.json({ success: true, data: { subscriptions, total, page, limit }, message: "OK" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─── POST /api/subscriptions ──────────────────────────────────────────────────

export async function createSubscription(req: Request, res: Response): Promise<void> {
  try {
    const {
      name, logoUrl, link, username, password,
      startDate, endDate,
      categoryId, billingCycleId, statusId,
      price, nextRenewalAmount, currency, autopay, planTier, usageType, remarks,
    } = req.body as Record<string, unknown>;

    if (!name || !startDate || !endDate) {
      res.status(400).json({ success: false, message: "name, startDate, and endDate are required" });
      return;
    }
    if (categoryId != null && !(await validateMetaId(Number(categoryId), "category"))) {
      res.status(400).json({ success: false, message: "Invalid categoryId" });
      return;
    }
    if (billingCycleId != null && !(await validateMetaId(Number(billingCycleId), "billing_cycle"))) {
      res.status(400).json({ success: false, message: "Invalid billingCycleId" });
      return;
    }
    if (statusId != null && !(await validateMetaId(Number(statusId), "status"))) {
      res.status(400).json({ success: false, message: "Invalid statusId" });
      return;
    }

    const passwordEncrypted = password ? encrypt(String(password)) : null;

    const result = await run(
      `INSERT INTO subscriptions
         (name, logo_url, link, username, password_encrypted,
          start_date, end_date, category_id, billing_cycle_id, status_id,
          price, next_renewal_amount, currency, autopay, plan_tier, usage_type, remarks, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        logoUrl  ?? null,
        link     ?? null,
        username ?? null,
        passwordEncrypted,
        startDate,
        endDate,
        categoryId     != null ? Number(categoryId)     : null,
        billingCycleId != null ? Number(billingCycleId) : null,
        statusId       != null ? Number(statusId)       : null,
        price             != null ? Number(price)             : null,
        nextRenewalAmount != null ? Number(nextRenewalAmount) : null,
        currency ?? "INR",
        autopay ? 1 : 0,
        planTier  ?? null,
        usageType ?? null,
        remarks ?? null,
        req.user!.id,
      ]
    );

    const rows = await q<RowDataPacket>(
      `SELECT ${SUB_SEL} ${SUB_FROM} WHERE s.id = ?`,
      [result.insertId]
    );
    const sub = rowToSubscription(rows[0]);

    await logActivity(req.user!.id, "subscription.created", "subscription", result.insertId, undefined, sub, req.ip);

    res.status(201).json({ success: true, data: sub, message: "Subscription created" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─── GET /api/subscriptions/:uuid ────────────────────────────────────────────

export async function getSubscription(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params;
    const rows = await q<RowDataPacket>(
      `SELECT ${SUB_SEL}, s.password_encrypted AS passwordEncrypted ${SUB_FROM} WHERE s.uuid = ?`,
      [uuid]
    );
    if (!rows.length) {
      res.status(404).json({ success: false, message: "Subscription not found" });
      return;
    }
    const sub = rowToSubscription(rows[0]);
    const rawPw = rows[0]["passwordEncrypted"];
    const password = rawPw ? decrypt(String(rawPw)) : null;

    res.json({ success: true, data: { ...sub, password }, message: "OK" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─── PATCH /api/subscriptions/:uuid ──────────────────────────────────────────

export async function updateSubscription(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params;
    const existing = await q<RowDataPacket>(
      "SELECT id FROM subscriptions WHERE uuid = ?", [uuid]
    );
    if (!existing.length) {
      res.status(404).json({ success: false, message: "Subscription not found" });
      return;
    }
    const subId = Number(existing[0]["id"]);

    const {
      name, logoUrl, link, username, password,
      startDate, endDate,
      categoryId, billingCycleId, statusId,
      price, nextRenewalAmount, currency, autopay, planTier, usageType, remarks,
    } = req.body as Record<string, unknown>;

    if (categoryId != null && !(await validateMetaId(Number(categoryId), "category"))) {
      res.status(400).json({ success: false, message: "Invalid categoryId" });
      return;
    }
    if (billingCycleId != null && !(await validateMetaId(Number(billingCycleId), "billing_cycle"))) {
      res.status(400).json({ success: false, message: "Invalid billingCycleId" });
      return;
    }
    if (statusId != null && !(await validateMetaId(Number(statusId), "status"))) {
      res.status(400).json({ success: false, message: "Invalid statusId" });
      return;
    }

    const sets: string[] = [];
    const params: unknown[] = [];

    if (name          !== undefined) { sets.push("name = ?");               params.push(name); }
    if (logoUrl       !== undefined) { sets.push("logo_url = ?");            params.push(logoUrl); }
    if (link          !== undefined) { sets.push("link = ?");                params.push(link); }
    if (username      !== undefined) { sets.push("username = ?");            params.push(username); }
    if (password      !== undefined) { sets.push("password_encrypted = ?");  params.push(password ? encrypt(String(password)) : null); }
    if (startDate     !== undefined) { sets.push("start_date = ?");          params.push(startDate); }
    if (endDate       !== undefined) { sets.push("end_date = ?");            params.push(endDate); }
    if (categoryId    !== undefined) { sets.push("category_id = ?");         params.push(categoryId != null ? Number(categoryId) : null); }
    if (billingCycleId !== undefined){ sets.push("billing_cycle_id = ?");    params.push(billingCycleId != null ? Number(billingCycleId) : null); }
    if (statusId      !== undefined) { sets.push("status_id = ?");           params.push(statusId != null ? Number(statusId) : null); }
    if (price             !== undefined) { sets.push("price = ?");                params.push(price != null ? Number(price) : null); }
    if (nextRenewalAmount !== undefined) { sets.push("next_renewal_amount = ?"); params.push(nextRenewalAmount != null ? Number(nextRenewalAmount) : null); }
    if (currency      !== undefined) { sets.push("currency = ?");            params.push(currency); }
    if (autopay       !== undefined) { sets.push("autopay = ?");             params.push(autopay ? 1 : 0); }
    if (planTier      !== undefined) { sets.push("plan_tier = ?");           params.push(planTier ?? null); }
    if (usageType     !== undefined) { sets.push("usage_type = ?");          params.push(usageType ?? null); }
    if (remarks       !== undefined) { sets.push("remarks = ?");             params.push(remarks); }

    if (!sets.length) {
      res.status(400).json({ success: false, message: "Nothing to update" });
      return;
    }

    params.push(subId);
    await run(`UPDATE subscriptions SET ${sets.join(", ")} WHERE id = ?`, params);

    const rows = await q<RowDataPacket>(
      `SELECT ${SUB_SEL} ${SUB_FROM} WHERE s.id = ?`, [subId]
    );
    const sub = rowToSubscription(rows[0]);

    await logActivity(req.user!.id, "subscription.updated", "subscription", subId, undefined, sub, req.ip);

    res.json({ success: true, data: sub, message: "Subscription updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─── DELETE /api/subscriptions/:uuid ─────────────────────────────────────────

export async function deleteSubscription(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params;
    const existing = await q<RowDataPacket>(
      "SELECT id, name FROM subscriptions WHERE uuid = ?", [uuid]
    );
    if (!existing.length) {
      res.status(404).json({ success: false, message: "Subscription not found" });
      return;
    }
    const subId = Number(existing[0]["id"]);

    await run("DELETE FROM subscriptions WHERE id = ?", [subId]);
    await logActivity(req.user!.id, "subscription.deleted", "subscription", subId, { name: existing[0]["name"] }, undefined, req.ip);

    res.json({ success: true, data: null, message: "Subscription deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─── GET /api/subscriptions/analytics/summary ─────────────────────────────────

export async function analyticsSubscriptions(req: Request, res: Response): Promise<void> {
  try {
    const { where: filterWhere, params: filterParams } = buildFilters(req.query as Record<string, string | undefined>);
    // Strip "WHERE 1=1" to get just the extra AND conditions
    const extraConds = filterWhere.replace("WHERE 1=1", "").trim();

    const [
      [monthlyRow],
      [annualRow],
      byCategoryRows,
      byBillingCycleRows,
      [expiryRow],
      [activeRow],
    ] = await Promise.all([
      // totalMonthlySpend — sum of price where billing_cycle label = 'Monthly'
      q<RowDataPacket>(
        `SELECT COALESCE(SUM(s.price), 0) AS total
         FROM subscriptions s
         JOIN subscription_meta_options bc ON bc.id = s.billing_cycle_id
         WHERE bc.label = 'Monthly' ${extraConds}`,
        [...filterParams]
      ),
      // totalAnnualSpend — active subscriptions normalized to annual
      q<RowDataPacket>(
        `SELECT COALESCE(SUM(
           s.price * CASE bc.label
             WHEN 'Monthly'   THEN 12
             WHEN 'Quarterly' THEN 4
             WHEN 'Annual'    THEN 1
             WHEN 'Weekly'    THEN 52
             ELSE 0
           END
         ), 0) AS total
         FROM subscriptions s
         LEFT JOIN subscription_meta_options bc ON bc.id = s.billing_cycle_id
         JOIN  subscription_meta_options st ON st.id = s.status_id
         WHERE st.label = 'Active' ${extraConds}`,
        [...filterParams]
      ),
      // byCategory
      q<RowDataPacket>(
        `SELECT cat.label AS categoryName, cat.color,
                COALESCE(SUM(s.price), 0) AS total, COUNT(s.id) AS count
         FROM subscriptions s
         LEFT JOIN subscription_meta_options cat ON cat.id = s.category_id
         WHERE 1=1 ${extraConds}
         GROUP BY s.category_id, cat.label, cat.color
         ORDER BY total DESC`,
        [...filterParams]
      ),
      // byBillingCycle
      q<RowDataPacket>(
        `SELECT bc.label, bc.color,
                COALESCE(SUM(s.price), 0) AS total, COUNT(s.id) AS count
         FROM subscriptions s
         LEFT JOIN subscription_meta_options bc ON bc.id = s.billing_cycle_id
         WHERE 1=1 ${extraConds}
         GROUP BY s.billing_cycle_id, bc.label, bc.color
         ORDER BY total DESC`,
        [...filterParams]
      ),
      // expiry counts
      q<RowDataPacket>(
        `SELECT
           SUM(CASE WHEN DATEDIFF(end_date, CURDATE()) BETWEEN 0 AND 7  THEN 1 ELSE 0 END) AS in7Days,
           SUM(CASE WHEN DATEDIFF(end_date, CURDATE()) BETWEEN 0 AND 30 THEN 1 ELSE 0 END) AS in30Days
         FROM subscriptions s
         WHERE 1=1 ${extraConds}`,
        [...filterParams]
      ),
      // totalActive
      q<RowDataPacket>(
        `SELECT COUNT(s.id) AS total
         FROM subscriptions s
         JOIN subscription_meta_options st ON st.id = s.status_id
         WHERE st.label = 'Active' ${extraConds}`,
        [...filterParams]
      ),
    ]);

    res.json({
      success: true,
      data: {
        totalMonthlySpend: Number(monthlyRow?.["total"]  ?? 0),
        totalAnnualSpend:  Number(annualRow?.["total"]   ?? 0),
        byCategory: byCategoryRows.map(r => ({
          categoryName: r["categoryName"] ?? "Uncategorized",
          color:        r["color"]        ?? null,
          total:        Number(r["total"]),
          count:        Number(r["count"]),
        })),
        byBillingCycle: byBillingCycleRows.map(r => ({
          label: r["label"] ?? "Unset",
          color: r["color"] ?? null,
          total: Number(r["total"]),
          count: Number(r["count"]),
        })),
        expiringIn7Days:  Number(expiryRow?.["in7Days"]  ?? 0),
        expiringIn30Days: Number(expiryRow?.["in30Days"] ?? 0),
        totalActive:      Number(activeRow?.["total"]    ?? 0),
      },
      message: "OK",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─── GET /api/subscriptions/export/csv ───────────────────────────────────────

export async function exportCsv(req: Request, res: Response): Promise<void> {
  try {
    const { where, params } = buildFilters(req.query as Record<string, string | undefined>);

    const rows = await q<RowDataPacket>(
      `SELECT ${SUB_SEL} ${SUB_FROM} ${where}
       ORDER BY DATEDIFF(s.end_date, CURDATE()) ASC`,
      params
    );

    const csvEsc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

    const header = ["Name", "Category", "Billing Cycle", "Status", "Price", "Next Renewal Amount", "Currency", "Start Date", "End Date", "Days Left", "Autopay"].join(",");
    const lines = rows.map(r => {
      const s = rowToSubscription(r);
      return [
        csvEsc(s.name),
        csvEsc(s.category?.label     ?? ""),
        csvEsc(s.billingCycle?.label ?? ""),
        csvEsc(s.status?.label       ?? ""),
        s.price ?? "",
        s.nextRenewalAmount ?? "",
        s.currency,
        s.startDate,
        s.endDate,
        s.daysLeft,
        s.autopay ? "Yes" : "No",
      ].join(",");
    });

    const csv = [header, ...lines].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="subscriptions-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─── POST /api/subscriptions/:uuid/logo ──────────────────────────────────────

export async function uploadSubscriptionLogo(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params;
    const existing = await q<RowDataPacket>(
      "SELECT id FROM subscriptions WHERE uuid = ?", [uuid]
    );
    if (!existing.length) {
      res.status(404).json({ success: false, message: "Subscription not found" });
      return;
    }
    const subId = Number(existing[0]["id"]);

    if (!req.file) {
      res.status(400).json({ success: false, message: "No file uploaded" });
      return;
    }

    const { url: logoUrl } = await uploadFile(req.file.buffer, { folder: "subscription-logos", filename: req.file.originalname, mimetype: req.file.mimetype });
    await run("UPDATE subscriptions SET logo_url = ? WHERE id = ?", [logoUrl, subId]);

    const rows = await q<RowDataPacket>(
      `SELECT ${SUB_SEL} ${SUB_FROM} WHERE s.id = ?`, [subId]
    );
    const sub = rowToSubscription(rows[0]);

    res.json({ success: true, data: sub, message: "Logo uploaded" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─── GET /api/subscriptions/cron/trigger ─────────────────────────────────────
// WARNING: REMOVE THIS ENDPOINT BEFORE GOING TO PRODUCTION.
// For local testing only — manually fires the expiry check job.

export async function cronTrigger(_req: Request, res: Response): Promise<void> {
  try {
    const result = await runExpiryCheck();
    res.json({ success: true, data: result, message: "Expiry check complete" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}
