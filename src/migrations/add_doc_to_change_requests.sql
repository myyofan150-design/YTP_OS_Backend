-- Migration: add new_doc_url to employee_field_change_requests
-- Run this on existing deployments after the initial employee_self_service.sql migration.
-- Safe to re-run: ADD COLUMN will fail on duplicate, wrap in a stored proc if needed.

ALTER TABLE employee_field_change_requests
  ADD COLUMN new_doc_url VARCHAR(500) NULL AFTER requested_value;
