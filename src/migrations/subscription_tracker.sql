-- src/migrations/subscription_tracker.sql
-- Subscription Tracker: meta options lookup table + subscriptions table
-- Run once against agency_os database.

-- ─── Table 1: subscription_meta_options ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscription_meta_options (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  uuid        VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  type        ENUM('category', 'billing_cycle', 'status') NOT NULL,
  label       VARCHAR(100) NOT NULL,
  color       VARCHAR(7) NOT NULL DEFAULT '#6366F1',
  sort_order  INT DEFAULT 0,
  created_by  INT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_type (type)
);

-- ─── Table 2: subscriptions ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  uuid                VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  name                VARCHAR(200) NOT NULL,
  logo_url            VARCHAR(500),
  link                VARCHAR(500),
  username            VARCHAR(200),
  password_encrypted  TEXT,
  start_date          DATE NOT NULL,
  end_date            DATE NOT NULL,
  category_id         INT,
  billing_cycle_id    INT,
  status_id           INT,
  price               DECIMAL(10,2),
  currency            VARCHAR(10) DEFAULT 'INR',
  autopay             BOOLEAN DEFAULT FALSE,
  remarks             TEXT,
  created_by          INT NOT NULL,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_end_date (end_date),
  INDEX idx_status   (status_id),
  CONSTRAINT fk_sub_category      FOREIGN KEY (category_id)      REFERENCES subscription_meta_options(id) ON DELETE SET NULL,
  CONSTRAINT fk_sub_billing_cycle FOREIGN KEY (billing_cycle_id) REFERENCES subscription_meta_options(id) ON DELETE SET NULL,
  CONSTRAINT fk_sub_status        FOREIGN KEY (status_id)        REFERENCES subscription_meta_options(id) ON DELETE SET NULL
);

-- ─── Seed: Billing Cycles ─────────────────────────────────────────────────────
INSERT IGNORE INTO subscription_meta_options (uuid, type, label, color, sort_order) VALUES
  (UUID(), 'billing_cycle', 'Monthly',   '#3B82F6', 1),
  (UUID(), 'billing_cycle', 'Quarterly', '#8B5CF6', 2),
  (UUID(), 'billing_cycle', 'Annual',    '#10B981', 3),
  (UUID(), 'billing_cycle', 'Lifetime',  '#F59E0B', 4),
  (UUID(), 'billing_cycle', 'Weekly',    '#EF4444', 5);

-- ─── Seed: Categories ────────────────────────────────────────────────────────
INSERT IGNORE INTO subscription_meta_options (uuid, type, label, color, sort_order) VALUES
  (UUID(), 'category', 'SaaS Tools',     '#6366F1', 1),
  (UUID(), 'category', 'Marketing',      '#EC4899', 2),
  (UUID(), 'category', 'Infrastructure', '#14B8A6', 3),
  (UUID(), 'category', 'Communication',  '#F97316', 4),
  (UUID(), 'category', 'Design',         '#A855F7', 5),
  (UUID(), 'category', 'Analytics',      '#06B6D4', 6);

-- ─── Seed: Statuses ──────────────────────────────────────────────────────────
INSERT IGNORE INTO subscription_meta_options (uuid, type, label, color, sort_order) VALUES
  (UUID(), 'status', 'Active',        '#22C55E', 1),
  (UUID(), 'status', 'Expiring Soon', '#F59E0B', 2),
  (UUID(), 'status', 'Expired',       '#EF4444', 3),
  (UUID(), 'status', 'Cancelled',     '#6B7280', 4),
  (UUID(), 'status', 'Paused',        '#94A3B8', 5);
