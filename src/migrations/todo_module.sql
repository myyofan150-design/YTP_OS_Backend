-- ─── TODO MODULE MIGRATION ────────────────────────────────────────────────────
-- Run via: npx ts-node src/migrations/run-todo-migration.ts

-- Table 1: todo_groups
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

-- Table 2: todo_lists
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

-- Table 3: todo_tasks
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
  INDEX idx_list (list_id),
  INDEX idx_assigned (assigned_to),
  INDEX idx_due_date (due_date),
  INDEX idx_status (status)
);

-- Table 4: todo_subtasks
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

-- Table 5: todo_attachments
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

-- Table 6: todo_notes
CREATE TABLE IF NOT EXISTS todo_notes (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  task_id    INT NOT NULL UNIQUE,
  content    TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES todo_tasks(id) ON DELETE CASCADE
);

-- Table 7: todo_activity
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
