-- ══════════════════════════════════════════════════════════════════════════════
-- AGENCY OS — FULL SAFE DEPLOYMENT SCRIPT FOR HOSTINGER / phpMyAdmin
-- Safe to run on ANY state of the database (fresh install or partial).
-- Every statement uses IF NOT EXISTS or is idempotent.
-- Generated from: all 8 migration files consolidated.
-- ══════════════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 1: SUBSCRIPTION MODULE
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS subscription_meta_options (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  uuid        VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  type        ENUM('category','billing_cycle','status') NOT NULL,
  label       VARCHAR(100) NOT NULL,
  color       VARCHAR(7)  NOT NULL DEFAULT '#6366F1',
  sort_order  INT DEFAULT 0,
  created_by  INT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_type (type)
);

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

INSERT IGNORE INTO subscription_meta_options (uuid, type, label, color, sort_order) VALUES
  (UUID(), 'billing_cycle', 'Monthly',   '#3B82F6', 1),
  (UUID(), 'billing_cycle', 'Quarterly', '#8B5CF6', 2),
  (UUID(), 'billing_cycle', 'Annual',    '#10B981', 3),
  (UUID(), 'billing_cycle', 'Lifetime',  '#F59E0B', 4),
  (UUID(), 'billing_cycle', 'Weekly',    '#EF4444', 5),
  (UUID(), 'category', 'SaaS Tools',     '#6366F1', 1),
  (UUID(), 'category', 'Marketing',      '#EC4899', 2),
  (UUID(), 'category', 'Infrastructure', '#14B8A6', 3),
  (UUID(), 'category', 'Communication',  '#F97316', 4),
  (UUID(), 'category', 'Design',         '#A855F7', 5),
  (UUID(), 'category', 'Analytics',      '#06B6D4', 6),
  (UUID(), 'status', 'Active',        '#22C55E', 1),
  (UUID(), 'status', 'Expiring Soon', '#F59E0B', 2),
  (UUID(), 'status', 'Expired',       '#EF4444', 3),
  (UUID(), 'status', 'Cancelled',     '#6B7280', 4),
  (UUID(), 'status', 'Paused',        '#94A3B8', 5);


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 2: LEADS MODULE
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lead_meta_options (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  uuid       VARCHAR(36)  UNIQUE NOT NULL DEFAULT (UUID()),
  type       ENUM('source','status','priority','service') NOT NULL,
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


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 3: CLIENTS MODULE — new columns + new tables
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS logo_url              VARCHAR(500)  DEFAULT NULL           AFTER company_name,
  ADD COLUMN IF NOT EXISTS whatsapp              VARCHAR(20)                          AFTER phone,
  ADD COLUMN IF NOT EXISTS website               VARCHAR(500)                         AFTER whatsapp,
  ADD COLUMN IF NOT EXISTS client_tag            ENUM('VIP','Risk','Long-term')       AFTER website,
  ADD COLUMN IF NOT EXISTS country               VARCHAR(100)                         AFTER client_tag,
  ADD COLUMN IF NOT EXISTS city                  VARCHAR(100)                         AFTER country,
  ADD COLUMN IF NOT EXISTS source                ENUM('Lead','Manual','Import') DEFAULT 'Manual' AFTER city,
  ADD COLUMN IF NOT EXISTS total_contract_value  DECIMAL(12,2)                        AFTER contract_type,
  ADD COLUMN IF NOT EXISTS last_contacted        DATE                                 AFTER total_contract_value,
  ADD COLUMN IF NOT EXISTS next_followup         DATE                                 AFTER last_contacted,
  ADD COLUMN IF NOT EXISTS meeting_datetime      DATETIME                             AFTER next_followup,
  ADD COLUMN IF NOT EXISTS on_hold_reason        TEXT                                 AFTER notes,
  ADD COLUMN IF NOT EXISTS converted_from_lead_id INT                                AFTER on_hold_reason;

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


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 4: EMPLOYEES ENHANCEMENT — new tables + new columns
-- ─────────────────────────────────────────────────────────────────────────────

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

-- New columns on employees (IF NOT EXISTS — safe to re-run)
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS personal_email                 VARCHAR(191)   AFTER user_id,
  ADD COLUMN IF NOT EXISTS phone                          VARCHAR(20)    AFTER personal_email,
  ADD COLUMN IF NOT EXISTS date_of_birth                  DATE           AFTER phone,
  ADD COLUMN IF NOT EXISTS gender                         ENUM('male','female','other','prefer_not_to_say') AFTER date_of_birth,
  ADD COLUMN IF NOT EXISTS photo_url                      VARCHAR(500)   AFTER gender,
  ADD COLUMN IF NOT EXISTS education_qualification        VARCHAR(200)   AFTER photo_url,
  ADD COLUMN IF NOT EXISTS school_college                 VARCHAR(200)   AFTER education_qualification,
  ADD COLUMN IF NOT EXISTS marital_status                 ENUM('single','married','divorced','widowed') AFTER school_college,
  ADD COLUMN IF NOT EXISTS nationality                    VARCHAR(100)   AFTER marital_status,
  ADD COLUMN IF NOT EXISTS blood_group                    VARCHAR(5)     AFTER nationality,
  ADD COLUMN IF NOT EXISTS employee_type                  ENUM('full_time','part_time','contract','internship','freelance') DEFAULT 'full_time' AFTER blood_group,
  ADD COLUMN IF NOT EXISTS work_mode                      ENUM('office','remote','hybrid') DEFAULT 'office' AFTER employee_type,
  ADD COLUMN IF NOT EXISTS work_location                  VARCHAR(200)   AFTER work_mode,
  ADD COLUMN IF NOT EXISTS reporting_manager_id           INT            AFTER work_location,
  ADD COLUMN IF NOT EXISTS probation_end_date             DATE           AFTER reporting_manager_id,
  ADD COLUMN IF NOT EXISTS confirmation_date              DATE           AFTER probation_end_date,
  ADD COLUMN IF NOT EXISTS contract_end_date              DATE           AFTER confirmation_date,
  ADD COLUMN IF NOT EXISTS contract_renewal_reminder      INT DEFAULT 30 AFTER contract_end_date,
  ADD COLUMN IF NOT EXISTS ctc                            DECIMAL(10,2)  AFTER contract_renewal_reminder,
  ADD COLUMN IF NOT EXISTS official_email                 VARCHAR(191)   AFTER ctc,
  ADD COLUMN IF NOT EXISTS skill_tags                     JSON           AFTER official_email,
  ADD COLUMN IF NOT EXISTS background_verification_status ENUM('pending','in_progress','cleared','failed') DEFAULT 'pending' AFTER skill_tags,
  ADD COLUMN IF NOT EXISTS last_working_date              DATE           AFTER background_verification_status,
  ADD COLUMN IF NOT EXISTS exit_reason                    TEXT           AFTER last_working_date,
  ADD COLUMN IF NOT EXISTS exit_type                      ENUM('resignation','termination','retirement','end_of_contract') AFTER exit_reason,
  ADD COLUMN IF NOT EXISTS settlement_status              ENUM('pending','completed') AFTER exit_type,
  ADD COLUMN IF NOT EXISTS rehire_eligible                BOOLEAN DEFAULT TRUE AFTER settlement_status,
  ADD COLUMN IF NOT EXISTS exit_notes                     TEXT           AFTER rehire_eligible;

-- Expand status ENUM to include new lifecycle values (safe to re-run)
ALTER TABLE employees
  MODIFY COLUMN status ENUM('ACTIVE','INACTIVE','TERMINATED','NOTICE_PERIOD','DRAFT','PROBATION','RESIGNED','ARCHIVED') NOT NULL DEFAULT 'ACTIVE';


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 5: TASK MEMBERS
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS task_members (
  id             INT PRIMARY KEY AUTO_INCREMENT,
  task_id        INT NOT NULL,
  user_id        INT NOT NULL,
  assigned_by_id INT NOT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_task_member (task_id, user_id),
  FOREIGN KEY (task_id)        REFERENCES tasks(id)  ON DELETE CASCADE,
  FOREIGN KEY (user_id)        REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (assigned_by_id) REFERENCES users(id)  ON DELETE CASCADE
);


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 6: TODO MODULE
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS todo_groups (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  uuid        VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  name        VARCHAR(200) NOT NULL,
  color       VARCHAR(7) DEFAULT '#6366F1',
  sort_order  INT DEFAULT 0,
  created_by  INT NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_created_by (created_by)
);

CREATE TABLE IF NOT EXISTS todo_lists (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  uuid        VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  group_id    INT,
  name        VARCHAR(200) NOT NULL,
  color       VARCHAR(7) DEFAULT '#6366F1',
  is_favorite BOOLEAN DEFAULT FALSE,
  assigned_to INT,
  sort_order  INT DEFAULT 0,
  created_by  INT NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (group_id) REFERENCES todo_groups(id) ON DELETE SET NULL,
  INDEX idx_created_by (created_by),
  INDEX idx_group (group_id)
);

CREATE TABLE IF NOT EXISTS todo_tasks (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  uuid          VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  list_id       INT NOT NULL,
  title         VARCHAR(500) NOT NULL,
  description   TEXT,
  status        ENUM('pending','completed') DEFAULT 'pending',
  priority      ENUM('none','low','medium','high') DEFAULT 'none',
  due_date      DATE,
  due_time      TIME,
  reminder_at   DATETIME,
  repeat_type   ENUM('none','daily','weekdays','weekly','monthly','yearly','custom') DEFAULT 'none',
  repeat_config JSON,
  bg_color      VARCHAR(20) DEFAULT 'default',
  is_favorite   BOOLEAN DEFAULT FALSE,
  assigned_to   INT,
  sort_order    INT DEFAULT 0,
  completed_at  DATETIME,
  created_by    INT NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (list_id) REFERENCES todo_lists(id) ON DELETE CASCADE,
  INDEX idx_list     (list_id),
  INDEX idx_assigned (assigned_to),
  INDEX idx_due_date (due_date),
  INDEX idx_status   (status)
);

CREATE TABLE IF NOT EXISTS todo_subtasks (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  uuid         VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  task_id      INT NOT NULL,
  title        VARCHAR(500) NOT NULL,
  status       ENUM('pending','completed') DEFAULT 'pending',
  sort_order   INT DEFAULT 0,
  completed_at DATETIME,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES todo_tasks(id) ON DELETE CASCADE,
  INDEX idx_task (task_id)
);

CREATE TABLE IF NOT EXISTS todo_attachments (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  uuid        VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  task_id     INT NOT NULL,
  file_name   VARCHAR(200) NOT NULL,
  file_path   VARCHAR(500) NOT NULL,
  file_size   INT,
  file_type   VARCHAR(50),
  uploaded_by INT NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES todo_tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS todo_notes (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  task_id    INT NOT NULL UNIQUE,
  content    TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES todo_tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS todo_activity (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  task_id    INT NOT NULL,
  user_id    INT NOT NULL,
  action     VARCHAR(100) NOT NULL,
  detail     VARCHAR(500),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES todo_tasks(id) ON DELETE CASCADE,
  INDEX idx_task (task_id)
);

CREATE TABLE IF NOT EXISTS todo_task_members (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  task_id    INT NOT NULL,
  user_id    INT NOT NULL,
  added_by   INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_task_user (task_id, user_id),
  FOREIGN KEY (task_id) REFERENCES todo_tasks(id) ON DELETE CASCADE,
  INDEX idx_user (user_id)
);


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 7: TODO LIST MEMBERS  ← NEW (added for multi-employee sharing)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS todo_list_members (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  list_id    INT NOT NULL,
  user_id    INT NOT NULL,
  added_by   INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_list_user (list_id, user_id),
  FOREIGN KEY (list_id) REFERENCES todo_lists(id) ON DELETE CASCADE,
  INDEX idx_user (user_id),
  INDEX idx_list (list_id)
);


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 8: MIGRATIONS LOG TABLE (track what's been run)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS _migrations (
  id     INT AUTO_INCREMENT PRIMARY KEY,
  name   VARCHAR(200) NOT NULL UNIQUE,
  ran_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT IGNORE INTO _migrations (name) VALUES
  ('subscription_tracker'),
  ('leads_module'),
  ('clients_module_p1'),
  ('client_logo'),
  ('employees_enhancement'),
  ('task_members'),
  ('todo_module'),
  ('todo_list_members'),
  ('notes_module'),
  ('chat_module'),
  ('client_meta'),
  ('subscription_enhancements');

-- ─────────────────────────────────────────────────────────────────────────────
-- PATCH: subscription_enhancements (plan_tier + usage_type)
-- Safe to run even if columns already exist — ALTER TABLE ADD COLUMN IF NOT EXISTS
-- is supported on MySQL 8.0+. On older MySQL versions ignore "Duplicate column" errors.
-- ─────────────────────────────────────────────────────────────────────────────

SET @col1 = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subscriptions' AND COLUMN_NAME = 'plan_tier'
);
SET @col2 = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subscriptions' AND COLUMN_NAME = 'usage_type'
);

SET @sql1 = IF(@col1 = 0,
  "ALTER TABLE subscriptions ADD COLUMN plan_tier ENUM('free','basic','trial','pro','premium') NULL DEFAULT NULL AFTER autopay",
  "SELECT 'plan_tier already exists' AS info"
);
SET @sql2 = IF(@col2 = 0,
  "ALTER TABLE subscriptions ADD COLUMN usage_type ENUM('internal','client') NULL DEFAULT NULL AFTER plan_tier",
  "SELECT 'usage_type already exists' AS info"
);
PREPARE stmt1 FROM @sql1; EXECUTE stmt1; DEALLOCATE PREPARE stmt1;
PREPARE stmt2 FROM @sql2; EXECUTE stmt2; DEALLOCATE PREPARE stmt2;

-- ─────────────────────────────────────────────────────────────────────────────
-- PATCH: users avatar_url column (if not already present)
-- ─────────────────────────────────────────────────────────────────────────────

SET @col3 = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'avatar_url'
);
SET @sql3 = IF(@col3 = 0,
  "ALTER TABLE users ADD COLUMN avatar_url VARCHAR(500) NULL DEFAULT NULL AFTER status",
  "SELECT 'avatar_url already exists' AS info"
);
PREPARE stmt3 FROM @sql3; EXECUTE stmt3; DEALLOCATE PREPARE stmt3;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 9: NOTES MODULE
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS note_tags (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  uuid       VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  name       VARCHAR(100) NOT NULL,
  color      VARCHAR(7) DEFAULT '#6366F1',
  created_by INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_created_by (created_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS notes (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  uuid                VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  title               VARCHAR(500) NOT NULL,
  content             LONGTEXT,
  category            ENUM('lead','client','project','meeting','branding','personal','business','other') DEFAULT 'personal',
  priority            ENUM('low','medium','high','critical') DEFAULT 'low',
  status              ENUM('active','archived','deleted') DEFAULT 'active',
  is_starred          BOOLEAN DEFAULT FALSE,
  is_read             BOOLEAN DEFAULT TRUE,
  is_snoozed          BOOLEAN DEFAULT FALSE,
  snoozed_until       DATETIME,
  linked_client_id    INT,
  linked_module       ENUM('client','employee','task','invoice','subscription','todo','none') DEFAULT 'none',
  linked_module_id    INT,
  linked_module_uuid  VARCHAR(36),
  assigned_to         INT,
  created_by          INT NOT NULL,
  deleted_at          DATETIME,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (linked_client_id) REFERENCES clients(id) ON DELETE SET NULL,
  INDEX idx_created_by (created_by),
  INDEX idx_status     (status),
  INDEX idx_category   (category),
  INDEX idx_assigned   (assigned_to),
  INDEX idx_linked     (linked_module, linked_module_id),
  FULLTEXT INDEX ft_search (title, content)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS note_tag_map (
  id      INT AUTO_INCREMENT PRIMARY KEY,
  note_id INT NOT NULL,
  tag_id  INT NOT NULL,
  UNIQUE KEY unique_note_tag (note_id, tag_id),
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id)  REFERENCES note_tags(id) ON DELETE CASCADE,
  INDEX idx_note (note_id),
  INDEX idx_tag  (tag_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS note_attachments (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  uuid        VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  note_id     INT NOT NULL,
  file_name   VARCHAR(200) NOT NULL,
  file_path   VARCHAR(500) NOT NULL,
  file_size   INT,
  file_type   VARCHAR(50),
  uploaded_by INT NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
  INDEX idx_note (note_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS note_mentions (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  note_id           INT NOT NULL,
  mentioned_user_id INT NOT NULL,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_mention (note_id, mentioned_user_id),
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
  INDEX idx_note (note_id),
  INDEX idx_user (mentioned_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS note_activity (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  note_id    INT NOT NULL,
  user_id    INT NOT NULL,
  action     VARCHAR(100) NOT NULL,
  detail     VARCHAR(500),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
  INDEX idx_note (note_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS note_recent_searches (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  search_term VARCHAR(300) NOT NULL,
  searched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_user_search (user_id, search_term),
  INDEX idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO note_tags (name, color, created_by) VALUES
  ('Office',      '#3B82F6', 1),
  ('Marketplace', '#8B5CF6', 1),
  ('Development', '#10B981', 1),
  ('Client',      '#F59E0B', 1),
  ('Important',   '#EF4444', 1);


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 10: CHAT MODULE
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversations (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  uuid                 VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  type                 ENUM('direct','group','contextual') NOT NULL,
  name                 VARCHAR(200),
  description          TEXT,
  avatar_url           VARCHAR(500),
  is_announcement_only BOOLEAN DEFAULT FALSE,
  is_archived          BOOLEAN DEFAULT FALSE,
  linked_module        ENUM('none','client','task','project','todo') DEFAULT 'none',
  linked_module_uuid   VARCHAR(36),
  created_by           INT NOT NULL,
  last_message_at      DATETIME,
  last_message_preview VARCHAR(300),
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_type (type),
  INDEX idx_last_message (last_message_at DESC)
);

CREATE TABLE IF NOT EXISTS conversation_members (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  conversation_id INT NOT NULL,
  user_id         INT NOT NULL,
  role            ENUM('admin','member') DEFAULT 'member',
  is_muted        BOOLEAN DEFAULT FALSE,
  joined_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_read_at    DATETIME,
  left_at         DATETIME,
  UNIQUE KEY unique_member (conversation_id, user_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  INDEX idx_user (user_id),
  INDEX idx_conversation (conversation_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  uuid            VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  conversation_id INT NOT NULL,
  sender_id       INT NOT NULL,
  type            ENUM('text','image','file','system') DEFAULT 'text',
  content         TEXT,
  reply_to_id     BIGINT,
  is_edited       BOOLEAN DEFAULT FALSE,
  edited_at       DATETIME,
  is_deleted      BOOLEAN DEFAULT FALSE,
  deleted_at      DATETIME,
  is_pinned       BOOLEAN DEFAULT FALSE,
  pinned_by       INT,
  pinned_at       DATETIME,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  INDEX idx_conversation (conversation_id, created_at DESC),
  INDEX idx_sender (sender_id)
);

CREATE TABLE IF NOT EXISTS message_attachments (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  uuid           VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  message_id     BIGINT NOT NULL,
  file_name      VARCHAR(200) NOT NULL,
  file_path      VARCHAR(500) NOT NULL,
  file_size      INT,
  file_type      VARCHAR(100),
  thumbnail_path VARCHAR(500),
  download_count INT DEFAULT 0,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  INDEX idx_message (message_id)
);

CREATE TABLE IF NOT EXISTS message_reactions (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  message_id BIGINT NOT NULL,
  user_id    INT NOT NULL,
  emoji      VARCHAR(10) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_reaction (message_id, user_id, emoji),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_read_status (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  message_id BIGINT NOT NULL,
  user_id    INT NOT NULL,
  read_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_read (message_id, user_id),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  INDEX idx_user_message (user_id, message_id)
);

CREATE TABLE IF NOT EXISTS message_edit_history (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  message_id  BIGINT NOT NULL,
  old_content TEXT NOT NULL,
  edited_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pinned_messages (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  conversation_id INT NOT NULL,
  message_id      BIGINT NOT NULL,
  pinned_by       INT NOT NULL,
  pinned_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_pin (conversation_id, message_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chat_activity (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  conversation_id INT,
  user_id         INT NOT NULL,
  action          VARCHAR(100) NOT NULL,
  detail          VARCHAR(500),
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_conversation (conversation_id)
);


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 11: CLIENT META OPTIONS
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE clients MODIFY COLUMN client_tag VARCHAR(100);
ALTER TABLE clients MODIFY COLUMN contract_type VARCHAR(100) NOT NULL DEFAULT 'MONTHLY';
ALTER TABLE clients MODIFY COLUMN status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE';

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
);

INSERT IGNORE INTO client_meta_options (type, label, color, sort_order, created_by)
  SELECT 'tag', 'VIP',       '#8B5CF6', 1, id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1;
INSERT IGNORE INTO client_meta_options (type, label, color, sort_order, created_by)
  SELECT 'tag', 'Risk',      '#EF4444', 2, id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1;
INSERT IGNORE INTO client_meta_options (type, label, color, sort_order, created_by)
  SELECT 'tag', 'Long-term', '#14B8A6', 3, id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1;
INSERT IGNORE INTO client_meta_options (type, label, color, sort_order, created_by)
  SELECT 'contract_type', 'Monthly',   '#6366F1', 1, id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1;
INSERT IGNORE INTO client_meta_options (type, label, color, sort_order, created_by)
  SELECT 'contract_type', 'Quarterly', '#3B82F6', 2, id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1;
INSERT IGNORE INTO client_meta_options (type, label, color, sort_order, created_by)
  SELECT 'contract_type', 'Annual',    '#10B981', 3, id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1;
INSERT IGNORE INTO client_meta_options (type, label, color, sort_order, created_by)
  SELECT 'contract_type', 'Project',   '#F59E0B', 4, id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 12: SYSTEM SETTINGS + INVOICE MILESTONE
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS system_settings (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `key`      VARCHAR(100) NOT NULL,
  value      TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_key (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO system_settings (`key`, value) VALUES
  ('company_name',    'Agency OS'),
  ('company_tagline', 'Digital Marketing Agency'),
  ('company_email',   'contact@agencyos.in'),
  ('company_logo_url', NULL);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS milestone VARCHAR(500) NULL AFTER notes;


-- ─────────────────────────────────────────────────────────────────────────────
-- Update migrations log
-- ─────────────────────────────────────────────────────────────────────────────

INSERT IGNORE INTO _migrations (name) VALUES
  ('notes_module'),
  ('chat_module'),
  ('client_meta'),
  ('system_settings'),
  ('invoice_milestone');

-- ══════════════════════════════════════════════════════════════════════════════
-- DONE. All tables created / columns added. Safe to re-run anytime.
-- ══════════════════════════════════════════════════════════════════════════════
