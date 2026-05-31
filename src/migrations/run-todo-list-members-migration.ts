// src/migrations/run-todo-list-members-migration.ts
// Run: npx ts-node src/migrations/run-todo-list-members-migration.ts

import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import fs from "fs";
import { pool } from "../lib/db";

async function runMigration() {
  const sqlPath = path.join(__dirname, "todo_list_members.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");

  const statements = sql
    .split(";")
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim()
    )
    .filter((s) => s.length > 0);

  console.log(`\n📦 Running todo_list_members.sql — ${statements.length} statements\n`);

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const preview = stmt.split("\n")[0].slice(0, 80);
    try {
      await pool.execute(stmt);
      console.log(`  ✅ [${i + 1}/${statements.length}] ${preview}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already exists")) {
        console.log(`  ⚠️  [${i + 1}/${statements.length}] Already exists — skipping`);
      } else {
        console.error(`  ❌ [${i + 1}/${statements.length}] FAILED: ${msg}`);
        console.error(`     Statement: ${preview}`);
      }
    }
  }

  console.log("\n✅ Migration complete.\n");
  await pool.end();
  process.exit(0);
}

runMigration().catch((err) => {
  console.error("Migration runner crashed:", err);
  process.exit(1);
});
