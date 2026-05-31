// src/jobs/subscription-expiry.job.ts
// Daily cron at 9:00 AM IST — emails subscription creators + all admins when expiry is 7 or 1 day away.
import cron from "node-cron";
import { q, run, RowDataPacket } from "../lib/db";
import { sendMail } from "../lib/mailer";

// ─── Internal types ───────────────────────────────────────────────────────────

interface SubExpiry {
  id: number;
  uuid: string;
  name: string;
  logoUrl: string | null;
  link: string | null;
  endDate: string;
  price: number | null;
  currency: string;
  createdBy: number;
  creatorEmail: string;
  creatorName: string;
  billingCycleLabel: string | null;
}

interface AdminUser {
  id: number;
  email: string;
  name: string;
}

// ─── HTML email builder ───────────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function buildExpiryEmail(sub: SubExpiry, daysLeft: number): string {
  const urgent      = daysLeft <= 1;
  const alertBg     = urgent ? "#FEF2F2" : "#FFFBEB";
  const alertBorder = urgent ? "#FECACA" : "#FDE68A";
  const alertColor  = urgent ? "#DC2626" : "#D97706";
  const alertText   = urgent ? "🚨 Expires TOMORROW" : `⚠️ Expires in ${daysLeft} days`;
  const priceStr    = sub.price != null
    ? `${sub.currency} ${Number(sub.price).toFixed(2)}${sub.billingCycleLabel ? ` / ${sub.billingCycleLabel}` : ""}`
    : "N/A";
  const appUrl      = process.env["APP_URL"] || "http://localhost:3000";
  const viewUrl     = sub.link || `${appUrl}/subscriptions/${sub.uuid}`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#F3F4F6;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0"
               style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.07);">

          <!-- Header -->
          <tr>
            <td style="background:#6366F1;padding:24px 32px;">
              <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.5px;">Agency OS</span>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 6px;font-size:12px;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.8px;">Subscription Alert</p>

              ${sub.logoUrl
                ? `<img src="${sub.logoUrl}" alt="${sub.name}" width="48" height="48"
                        style="border-radius:8px;object-fit:cover;margin-bottom:12px;display:block;">`
                : ""}

              <h1 style="margin:0 0 24px;font-size:26px;font-weight:700;color:#111827;">${sub.name}</h1>

              <!-- Alert badge -->
              <div style="background:${alertBg};border:1px solid ${alertBorder};border-radius:8px;padding:16px 20px;margin-bottom:24px;">
                <p style="margin:0;font-size:18px;font-weight:700;color:${alertColor};">${alertText}</p>
                <p style="margin:6px 0 0;font-size:13px;color:#6B7280;">Expiry date: <strong>${formatDate(sub.endDate)}</strong></p>
              </div>

              <!-- Details table -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;border:1px solid #E5E7EB;border-radius:8px;overflow:hidden;">
                <tr>
                  <td style="padding:12px 16px;background:#F9FAFB;border-bottom:1px solid #E5E7EB;">
                    <span style="font-size:12px;color:#6B7280;text-transform:uppercase;letter-spacing:0.5px;">Price</span>
                  </td>
                  <td style="padding:12px 16px;background:#ffffff;border-bottom:1px solid #E5E7EB;text-align:right;">
                    <span style="font-size:14px;font-weight:600;color:#111827;">${priceStr}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:12px 16px;background:#F9FAFB;">
                    <span style="font-size:12px;color:#6B7280;text-transform:uppercase;letter-spacing:0.5px;">Expiry Date</span>
                  </td>
                  <td style="padding:12px 16px;background:#ffffff;text-align:right;">
                    <span style="font-size:14px;font-weight:600;color:#111827;">${formatDate(sub.endDate)}</span>
                  </td>
                </tr>
              </table>

              <!-- CTA -->
              <a href="${viewUrl}"
                 style="display:inline-block;background:#6366F1;color:#ffffff;padding:13px 28px;
                        border-radius:8px;font-weight:600;font-size:15px;text-decoration:none;">
                View Subscription &rarr;
              </a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#F9FAFB;padding:16px 32px;border-top:1px solid #E5E7EB;">
              <p style="margin:0;font-size:12px;color:#9CA3AF;">
                This is an automated reminder from Agency OS.
                Please renew your subscription before the expiry date to avoid service interruption.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function queryExpiring(daysLeft: number): Promise<SubExpiry[]> {
  return q<RowDataPacket & SubExpiry>(
    `SELECT
       s.id, s.uuid, s.name,
       s.logo_url         AS logoUrl,
       s.link,
       s.end_date         AS endDate,
       s.price, s.currency,
       s.created_by       AS createdBy,
       u.email            AS creatorEmail,
       u.name             AS creatorName,
       bc.label           AS billingCycleLabel
     FROM subscriptions s
     JOIN  users u ON u.id = s.created_by
     LEFT JOIN subscription_meta_options bc ON bc.id = s.billing_cycle_id
     WHERE DATEDIFF(s.end_date, CURDATE()) = ?`,
    [daysLeft]
  );
}

async function getAdminUsers(): Promise<AdminUser[]> {
  return q<RowDataPacket & AdminUser>(
    `SELECT id, email, name FROM users
     WHERE role IN ('ADMIN', 'SUPER_ADMIN') AND status = 'ACTIVE'`
  );
}

async function createNotification(
  userId: number,
  title: string,
  body: string,
  link: string
): Promise<void> {
  await run(
    `INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)`,
    [userId, "subscription_expiry", title, body, link]
  );
}

// ─── Core logic (exported for manual trigger) ─────────────────────────────────

export async function runExpiryCheck(): Promise<{ checked: number; emailsSent: number }> {
  let emailsSent = 0;

  const [expiring7, expiring1, adminUsers] = await Promise.all([
    queryExpiring(7),
    queryExpiring(1),
    getAdminUsers(),
  ]);

  const allExpiring: Array<{ sub: SubExpiry; daysLeft: number }> = [
    ...expiring7.map(sub => ({ sub, daysLeft: 7 })),
    ...expiring1.map(sub => ({ sub, daysLeft: 1 })),
  ];

  const checked = allExpiring.length;
  const appUrl  = process.env["APP_URL"] || "http://localhost:3000";

  for (const { sub, daysLeft } of allExpiring) {
    try {
      const urgencyLabel = daysLeft === 1 ? "TOMORROW" : `in ${daysLeft} days`;
      const subject      = daysLeft === 1
        ? `🚨 Subscription Expiring TOMORROW — ${sub.name}`
        : `⚠️ Subscription Expiring in 7 Days — ${sub.name}`;
      const html         = buildExpiryEmail(sub, daysLeft);
      const notifTitle   = `${sub.name} expires ${urgencyLabel}`;
      const notifBody    = `Your subscription "${sub.name}" expires on ${sub.endDate}. Please renew to avoid interruption.`;
      const notifLink    = `/subscriptions/${sub.uuid}`;

      // Collect unique recipient emails (creator + all admins)
      const adminEmails  = new Set(adminUsers.map(a => a.email));
      const recipients   = [...adminEmails];
      if (!adminEmails.has(sub.creatorEmail)) {
        recipients.push(sub.creatorEmail);
      }

      await sendMail(recipients, subject, html);
      emailsSent++;

      // Notifications for admin users only
      for (const admin of adminUsers) {
        try {
          await createNotification(admin.id, notifTitle, notifBody, notifLink);
        } catch (notifErr) {
          console.error(`[ExpiryJob] Failed notification for admin ${admin.id}:`, notifErr);
        }
      }

      console.log(`[ExpiryJob] Sent alert for "${sub.name}" (expires ${urgencyLabel}) to ${recipients.length} recipient(s)`);
    } catch (err) {
      console.error(`[ExpiryJob] Failed to process subscription "${sub.name}":`, err);
    }
  }

  return { checked, emailsSent };
}

// ─── Cron registration ────────────────────────────────────────────────────────

export function startSubscriptionExpiryJob(): void {
  // Runs daily at 9:00 AM IST (Asia/Kolkata = UTC+5:30)
  cron.schedule("0 9 * * *", async () => {
    console.log("[ExpiryJob] Running subscription expiry check…");
    try {
      const result = await runExpiryCheck();
      console.log(`[ExpiryJob] Done — checked: ${result.checked}, emails sent: ${result.emailsSent}`);
    } catch (err) {
      console.error("[ExpiryJob] Fatal error during expiry check:", err);
    }
  }, { timezone: "Asia/Kolkata" });

  console.log("   Subscription expiry cron job started — runs daily at 9:00 AM IST");
}
