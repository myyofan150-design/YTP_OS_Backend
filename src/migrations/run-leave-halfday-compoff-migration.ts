// src/migrations/run-leave-halfday-compoff-migration.ts
// Adds is_half_day / half_day_slot to leave_requests and creates comp_off_requests.
// Usage: npx ts-node src/migrations/run-leave-halfday-compoff-migration.ts

import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { pool } from "../lib/db";

const SKIPPABLE_CODES = new Set(["ER_DUP_FIELDNAME", "ER_TABLE_EXISTS_ERROR"]);
const SKIPPABLE_ERRNO = new Set([1060, 1050]);

async function runMigration(): Promise<void> {
  const sqlPath = path.join(__dirname, "leave_halfday_compoff.sql");
  if (!fs.existsSync(sqlPath)) {
    console.error(`[ERROR] Migration file not found: ${sqlPath}`);
    process.exit(1);
  }

  const raw      = fs.readFileSync(sqlPath, "utf-8");
  const cleaned  = raw.replace(/--[^\n]*/g, "");
  const stmts    = cleaned.split(";").map(s => s.trim()).filter(s => s.length > 0);

  console.log(`\n🚀 Running leave_halfday_compoff.sql`);
  console.log(`   ${stmts.length} statements found\n`);

  const conn = await pool.getConnection();
  let ok = 0, skipped = 0, failed = 0;

  for (let i = 0; i < stmts.length; i++) {
    const stmt    = stmts[i]!;
    const preview = stmt.replace(/\s+/g, " ").slice(0, 70) + (stmt.length > 70 ? "…" : "");
    const label   = `[${String(i + 1).padStart(2, "0")}/${stmts.length}]`;
    try {
      await conn.execute(stmt);
      console.log(`  ✓ ${label} ${preview}`);
      ok++;
    } catch (err: unknown) {
      const e = err as { code?: string; errno?: number; message?: string };
      if ((e.code && SKIPPABLE_CODES.has(e.code)) || (e.errno != null && SKIPPABLE_ERRNO.has(e.errno))) {
        console.log(`  ⏭  ${label} SKIP (already applied) — ${preview}`);
        skipped++;
      } else {
        console.error(`  ✗ ${label} FAIL — ${preview}`);
        console.error(`       ${e.message ?? String(err)}`);
        failed++;
      }
    }
  }

  conn.release();
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Results: ${ok} succeeded · ${skipped} skipped · ${failed} failed`);
  console.log(`${"─".repeat(60)}\n`);
  if (failed > 0) { console.warn(`⚠️  ${failed} statement(s) failed.`); process.exit(1); }
  else { console.log(`✅  Migration complete.`); process.exit(0); }
}

runMigration().catch(err => { console.error("[FATAL]", err); process.exit(1); });
