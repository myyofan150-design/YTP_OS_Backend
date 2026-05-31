-- leads_module.sql
-- Creates lead_meta_options, leads, and lead_services tables with seed data.
-- Safe to re-run: CREATE TABLE IF NOT EXISTS + INSERT IGNORE on (type, label).

CREATE TABLE IF NOT EXISTS lead_meta_options (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  uuid       VARCHAR(36)  UNIQUE NOT NULL DEFAULT (UUID()),
  type       ENUM('source', 'status', 'priority', 'service') NOT NULL,
  label      VARCHAR(100) NOT NULL,
  color      VARCHAR(7)   NOT NULL DEFAULT '#6366F1',
  sort_order INT          DEFAULT 0,
  created_at DATETIME     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_type_label (type, label),
  INDEX idx_type (type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS leads (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  uuid                    VARCHAR(36)   UNIQUE NOT NULL DEFAULT (UUID()),
  contact_person          VARCHAR(120)  NOT NULL,
  company_name            VARCHAR(200),
  email                   VARCHAR(191),
  phone                   VARCHAR(20),
  whatsapp                VARCHAR(20),
  industry                VARCHAR(100),
  country                 VARCHAR(100),
  city                    VARCHAR(100),
  website                 VARCHAR(500),
  source_id               INT,
  assigned_to             INT,
  status_id               INT,
  priority_id             INT,
  budget_min              DECIMAL(12,2),
  budget_max              DECIMAL(12,2),
  timeline                DATE,
  requirement_description TEXT,
  last_contacted          DATE,
  next_followup           DATE,
  meeting_datetime        DATETIME,
  converted               TINYINT(1)    DEFAULT 0,
  converted_client_id     INT,
  lost_reason             TEXT,
  created_by              INT           NOT NULL,
  created_at              DATETIME      DEFAULT CURRENT_TIMESTAMP,
  updated_at              DATETIME      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_status   (status_id),
  INDEX idx_priority (priority_id),
  INDEX idx_assigned (assigned_to),
  INDEX idx_followup (next_followup)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS lead_services (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  lead_id    INT NOT NULL,
  service_id INT NOT NULL,
  UNIQUE KEY uq_lead_service (lead_id, service_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Seed default meta options ──────────────────────────────────────────────────
-- INSERT IGNORE skips rows that collide on the (type, label) unique key.

INSERT IGNORE INTO lead_meta_options (uuid, type, label, color, sort_order) VALUES
  (UUID(), 'source', 'From Ads',      '#3B82F6', 1),
  (UUID(), 'source', 'Word of Mouth', '#10B981', 2),
  (UUID(), 'source', 'Referral',      '#F59E0B', 3),
  (UUID(), 'source', 'Instagram',     '#EC4899', 4),
  (UUID(), 'source', 'WhatsApp',      '#25D366', 5),
  (UUID(), 'source', 'Others',        '#6B7280', 6),

  (UUID(), 'status', 'New',           '#6366F1', 1),
  (UUID(), 'status', 'Contacted',     '#3B82F6', 2),
  (UUID(), 'status', 'Qualified',     '#8B5CF6', 3),
  (UUID(), 'status', 'Proposal Sent', '#F97316', 4),
  (UUID(), 'status', 'Negotiation',   '#F59E0B', 5),
  (UUID(), 'status', 'Won',           '#22C55E', 6),
  (UUID(), 'status', 'Lost',          '#EF4444', 7),

  (UUID(), 'priority', 'Cold',        '#94A3B8', 1),
  (UUID(), 'priority', 'Warm',        '#F59E0B', 2),
  (UUID(), 'priority', 'Hot',         '#EF4444', 3),
  (UUID(), 'priority', 'Done',        '#22C55E', 4),

  (UUID(), 'service', 'Website',      '#3B82F6', 1),
  (UUID(), 'service', 'Ads',          '#EC4899', 2),
  (UUID(), 'service', 'SEO',          '#10B981', 3),
  (UUID(), 'service', 'Social Media', '#8B5CF6', 4),
  (UUID(), 'service', 'Branding',     '#F97316', 5),
  (UUID(), 'service', 'Content',      '#F59E0B', 6),
  (UUID(), 'service', 'Others',       '#6B7280', 7);
