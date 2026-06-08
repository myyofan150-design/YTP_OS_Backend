-- Client User Migration
-- Run once: mysql -u root -p ytp_os < 003_client_user.sql

USE ytp_os;

-- Add CLIENT to users.role enum
ALTER TABLE users
  MODIFY COLUMN role ENUM('SUPER_ADMIN','ADMIN','HR','TEAM_LEAD','EMPLOYEE','ACCOUNTANT','CLIENT') NOT NULL DEFAULT 'EMPLOYEE';

-- Link a user account to a client record (nullable — only set for CLIENT role)
ALTER TABLE users
  ADD COLUMN client_id INT NULL AFTER role,
  ADD CONSTRAINT fk_users_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
