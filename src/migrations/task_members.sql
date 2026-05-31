-- task_members: many-to-many between tasks and users for multi-member assignment
-- Run: mysql -u root -p ytp_os < src/migrations/task_members.sql

CREATE TABLE IF NOT EXISTS task_members (
  id INT PRIMARY KEY AUTO_INCREMENT,
  task_id INT NOT NULL,
  user_id INT NOT NULL,
  assigned_by_id INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_task_member (task_id, user_id),
  FOREIGN KEY (task_id)       REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)       REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_by_id) REFERENCES users(id) ON DELETE CASCADE
);
