-- Attendance Module V2 Migration
-- Run once: mysql -u root -p ytp_os < 002_attendance_v2.sql

USE ytp_os;

-- ─── 1. Shifts ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shifts (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  name          VARCHAR(100) NOT NULL,
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  grace_minutes INT NOT NULL DEFAULT 15,
  break_minutes INT NOT NULL DEFAULT 60,
  is_overnight  TINYINT(1) NOT NULL DEFAULT 0,
  is_default    TINYINT(1) NOT NULL DEFAULT 0,
  created_by    INT,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- ─── 2. Holidays ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS holidays (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  name       VARCHAR(200) NOT NULL,
  date       DATE NOT NULL UNIQUE,
  type       ENUM('NATIONAL','OPTIONAL','COMPANY') NOT NULL DEFAULT 'NATIONAL',
  created_by INT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- ─── 3. Attendance Regularization Requests ───────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance_regularization_requests (
  id                  INT PRIMARY KEY AUTO_INCREMENT,
  uuid                VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  employee_id         INT NOT NULL,
  date                DATE NOT NULL,
  requested_clock_in  TIME,
  requested_clock_out TIME,
  requested_type      ENUM('PRESENT','HALF_DAY','WFH') NOT NULL DEFAULT 'PRESENT',
  reason              TEXT NOT NULL,
  status              ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  reviewed_by         INT,
  review_note         VARCHAR(500),
  reviewed_at         DATETIME,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);

-- ─── 4. WFH Requests ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wfh_requests (
  id          INT PRIMARY KEY AUTO_INCREMENT,
  uuid        VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  employee_id INT NOT NULL,
  from_date   DATE NOT NULL,
  to_date     DATE NOT NULL,
  days        DECIMAL(4,1) NOT NULL DEFAULT 1,
  reason      TEXT,
  status      ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  reviewed_by INT,
  review_note VARCHAR(500),
  reviewed_at DATETIME,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);

-- ─── 5. Attendance Policies ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance_policies (
  id          INT PRIMARY KEY AUTO_INCREMENT,
  key_name    VARCHAR(100) UNIQUE NOT NULL,
  value       VARCHAR(500) NOT NULL,
  label       VARCHAR(200),
  description TEXT,
  updated_by  INT,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

-- ─── 6. Extend attendance_logs ────────────────────────────────────────────────
ALTER TABLE attendance_logs
  MODIFY COLUMN type ENUM('PRESENT','HALF_DAY','ABSENT','LEAVE','COMP_OFF','HOLIDAY','WFH') NOT NULL DEFAULT 'PRESENT';

ALTER TABLE attendance_logs
  ADD COLUMN source            ENUM('WEB','MOBILE','MANUAL','BIOMETRIC') NOT NULL DEFAULT 'WEB' AFTER is_manual,
  ADD COLUMN regularization_id INT NULL AFTER source;

-- ─── 7. Seed default shift ───────────────────────────────────────────────────
INSERT IGNORE INTO shifts (name, start_time, end_time, grace_minutes, break_minutes, is_default)
VALUES ('General Shift', '09:00:00', '18:00:00', 15, 60, 1);

-- ─── 8. Seed default policies ────────────────────────────────────────────────
INSERT IGNORE INTO attendance_policies (key_name, value, label, description) VALUES
  ('late_deduction_per_minute', '0',   'Late Deduction Per Minute (₹)', 'Amount deducted per minute of late arrival (0 = no deduction)'),
  ('auto_absent_after_hours',   '13',  'Auto-absent After Hours',       'Hours after shift start to auto-mark absent if no clock-in'),
  ('half_day_threshold_percent','50',  'Half Day Threshold (%)',         'Work % of shift below which marks as half-day'),
  ('overtime_threshold_minutes','30',  'Overtime Threshold (min)',       'Minutes after shift end before overtime is counted'),
  ('grace_period_minutes',      '15',  'Grace Period (min)',             'Late arrival grace period before counting late minutes');
