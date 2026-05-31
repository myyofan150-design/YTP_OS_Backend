// src/jobs/notes-snooze.job.ts
// Runs every 15 minutes — wakes snoozed notes whose snoozed_until has passed.

import cron from "node-cron";
import { q, run, RowDataPacket } from "../lib/db";

async function runSnoozeCheck(): Promise<void> {
  const notes = await q<RowDataPacket>(
    `SELECT id, uuid, title, created_by AS createdBy
     FROM notes
     WHERE is_snoozed = 1
       AND snoozed_until <= NOW()
       AND status = 'active'`
  );

  for (const note of notes) {
    try {
      await run(
        `UPDATE notes SET is_snoozed = 0, snoozed_until = NULL WHERE id = ?`,
        [note["id"]]
      );

      run(
        `INSERT INTO notifications (user_id, type, title, body, link)
         VALUES (?, 'GENERAL', 'Snoozed note is back', ?, ?)`,
        [
          note["createdBy"],
          String(note["title"]),
          `/notes/${note["uuid"]}`,
        ]
      ).catch(() => {});
    } catch (err) {
      console.error(`[NotesSnoozeJob] Failed for note ${note["id"]}:`, err);
    }
  }

  if (notes.length > 0) {
    console.log(`[NotesSnoozeJob] Woke ${notes.length} snoozed note(s)`);
  }
}

export function startNotesSnoozeJob(): void {
  cron.schedule("*/15 * * * *", async () => {
    try {
      await runSnoozeCheck();
    } catch (err) {
      console.error("[NotesSnoozeJob] Fatal error:", err);
    }
  });

  console.log("   Notes snooze cron started — runs every 15 minutes");
}
