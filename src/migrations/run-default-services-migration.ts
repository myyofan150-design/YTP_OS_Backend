// src/migrations/run-default-services-migration.ts
// Ensures client_meta_options table exists and seeds default services.
// Safe to run multiple times (CREATE IF NOT EXISTS + INSERT IGNORE).

import { pool } from "../lib/db";

const DEFAULT_SERVICES = [
  { label: "Website Development", color: "#6366F1" },
  { label: "SMM",                 color: "#ec4899" },
  { label: "SEO",                 color: "#f59e0b" },
  { label: "Video Editing",       color: "#14b8a6" },
  { label: "Graphic Design",      color: "#f97316" },
];

async function up() {
  const conn = await pool.getConnection();
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS client_meta_options (
        id         INT          PRIMARY KEY AUTO_INCREMENT,
        uuid       VARCHAR(36)  UNIQUE NOT NULL DEFAULT (UUID()),
        type       VARCHAR(50)  NOT NULL,
        label      VARCHAR(100) NOT NULL,
        color      VARCHAR(20)  NOT NULL DEFAULT '#6366F1',
        sort_order INT          NOT NULL DEFAULT 0,
        created_by INT,
        created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log("✓ client_meta_options table ensured");

    // Modify clients columns if not already varchar
    await conn.execute(`ALTER TABLE clients MODIFY COLUMN client_tag VARCHAR(100)`).catch(() => {});
    await conn.execute(`ALTER TABLE clients MODIFY COLUMN contract_type VARCHAR(100) NOT NULL DEFAULT 'MONTHLY'`).catch(() => {});
    await conn.execute(`ALTER TABLE clients MODIFY COLUMN status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE'`).catch(() => {});
    console.log("✓ clients columns updated");

    // Seed default services
    for (let i = 0; i < DEFAULT_SERVICES.length; i++) {
      const svc = DEFAULT_SERVICES[i];
      await conn.execute(
        `INSERT IGNORE INTO client_meta_options (type, label, color, sort_order)
         VALUES ('service', ?, ?, ?)`,
        [svc.label, svc.color, i + 1]
      );
    }
    console.log(`✓ ${DEFAULT_SERVICES.length} default services seeded`);
  } finally {
    conn.release();
  }
}

up()
  .then(() => { console.log("Migration complete."); process.exit(0); })
  .catch(err => { console.error("Migration failed:", err); process.exit(1); });
