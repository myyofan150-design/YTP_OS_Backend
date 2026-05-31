// src/migrations/run-invoice-milestone-settings-migration.ts
// Adds `milestone` column to invoices and creates system_settings table.
// Safe to run multiple times (IF NOT EXISTS guards).

import { pool } from "../lib/db";

async function up() {
  const conn = await pool.getConnection();
  try {
    // Add milestone to invoices if not already present
    await conn.execute(`
      ALTER TABLE invoices
        ADD COLUMN IF NOT EXISTS milestone VARCHAR(500) NULL
    `);
    console.log("✓ invoices.milestone column ensured");

    // Create system_settings key-value table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS system_settings (
        id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`key\`    VARCHAR(100) NOT NULL,
        value      TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_key (\`key\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log("✓ system_settings table ensured");

    // Seed default company settings if not set
    await conn.execute(`
      INSERT IGNORE INTO system_settings (\`key\`, value) VALUES
        ('company_name', 'Agency OS'),
        ('company_tagline', 'Digital Marketing Agency'),
        ('company_email', 'contact@agencyos.in'),
        ('company_logo_url', NULL)
    `);
    console.log("✓ default system_settings seeded");
  } finally {
    conn.release();
  }
}

up()
  .then(() => { console.log("Migration complete."); process.exit(0); })
  .catch(err => { console.error("Migration failed:", err); process.exit(1); });
