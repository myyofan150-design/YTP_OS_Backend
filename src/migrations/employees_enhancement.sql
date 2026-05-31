-- Agency OS — Employee Enhancement Migration
-- Run via: npx ts-node src/migrations/run-employees-migration.ts
-- MySQL 8 compatible. CREATE TABLE uses IF NOT EXISTS.
-- ALTER TABLE: runner catches error 1060 (duplicate column) and treats as skip.

-- The connection pool in db.ts is already configured for ytp_os.
-- No USE statement needed here.

-- ────────────────────────────────────────────────────────────────────────────
-- TABLE 1: employee_addresses
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_addresses (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  flat_door   VARCHAR(100),
  street      VARCHAR(200),
  city        VARCHAR(100),
  pin_code    VARCHAR(10),
  state       VARCHAR(100),
  country     VARCHAR(100) DEFAULT 'India',
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);

-- ────────────────────────────────────────────────────────────────────────────
-- TABLE 2: employee_salary_components
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_salary_components (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  employee_id    INT NOT NULL,
  component_type ENUM('earning','deduction') NOT NULL,
  name           VARCHAR(100) NOT NULL,
  amount         DECIMAL(10,2) NOT NULL DEFAULT 0,
  is_mandatory   BOOLEAN DEFAULT FALSE,
  is_custom      BOOLEAN DEFAULT FALSE,
  sort_order     INT DEFAULT 0,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);

-- ────────────────────────────────────────────────────────────────────────────
-- TABLE 3: employee_bank_details
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_bank_details (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  employee_id          INT NOT NULL UNIQUE,
  bank_name            VARCHAR(100),
  account_number       TEXT,
  account_holder_name  VARCHAR(200),
  ifsc_code            VARCHAR(20),
  pan_number           TEXT,
  aadhaar_number       TEXT,
  uan_number           VARCHAR(50),
  esic_number          VARCHAR(50),
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);

-- ────────────────────────────────────────────────────────────────────────────
-- TABLE 4: employee_emergency_contacts
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_emergency_contacts (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  employee_id   INT NOT NULL,
  contact_order INT DEFAULT 1,
  name          VARCHAR(120) NOT NULL,
  relationship  VARCHAR(50),
  phone         VARCHAR(20) NOT NULL,
  email         VARCHAR(191),
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);

-- ────────────────────────────────────────────────────────────────────────────
-- TABLE 5: employee_agreements
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_agreements (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  uuid           VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  employee_id    INT NOT NULL,
  agreement_type ENUM('offer_letter','appointment_letter','nda','employment_agreement','leave_policy','it_policy','code_of_conduct','other') NOT NULL,
  name           VARCHAR(200) NOT NULL,
  file_path      VARCHAR(500),
  version        VARCHAR(20) DEFAULT 'v1',
  signed_at      DATE,
  uploaded_by    INT,
  notes          TEXT,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);

-- ────────────────────────────────────────────────────────────────────────────
-- TABLE 6: employee_status_history
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_status_history (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  old_status  VARCHAR(50),
  new_status  VARCHAR(50) NOT NULL,
  changed_by  INT,
  reason      TEXT,
  changed_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);

-- ────────────────────────────────────────────────────────────────────────────
-- TABLE 7: employee_assets
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_assets (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  uuid          VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  employee_id   INT NOT NULL,
  asset_name    VARCHAR(200) NOT NULL,
  asset_type    VARCHAR(100),
  assigned_date DATE,
  return_date   DATE,
  serial_number VARCHAR(200),
  notes         TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);

-- ────────────────────────────────────────────────────────────────────────────
-- ALTER employees: add new columns
-- NOTE: MySQL 8 does not support ADD COLUMN IF NOT EXISTS.
--       The migration runner catches error 1060 (ER_DUP_FIELDNAME) and skips.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE employees ADD COLUMN personal_email VARCHAR(191) AFTER user_id;
ALTER TABLE employees ADD COLUMN phone VARCHAR(20) AFTER personal_email;
ALTER TABLE employees ADD COLUMN date_of_birth DATE AFTER phone;
ALTER TABLE employees ADD COLUMN gender ENUM('male','female','other','prefer_not_to_say') AFTER date_of_birth;
ALTER TABLE employees ADD COLUMN photo_url VARCHAR(500) AFTER gender;
ALTER TABLE employees ADD COLUMN education_qualification VARCHAR(200) AFTER photo_url;
ALTER TABLE employees ADD COLUMN school_college VARCHAR(200) AFTER education_qualification;
ALTER TABLE employees ADD COLUMN marital_status ENUM('single','married','divorced','widowed') AFTER school_college;
ALTER TABLE employees ADD COLUMN nationality VARCHAR(100) AFTER marital_status;
ALTER TABLE employees ADD COLUMN blood_group VARCHAR(5) AFTER nationality;
ALTER TABLE employees ADD COLUMN employee_type ENUM('full_time','part_time','contract','internship','freelance') DEFAULT 'full_time' AFTER blood_group;
ALTER TABLE employees ADD COLUMN work_mode ENUM('office','remote','hybrid') DEFAULT 'office' AFTER employee_type;
ALTER TABLE employees ADD COLUMN work_location VARCHAR(200) AFTER work_mode;
ALTER TABLE employees ADD COLUMN reporting_manager_id INT AFTER work_location;
ALTER TABLE employees ADD COLUMN probation_end_date DATE AFTER reporting_manager_id;
ALTER TABLE employees ADD COLUMN confirmation_date DATE AFTER probation_end_date;
ALTER TABLE employees ADD COLUMN contract_end_date DATE AFTER confirmation_date;
ALTER TABLE employees ADD COLUMN contract_renewal_reminder INT DEFAULT 30 AFTER contract_end_date;
ALTER TABLE employees ADD COLUMN ctc DECIMAL(10,2) AFTER contract_renewal_reminder;
ALTER TABLE employees ADD COLUMN official_email VARCHAR(191) AFTER ctc;
ALTER TABLE employees ADD COLUMN skill_tags JSON AFTER official_email;
ALTER TABLE employees ADD COLUMN background_verification_status ENUM('pending','in_progress','cleared','failed') DEFAULT 'pending' AFTER skill_tags;
ALTER TABLE employees ADD COLUMN last_working_date DATE AFTER background_verification_status;
ALTER TABLE employees ADD COLUMN exit_reason TEXT AFTER last_working_date;
ALTER TABLE employees ADD COLUMN exit_type ENUM('resignation','termination','retirement','end_of_contract') AFTER exit_reason;
ALTER TABLE employees ADD COLUMN settlement_status ENUM('pending','completed') AFTER exit_type;
ALTER TABLE employees ADD COLUMN rehire_eligible BOOLEAN DEFAULT TRUE AFTER settlement_status;
ALTER TABLE employees ADD COLUMN exit_notes TEXT AFTER rehire_eligible;

-- ────────────────────────────────────────────────────────────────────────────
-- Expand status ENUM to include new lifecycle values
-- Current: ACTIVE, INACTIVE, TERMINATED
-- Added:   NOTICE_PERIOD, DRAFT, PROBATION, RESIGNED, ARCHIVED
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE employees MODIFY COLUMN status ENUM('ACTIVE','INACTIVE','TERMINATED','NOTICE_PERIOD','DRAFT','PROBATION','RESIGNED','ARCHIVED') NOT NULL DEFAULT 'ACTIVE';
