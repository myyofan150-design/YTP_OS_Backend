// src/lib/subscription-db.ts
import { q, RowDataPacket } from "./db";
import type { SubscriptionWithMeta } from "../types/subscription.types";

export function calculateDaysLeft(endDate: string): number {
  const end = new Date(endDate);
  end.setUTCHours(0, 0, 0, 0);
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  return Math.ceil((end.getTime() - now.getTime()) / 86_400_000);
}

export function rowToSubscription(r: RowDataPacket): SubscriptionWithMeta {
  return {
    id:             Number(r["id"]),
    uuid:           String(r["uuid"]),
    name:           String(r["name"]),
    logoUrl:        r["logoUrl"]  ?? null,
    link:           r["link"]     ?? null,
    username:       r["username"] ?? null,
    startDate:      String(r["startDate"]),
    endDate:        String(r["endDate"]),
    categoryId:     r["categoryId"]     != null ? Number(r["categoryId"])     : null,
    billingCycleId: r["billingCycleId"] != null ? Number(r["billingCycleId"]) : null,
    statusId:       r["statusId"]       != null ? Number(r["statusId"])       : null,
    price:          r["price"]    != null ? Number(r["price"])    : null,
    currency:       String(r["currency"] ?? "INR"),
    autopay:        Boolean(r["autopay"]),
    planTier:       r["planTier"]   ?? null,
    usageType:      r["usageType"]  ?? null,
    remarks:        r["remarks"] ?? null,
    daysLeft:       calculateDaysLeft(String(r["endDate"])),
    createdBy:      Number(r["createdBy"]),
    createdAt:      String(r["createdAt"]),
    category: r["catUuid"]
      ? { id: Number(r["categoryId"]), uuid: String(r["catUuid"]), type: "category",     label: String(r["catLabel"]), color: String(r["catColor"]), sortOrder: Number(r["catSortOrder"]) }
      : null,
    billingCycle: r["bcUuid"]
      ? { id: Number(r["billingCycleId"]), uuid: String(r["bcUuid"]),  type: "billing_cycle", label: String(r["bcLabel"]),  color: String(r["bcColor"]),  sortOrder: Number(r["bcSortOrder"])  }
      : null,
    status: r["stUuid"]
      ? { id: Number(r["statusId"]),       uuid: String(r["stUuid"]),  type: "status",        label: String(r["stLabel"]),  color: String(r["stColor"]),  sortOrder: Number(r["stSortOrder"])  }
      : null,
  };
}

export async function getSubscriptionWithMeta(uuid: string): Promise<SubscriptionWithMeta | null> {
  const rows = await q<RowDataPacket>(
    `SELECT
       s.id, s.uuid, s.name,
       s.logo_url        AS logoUrl,
       s.link,
       s.username,
       s.start_date      AS startDate,
       s.end_date        AS endDate,
       s.category_id     AS categoryId,
       s.billing_cycle_id AS billingCycleId,
       s.status_id       AS statusId,
       s.price, s.currency, s.autopay, s.plan_tier AS planTier, s.usage_type AS usageType, s.remarks,
       s.created_by      AS createdBy,
       s.created_at      AS createdAt,
       cat.uuid          AS catUuid,
       cat.label         AS catLabel,
       cat.color         AS catColor,
       cat.sort_order    AS catSortOrder,
       bc.uuid           AS bcUuid,
       bc.label          AS bcLabel,
       bc.color          AS bcColor,
       bc.sort_order     AS bcSortOrder,
       st.uuid           AS stUuid,
       st.label          AS stLabel,
       st.color          AS stColor,
       st.sort_order     AS stSortOrder
     FROM subscriptions s
     LEFT JOIN subscription_meta_options cat ON cat.id = s.category_id
     LEFT JOIN subscription_meta_options bc  ON bc.id  = s.billing_cycle_id
     LEFT JOIN subscription_meta_options st  ON st.id  = s.status_id
     WHERE s.uuid = ?`,
    [uuid]
  );

  if (!rows.length) return null;
  return rowToSubscription(rows[0]);
}
