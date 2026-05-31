-- ─── TODO LIST MEMBERS MIGRATION ─────────────────────────────────────────────
-- Adds many-to-many sharing: a list can be assigned to multiple employees.
-- Run via: npx ts-node src/migrations/run-todo-list-members-migration.ts

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
