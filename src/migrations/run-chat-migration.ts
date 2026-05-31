// src/migrations/run-chat-migration.ts
import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import fs from "fs";
import { pool } from "../lib/db";

async function run(): Promise<void> {
  const sqlPath = path.join(__dirname, "chat_module.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");

  // split on semicolons; strip comment lines inside each statement
  const statements = sql
    .split(";")
    .map(s =>
      s.split("\n")
        .filter(line => !line.trim().startsWith("--"))
        .join("\n")
        .trim()
    )
    .filter(s => s.length > 0);

  console.log(`\nRunning chat migration — ${statements.length} statements\n`);

  for (const stmt of statements) {
    const preview = stmt.slice(0, 60).replace(/\n/g, " ");
    try {
      await pool.execute(stmt);
      console.log(`  ✓  ${preview}`);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      // skip "already exists" errors — idempotent re-run
      if (msg.includes("already exists")) {
        console.log(`  ~  (already exists) ${preview}`);
      } else {
        console.error(`  ✗  ${preview}\n     ${msg}`);
      }
    }
  }

  console.log("\nChat migration complete.\n");
  await pool.end();
}

run().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
