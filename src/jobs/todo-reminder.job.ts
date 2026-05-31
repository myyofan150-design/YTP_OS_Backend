// src/jobs/todo-reminder.job.ts
// Runs every minute — fires email reminders for tasks whose reminder_at just passed.

import cron from "node-cron";
import { q, RowDataPacket } from "../lib/db";
import { sendMail } from "../lib/mailer";

interface ReminderTask {
  id: number;
  uuid: string;
  title: string;
  dueDate: string | null;
  createdBy: number;
  assignedTo: number | null;
  creatorEmail: string;
  creatorName: string;
  assigneeEmail: string | null;
  assigneeName: string | null;
}

function buildReminderEmail(task: ReminderTask, recipientName: string): string {
  const appUrl  = process.env["APP_URL"] || "http://localhost:3000";
  const taskUrl = `${appUrl}/todo/tasks/${task.uuid}`;
  const dueLine = task.dueDate
    ? `<p style="margin:6px 0 0;font-size:13px;color:#6B7280;">Due date: <strong>${task.dueDate}</strong></p>`
    : "";

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#F3F4F6;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:40px 0;">
    <tr><td align="center">
      <table width="540" cellpadding="0" cellspacing="0"
             style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.07);">

        <tr>
          <td style="background:#6366F1;padding:24px 32px;">
            <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.5px;">Agency OS</span>
          </td>
        </tr>

        <tr>
          <td style="padding:32px;">
            <p style="margin:0 0 6px;font-size:12px;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.8px;">Task Reminder</p>
            <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#111827;">&#9200; ${task.title}</h1>
            <p style="margin:0 0 4px;font-size:14px;color:#6B7280;">Hi ${recipientName}, this is your reminder.</p>
            ${dueLine}

            <div style="margin:28px 0;">
              <a href="${taskUrl}"
                 style="display:inline-block;background:#6366F1;color:#ffffff;padding:13px 28px;
                        border-radius:8px;font-weight:600;font-size:15px;text-decoration:none;">
                View Task &rarr;
              </a>
            </div>
          </td>
        </tr>

        <tr>
          <td style="background:#F9FAFB;padding:16px 32px;border-top:1px solid #E5E7EB;">
            <p style="margin:0;font-size:12px;color:#9CA3AF;">
              This is an automated reminder from Agency OS.
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function runReminderCheck(): Promise<void> {
  // Find tasks whose reminder fired in the last 2 minutes (window handles sub-minute drift)
  const tasks = await q<RowDataPacket & ReminderTask>(
    `SELECT
       t.id, t.uuid, t.title, t.due_date AS dueDate,
       t.created_by AS createdBy, t.assigned_to AS assignedTo,
       creator.email AS creatorEmail, creator.name AS creatorName,
       assignee.email AS assigneeEmail, assignee.name AS assigneeName
     FROM todo_tasks t
     JOIN  users creator  ON creator.id  = t.created_by
     LEFT JOIN users assignee ON assignee.id = t.assigned_to
     WHERE t.reminder_at <= NOW()
       AND t.reminder_at > DATE_SUB(NOW(), INTERVAL 2 MINUTE)
       AND t.status = 'pending'`
  );

  for (const task of tasks) {
    try {
      // Always notify creator
      const recipients: Array<{ email: string; name: string }> = [
        { email: task.creatorEmail, name: task.creatorName },
      ];

      // Also notify assignee if different from creator
      if (task.assignedTo && task.assignedTo !== task.createdBy && task.assigneeEmail) {
        recipients.push({ email: task.assigneeEmail, name: task.assigneeName ?? "Team member" });
      }

      for (const r of recipients) {
        try {
          await sendMail(r.email, `⏰ Reminder: ${task.title}`, buildReminderEmail(task, r.name));
        } catch (mailErr) {
          console.error(`[TodoReminderJob] Email failed for ${r.email}:`, mailErr);
        }
      }

      console.log(`[TodoReminderJob] Reminder fired for task "${task.title}" → ${recipients.map(r => r.email).join(", ")}`);
    } catch (taskErr) {
      console.error(`[TodoReminderJob] Failed processing task ${task.id}:`, taskErr);
    }
  }
}

export function startTodoReminderJob(): void {
  cron.schedule("* * * * *", async () => {
    try {
      await runReminderCheck();
    } catch (err) {
      console.error("[TodoReminderJob] Fatal error:", err);
    }
  });

  console.log("   Todo reminder cron started — runs every minute");
}
