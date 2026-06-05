-- Agency OS — Employee Self-Service Migration
-- Creates: employee_field_change_requests, employee_field_permissions

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE 1: employee_field_change_requests
-- Stores requests raised by employees to change restricted fields.
-- Employee submits new value / doc with the request.
-- Admin validates old vs new and approves → change is applied directly.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_field_change_requests (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  uuid            VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  employee_id     INT NOT NULL,
  field_name      VARCHAR(100) NOT NULL,
  field_label     VARCHAR(150) NOT NULL,
  current_value   TEXT,
  requested_value TEXT NOT NULL,
  new_doc_url     VARCHAR(500),
  reason          TEXT NOT NULL,
  status          ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  reviewed_by     INT,
  review_note     TEXT,
  reviewed_at     DATETIME,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE 2: employee_field_permissions
-- Tracks active/revoked edit permissions per employee per field.
-- expires_at is always granted_at + 1 DAY (set by backend on approve).
-- A field is editable when: status='ACTIVE' AND expires_at > NOW() AND revoked_at IS NULL.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_field_permissions (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  uuid              VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  employee_id       INT NOT NULL,
  field_name        VARCHAR(100) NOT NULL,
  granted_by        INT NOT NULL,
  granted_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at        DATETIME NOT NULL,
  revoked_at        DATETIME,
  revoked_by        INT,
  change_request_id INT,
  status            ENUM('ACTIVE','EXPIRED','REVOKED') NOT NULL DEFAULT 'ACTIVE',
  FOREIGN KEY (employee_id)       REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (granted_by)        REFERENCES users(id),
  FOREIGN KEY (revoked_by)        REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (change_request_id) REFERENCES employee_field_change_requests(id) ON DELETE SET NULL
);
