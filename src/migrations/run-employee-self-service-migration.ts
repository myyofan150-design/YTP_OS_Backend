// src/migrations/run-employee-self-service-migration.ts
// Run: npx ts-node src/migrations/run-employee-self-service-migration.ts

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import mysql from 'mysql2/promise';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function run() {
  const conn = await mysql.createConnection({
    host:     process.env['DB_HOST']     || 'localhost',
    port:     parseInt(process.env['DB_PORT'] || '3306', 10),
    user:     process.env['DB_USER']     || 'root',
    password: process.env['DB_PASS']     || '',
    database: process.env['DB_NAME']     || 'ytp_os',
    multipleStatements: true,
  });

  const sqlPath = path.resolve(__dirname, 'employee_self_service.sql');
  const sql     = fs.readFileSync(sqlPath, 'utf8');

  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));

  for (const stmt of statements) {
    try {
      await conn.query(stmt);
      const match = stmt.match(/CREATE TABLE IF NOT EXISTS (\w+)/i);
      if (match) console.log(`  ✓ Table: ${match[1]}`);
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      if (e.code === 'ER_DUP_FIELDNAME') {
        console.log(`  ⚠ Skipped (column exists): ${e.message}`);
      } else if (e.code === 'ER_TABLE_EXISTS_ERROR') {
        console.log(`  ⚠ Skipped (table exists)`);
      } else {
        console.error('  ✗ Error:', e.message ?? err);
      }
    }
  }

  await conn.end();
  console.log('\nEmployee self-service migration done.\n');
}

run().catch(err => { console.error(err); process.exit(1); });
