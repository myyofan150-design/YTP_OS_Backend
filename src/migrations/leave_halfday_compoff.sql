-- Migration: leave_halfday_compoff
-- Adds half-day leave fields to leave_requests and creates comp_off_requests table.
-- Safe to re-run: column-already-exists and table-already-exists errors are skipped by the runner.

ALTER TABLE leave_requests ADD COLUMN is_half_day TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE leave_requests ADD COLUMN half_day_slot ENUM('FIRST_HALF','SECOND_HALF') NULL DEFAULT NULL;

CREATE TABLE comp_off_requests (
  id           INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  uuid         VARCHAR(36)     NOT NULL,
  employee_id  INT             NOT NULL,
  worked_date  DATE            NOT NULL,
  reason       TEXT            NULL,
  status       ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  expires_at   DATE            NULL,
  reviewed_by  INT             NULL,
  review_note  VARCHAR(500)    NULL,
  reviewed_at  DATETIME        NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_comp_off_uuid (uuid),
  KEY idx_comp_off_employee (employee_id),
  KEY idx_comp_off_status (status),
  CONSTRAINT fk_comp_off_employee FOREIGN KEY (employee_id) REFERENCES employees (id)
);
