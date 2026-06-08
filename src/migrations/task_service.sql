-- Add service_id to tasks (links a task to a client_meta_options service entry)
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS service_id INT NULL,
  ADD CONSTRAINT fk_task_service
    FOREIGN KEY (service_id) REFERENCES client_meta_options(id) ON DELETE SET NULL;
