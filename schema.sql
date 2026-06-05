-- Agency OS — Full Database Schema
-- Run this once on your MySQL server: mysql -u root -p < schema.sql

CREATE DATABASE IF NOT EXISTS ytp_os CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE ytp_os;

CREATE TABLE IF NOT EXISTS users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  uuid VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  name VARCHAR(200) NOT NULL,
  email VARCHAR(200) UNIQUE NOT NULL,
  password_hash VARCHAR(500) NOT NULL,
  role ENUM('SUPER_ADMIN','ADMIN','HR','TEAM_LEAD','EMPLOYEE','ACCOUNTANT') NOT NULL DEFAULT 'EMPLOYEE',
  status ENUM('ACTIVE','INACTIVE','SUSPENDED') NOT NULL DEFAULT 'ACTIVE',
  avatar_url VARCHAR(500),
  last_login_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS clients (
  id INT PRIMARY KEY AUTO_INCREMENT,
  uuid VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  company_name VARCHAR(300) NOT NULL,
  contact_person VARCHAR(200) NOT NULL,
  email VARCHAR(200),
  phone VARCHAR(30),
  address TEXT,
  gst_number VARCHAR(20),
  status ENUM('ACTIVE','PROSPECT','CHURNED','PAUSED') NOT NULL DEFAULT 'PROSPECT',
  contract_type ENUM('MONTHLY','ANNUAL','PROJECT') NOT NULL DEFAULT 'MONTHLY',
  monthly_fee DECIMAL(10,2),
  contract_start DATE,
  contract_end DATE,
  services JSON,
  notes TEXT,
  assigned_to INT,
  created_by INT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS client_credentials (
  id INT PRIMARY KEY AUTO_INCREMENT,
  client_id INT NOT NULL,
  platform VARCHAR(100) NOT NULL,
  username TEXT,
  password TEXT,
  url VARCHAR(500),
  notes TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS client_documents (
  id INT PRIMARY KEY AUTO_INCREMENT,
  client_id INT NOT NULL,
  name VARCHAR(300) NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  file_type VARCHAR(100) NOT NULL,
  uploaded_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS employees (
  id INT PRIMARY KEY AUTO_INCREMENT,
  uuid VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  user_id INT UNIQUE NOT NULL,
  employee_code VARCHAR(20) UNIQUE NOT NULL,
  department VARCHAR(100),
  designation VARCHAR(100),
  joining_date DATE NOT NULL,
  shift_start TIME NOT NULL DEFAULT '09:00:00',
  shift_end TIME NOT NULL DEFAULT '18:00:00',
  base_salary DECIMAL(10,2) NOT NULL DEFAULT 0,
  bank_name VARCHAR(100),
  bank_account TEXT,
  bank_ifsc VARCHAR(20),
  pan_number TEXT,
  emergency_contact VARCHAR(200),
  emergency_phone VARCHAR(20),
  status ENUM('ACTIVE','INACTIVE','TERMINATED') NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS employee_documents (
  id INT PRIMARY KEY AUTO_INCREMENT,
  employee_id INT NOT NULL,
  doc_type ENUM('OFFER_LETTER','CONTRACT','ID_PROOF','APPRAISAL','OTHER') NOT NULL,
  name VARCHAR(300) NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  uploaded_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS leave_balances (
  id INT PRIMARY KEY AUTO_INCREMENT,
  employee_id INT UNIQUE NOT NULL,
  year INT NOT NULL,
  casual_total INT NOT NULL DEFAULT 12,
  casual_used INT NOT NULL DEFAULT 0,
  sick_total INT NOT NULL DEFAULT 6,
  sick_used INT NOT NULL DEFAULT 0,
  paid_total INT NOT NULL DEFAULT 15,
  paid_used INT NOT NULL DEFAULT 0,
  comp_off INT NOT NULL DEFAULT 0,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tasks (
  id INT PRIMARY KEY AUTO_INCREMENT,
  uuid VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  title VARCHAR(500) NOT NULL,
  description TEXT,
  status ENUM('TODO','IN_PROGRESS','IN_REVIEW','DONE') NOT NULL DEFAULT 'TODO',
  priority ENUM('LOW','MEDIUM','HIGH','URGENT') NOT NULL DEFAULT 'MEDIUM',
  due_date DATE,
  client_id INT,
  assigned_to_id INT,
  assigned_by_id INT NOT NULL,
  parent_task_id INT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
  FOREIGN KEY (assigned_to_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (assigned_by_id) REFERENCES users(id),
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_comments (
  id INT PRIMARY KEY AUTO_INCREMENT,
  task_id INT NOT NULL,
  user_id INT NOT NULL,
  body TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS task_attachments (
  id INT PRIMARY KEY AUTO_INCREMENT,
  task_id INT NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  file_name VARCHAR(300) NOT NULL,
  uploaded_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

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

CREATE TABLE IF NOT EXISTS holidays (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  name       VARCHAR(200) NOT NULL,
  date       DATE NOT NULL UNIQUE,
  type       ENUM('NATIONAL','OPTIONAL','COMPANY') NOT NULL DEFAULT 'NATIONAL',
  created_by INT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS attendance_logs (
  id                INT PRIMARY KEY AUTO_INCREMENT,
  employee_id       INT NOT NULL,
  date              DATE NOT NULL,
  clock_in          DATETIME,
  clock_out         DATETIME,
  type              ENUM('PRESENT','HALF_DAY','ABSENT','LEAVE','COMP_OFF','HOLIDAY','WFH') NOT NULL DEFAULT 'PRESENT',
  late_minutes      INT NOT NULL DEFAULT 0,
  early_out_minutes INT NOT NULL DEFAULT 0,
  overtime_minutes  INT NOT NULL DEFAULT 0,
  work_minutes      INT,
  notes             TEXT,
  is_manual         TINYINT(1) NOT NULL DEFAULT 0,
  source            ENUM('WEB','MOBILE','MANUAL','BIOMETRIC') NOT NULL DEFAULT 'WEB',
  regularization_id INT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_emp_date (employee_id, date),
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);

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

CREATE TABLE IF NOT EXISTS leave_requests (
  id INT PRIMARY KEY AUTO_INCREMENT,
  uuid VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  employee_id INT NOT NULL,
  leave_type ENUM('CASUAL','SICK','PAID','COMP_OFF','EMERGENCY') NOT NULL,
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  days DECIMAL(5,1) NOT NULL,
  reason TEXT,
  status ENUM('PENDING','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  reviewed_by INT,
  review_note TEXT,
  reviewed_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS payroll_records (
  id INT PRIMARY KEY AUTO_INCREMENT,
  employee_id INT NOT NULL,
  month INT NOT NULL,
  year INT NOT NULL,
  base_salary DECIMAL(10,2) NOT NULL,
  working_days INT NOT NULL,
  present_days DECIMAL(5,1) NOT NULL,
  leave_days DECIMAL(5,1) NOT NULL DEFAULT 0,
  lop_days DECIMAL(5,1) NOT NULL DEFAULT 0,
  late_deduction DECIMAL(8,2) NOT NULL DEFAULT 0,
  overtime_amount DECIMAL(8,2) NOT NULL DEFAULT 0,
  bonus DECIMAL(8,2) NOT NULL DEFAULT 0,
  other_deduction DECIMAL(8,2) NOT NULL DEFAULT 0,
  gross_salary DECIMAL(10,2) NOT NULL,
  net_salary DECIMAL(10,2) NOT NULL,
  status ENUM('DRAFT','APPROVED','PAID') NOT NULL DEFAULT 'DRAFT',
  paid_at DATETIME,
  payslip_path VARCHAR(500),
  notes TEXT,
  generated_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_emp_month_year (employee_id, month, year),
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS invoices (
  id INT PRIMARY KEY AUTO_INCREMENT,
  uuid VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  invoice_number VARCHAR(30) UNIQUE NOT NULL,
  client_id INT NOT NULL,
  issue_date DATE NOT NULL,
  due_date DATE NOT NULL,
  subtotal DECIMAL(10,2) NOT NULL,
  gst_rate DECIMAL(4,2) NOT NULL DEFAULT 18,
  gst_amount DECIMAL(10,2) NOT NULL,
  total DECIMAL(10,2) NOT NULL,
  status ENUM('DRAFT','SENT','PAID','OVERDUE','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  paid_at DATETIME,
  pdf_path VARCHAR(500),
  notes TEXT,
  created_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INT PRIMARY KEY AUTO_INCREMENT,
  invoice_id INT NOT NULL,
  description VARCHAR(500) NOT NULL,
  quantity DECIMAL(8,2) NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspaces (
  id INT PRIMARY KEY AUTO_INCREMENT,
  uuid VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  name VARCHAR(200) NOT NULL,
  icon VARCHAR(10),
  color VARCHAR(7),
  created_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workspace_properties (
  id INT PRIMARY KEY AUTO_INCREMENT,
  workspace_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  type ENUM('TEXT','NUMBER','DATE','SELECT','MULTI_SELECT','URL','EMAIL','CHECKBOX','FILE') NOT NULL,
  options JSON,
  is_required TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspace_entries (
  id INT PRIMARY KEY AUTO_INCREMENT,
  uuid VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  workspace_id INT NOT NULL,
  title VARCHAR(300) NOT NULL,
  data JSON NOT NULL DEFAULT ('{}'),
  created_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notifications (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  type ENUM('LEAVE_REQUEST','TASK_DUE','RENEWAL','INVOICE_DUE','PAYROLL','GENERAL') NOT NULL,
  title VARCHAR(200) NOT NULL,
  body TEXT,
  link VARCHAR(300),
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id INT,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id INT,
  before_data JSON,
  after_data JSON,
  ip_address VARCHAR(45),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Default shift
INSERT IGNORE INTO shifts (name, start_time, end_time, grace_minutes, break_minutes, is_default)
VALUES ('General Shift', '09:00:00', '18:00:00', 15, 60, 1);

-- Default attendance policies
INSERT IGNORE INTO attendance_policies (key_name, value, label, description) VALUES
  ('late_deduction_per_minute', '0',   'Late Deduction Per Minute (₹)', 'Amount deducted per minute of late arrival (0 = disabled)'),
  ('auto_absent_after_hours',   '13',  'Auto-absent After Hours',       'Hours after shift start to auto-mark absent'),
  ('half_day_threshold_percent','50',  'Half Day Threshold (%)',         'Work % of shift below which marks as half-day'),
  ('overtime_threshold_minutes','30',  'Overtime Threshold (min)',       'Minutes after shift end before overtime counted'),
  ('grace_period_minutes',      '15',  'Grace Period (min)',             'Late arrival grace period before counting late minutes');

-- Super Admin seed (password: Admin@123)
INSERT IGNORE INTO users (uuid, name, email, password_hash, role, status)
VALUES (UUID(), 'Super Admin', 'youtoopreneur@gmail.com',
  '$2b$12$CrrCBCyGhkimdlEqeS1PR.gDFYEl5A72N2ni/CuO8N1cS.wDyHfqu', 'SUPER_ADMIN', 'ACTIVE');
