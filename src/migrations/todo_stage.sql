-- Add stage column to todo_tasks
-- stage tracks which kanban column the task belongs to, independent of priority

ALTER TABLE todo_tasks
  ADD COLUMN IF NOT EXISTS stage ENUM('todo','inprogress') NOT NULL DEFAULT 'inprogress';

-- Migrate existing data: high-priority pending tasks → 'todo', everything else → 'inprogress'
UPDATE todo_tasks SET stage = 'todo'      WHERE priority = 'high'   AND status = 'pending';
UPDATE todo_tasks SET stage = 'inprogress' WHERE priority != 'high' AND status = 'pending';
