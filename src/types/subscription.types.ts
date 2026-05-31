// src/types/subscription.types.ts

export interface MetaOption {
  id: number;
  uuid: string;
  type: "category" | "billing_cycle" | "status";
  label: string;
  color: string;
  sortOrder: number;
}

export interface Subscription {
  id: number;
  uuid: string;
  name: string;
  logoUrl: string | null;
  link: string | null;
  username: string | null;
  startDate: string;
  endDate: string;
  categoryId: number | null;
  billingCycleId: number | null;
  statusId: number | null;
  price: number | null;
  currency: string;
  autopay: boolean;
  planTier: "free" | "basic" | "trial" | "pro" | "premium" | null;
  usageType: "internal" | "client" | null;
  remarks: string | null;
  daysLeft: number;
  createdBy: number;
  createdAt: string;
}

export interface SubscriptionWithMeta extends Subscription {
  category: MetaOption | null;
  billingCycle: MetaOption | null;
  status: MetaOption | null;
}
