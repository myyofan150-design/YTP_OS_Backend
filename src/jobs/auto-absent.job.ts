// src/jobs/auto-absent.job.ts
// Runs daily at 10:30 PM IST — marks ABSENT for employees who never clocked in,
// have no approved leave, and today is not a holiday or Sunday.
import cron from "node-cron";
import { q, run, RowDataPacket } from "../lib/db";

function todayStr(): string {
  return new Date().toISOString().split("T")[0]!;
}

async function autoMarkAbsent(): Promise<void> {
  const today     = todayStr();
  const dayOfWeek = new Date().getDay();

  if (dayOfWeek === 0) return; // Sunday — skip

  // Skip holidays
  const holidays = await q<RowDataPacket>("SELECT id FROM holidays WHERE date = ?", [today]);
  if (holidays.length) return;

  // Find active employees with no attendance record today AND no approved leave today
  const absentees = await q<RowDataPacket>(
    `SELECT e.id
     FROM employees e
     WHERE e.status = 'ACTIVE'
       AND NOT EXISTS (
         SELECT 1 FROM attendance_logs al
         WHERE al.employee_id = e.id AND al.date = ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM leave_requests lr
         WHERE lr.employee_id = e.id AND lr.status = 'APPROVED'
           AND lr.from_date <= ? AND lr.to_date >= ?
       )`,
    [today, today, today]
  );

  let count = 0;
  for (const emp of absentees) {
    try {
      await run(
        `INSERT IGNORE INTO attendance_logs (employee_id, date, type, late_minutes, source)
         VALUES (?, ?, 'ABSENT', 0, 'MANUAL')`,
        [emp["id"], today]
      );
      count++;
    } catch {
      // ignore individual insert failures
    }
  }

  if (count > 0) {
    console.log(`[AutoAbsent] Marked ${count} employee(s) as ABSENT for ${today}`);
  }
}

export function startAutoAbsentJob(): void {
  // 22:30 IST = 17:00 UTC
  cron.schedule("0 17 * * *", () => {
    console.log("[AutoAbsent] Running auto-absent job…");
    autoMarkAbsent().catch((err) => console.error("[AutoAbsent] Error:", err));
  });
  console.log("  ✓ Auto-absent job scheduled (22:30 IST daily)");
}
