-- Add logo_url column to clients table
ALTER TABLE clients ADD COLUMN IF NOT EXISTS logo_url VARCHAR(500) DEFAULT NULL AFTER company_name;
