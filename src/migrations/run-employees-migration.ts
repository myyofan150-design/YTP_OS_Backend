// src/migrations/run-employees-migration.ts
// Runs employees_enhancement.sql against the configured MySQL database.
// Executes each statement individually; skips non-fatal errors so the
// script can be re-run safely without crashing on already-applied changes.
//
// Usage: npx ts-node src/migrations/run-employees-migration.ts

import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { pool } from "../lib/db";

// MySQL error codes treated as non-fatal (already applied)
const SKIPPABLE_CODES = new Set([
  "ER_DUP_FIELDNAME",      // 1060 — column already exists
  "ER_TABLE_EXISTS_ERROR", // 1050 — table already exists (CREATE TABLE without IF NOT EXISTS)
]);
const SKIPPABLE_ERRNO = new Set([1060, 1050]);

async function runMigration(): Promise<void> {
  const sqlPath = path.join(__dirname, "employees_enhancement.sql");

  if (!fs.existsSync(sqlPath)) {
    console.error(`[ERROR] Migration file not found: ${sqlPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(sqlPath, "utf-8");

  // Strip single-line comments (-- ...) then split on semicolons
  const cleaned = raw.replace(/--[^\n]*/g, "");
  const statements = cleaned
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  console.log(`\n🚀 Running employees_enhancement.sql`);
  console.log(`   ${statements.length} statements found\n`);

  const conn = await pool.getConnection();
  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i]!;
    const preview = stmt.replace(/\s+/g, " ").slice(0, 70) + (stmt.length > 70 ? "…" : "");
    const label = `[${String(i + 1).padStart(2, "0")}/${statements.length}]`;

    try {
      await conn.execute(stmt);
      console.log(`  ✓ ${label} ${preview}`);
      ok++;
    } catch (err: unknown) {
      const e = err as { code?: string; errno?: number; message?: string };
      if (
        (e.code && SKIPPABLE_CODES.has(e.code)) ||
        (e.errno != null && SKIPPABLE_ERRNO.has(e.errno))
      ) {
        console.log(`  ⏭  ${label} SKIP (already applied) — ${preview}`);
        skipped++;
      } else {
        console.error(`  ✗ ${label} FAIL — ${preview}`);
        console.error(`       ${e.message ?? String(err)}`);
        failed++;
        // Continue — do not abort; remaining statements may still succeed
      }
    }
  }

  conn.release();

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Results: ${ok} succeeded · ${skipped} skipped · ${failed} failed`);
  console.log(`${"─".repeat(60)}\n`);

  if (failed > 0) {
    console.warn(`⚠️  ${failed} statement(s) failed. Review errors above.`);
    process.exit(1);
  } else {
    console.log(`✅  Migration complete.`);
    process.exit(0);
  }
}

runMigration().catch((err) => {
  console.error("[FATAL] Migration aborted:", err);
  process.exit(1);
});
