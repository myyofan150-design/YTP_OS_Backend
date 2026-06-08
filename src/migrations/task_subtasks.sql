-- Migration: task_subtasks
-- Lightweight subtask records scoped to a parent task (replaces parent_task_id self-join)

CREATE TABLE IF NOT EXISTS task_subtasks (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  uuid         VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  task_id      INT NOT NULL,
  title        VARCHAR(500) NOT NULL,
  status       ENUM('TODO','DONE') DEFAULT 'TODO',
  sort_order   INT DEFAULT 0,
  completed_at DATETIME,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  INDEX idx_task (task_id)
);
