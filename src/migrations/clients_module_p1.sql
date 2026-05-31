-- Clients Module — Piece 1: Missing fields + new tables
-- Run against: ytp_os

-- ── Add missing columns to clients ─────────────────────────────────────────

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS whatsapp VARCHAR(20) AFTER phone,
  ADD COLUMN IF NOT EXISTS website VARCHAR(500) AFTER whatsapp,
  ADD COLUMN IF NOT EXISTS client_tag ENUM('VIP','Risk','Long-term') AFTER website,
  ADD COLUMN IF NOT EXISTS country VARCHAR(100) AFTER client_tag,
  ADD COLUMN IF NOT EXISTS city VARCHAR(100) AFTER country,
  ADD COLUMN IF NOT EXISTS source ENUM('Lead','Manual','Import') DEFAULT 'Manual' AFTER city,
  ADD COLUMN IF NOT EXISTS total_contract_value DECIMAL(12,2) AFTER contract_type,
  ADD COLUMN IF NOT EXISTS last_contacted DATE AFTER total_contract_value,
  ADD COLUMN IF NOT EXISTS next_followup DATE AFTER last_contacted,
  ADD COLUMN IF NOT EXISTS meeting_datetime DATETIME AFTER next_followup,
  ADD COLUMN IF NOT EXISTS on_hold_reason TEXT AFTER notes,
  ADD COLUMN IF NOT EXISTS converted_from_lead_id INT AFTER on_hold_reason;

-- ── client_contacts ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS client_contacts (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  uuid       VARCHAR(36)  UNIQUE NOT NULL DEFAULT (UUID()),
  client_id  INT NOT NULL,
  name       VARCHAR(120) NOT NULL,
  email      VARCHAR(191),
  phone      VARCHAR(20),
  whatsapp   VARCHAR(20),
  role       VARCHAR(100),
  is_primary TINYINT(1)   NOT NULL DEFAULT 0,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

-- ── client_payments ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS client_payments (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  uuid         VARCHAR(36)    UNIQUE NOT NULL DEFAULT (UUID()),
  client_id    INT            NOT NULL,
  amount       DECIMAL(12,2)  NOT NULL,
  payment_mode ENUM('UPI','Net Banking','Cash','Cheque','Other') NOT NULL,
  payment_date DATE           NOT NULL,
  milestone    VARCHAR(200),
  notes        TEXT,
  recorded_by  INT            NOT NULL,
  created_at   DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);
