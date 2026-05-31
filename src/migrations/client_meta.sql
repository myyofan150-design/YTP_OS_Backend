-- Client Meta Options: custom tags and contract types
-- Run against: ytp_os

-- Make client_tag and contract_type free-form VARCHAR so users can define their own values
ALTER TABLE clients MODIFY COLUMN client_tag VARCHAR(100);
ALTER TABLE clients MODIFY COLUMN contract_type VARCHAR(100) NOT NULL DEFAULT 'MONTHLY';
-- Also add status values INACTIVE and ON_HOLD if not already present
ALTER TABLE clients MODIFY COLUMN status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE';

-- Also add milestone to invoices if not already there
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS milestone VARCHAR(200) AFTER notes;

-- Table to hold user-defined client meta options (tags, contract types)
CREATE TABLE IF NOT EXISTS client_meta_options (
  id         INT          PRIMARY KEY AUTO_INCREMENT,
  uuid       VARCHAR(36)  UNIQUE NOT NULL DEFAULT (UUID()),
  type       VARCHAR(50)  NOT NULL,   -- 'tag' | 'contract_type'
  label      VARCHAR(100) NOT NULL,
  color      VARCHAR(20)  NOT NULL DEFAULT '#6366F1',
  sort_order INT          NOT NULL DEFAULT 0,
  created_by INT,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Seed default tag values
INSERT IGNORE INTO client_meta_options (type, label, color, sort_order, created_by)
  SELECT 'tag', 'VIP',       '#8B5CF6', 1, id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1;
INSERT IGNORE INTO client_meta_options (type, label, color, sort_order, created_by)
  SELECT 'tag', 'Risk',      '#EF4444', 2, id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1;
INSERT IGNORE INTO client_meta_options (type, label, color, sort_order, created_by)
  SELECT 'tag', 'Long-term', '#14B8A6', 3, id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1;

-- Seed default contract_type values
INSERT IGNORE INTO client_meta_options (type, label, color, sort_order, created_by)
  SELECT 'contract_type', 'Monthly',   '#6366F1', 1, id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1;
INSERT IGNORE INTO client_meta_options (type, label, color, sort_order, created_by)
  SELECT 'contract_type', 'Quarterly', '#3B82F6', 2, id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1;
INSERT IGNORE INTO client_meta_options (type, label, color, sort_order, created_by)
  SELECT 'contract_type', 'Annual',    '#10B981', 3, id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1;
INSERT IGNORE INTO client_meta_options (type, label, color, sort_order, created_by)
  SELECT 'contract_type', 'Project',   '#F59E0B', 4, id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1;
