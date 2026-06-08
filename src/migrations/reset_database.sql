-- ══════════════════════════════════════════════════════════════════════════════
-- AGENCY OS — DATABASE RESET SCRIPT  (re-generated 2026-06-08)
-- Wipes ALL data, resets AUTO_INCREMENT, then seeds:
--   • One SUPER_ADMIN: youtoopreneur@gmail.com / Admin@123
--   • All reference/lookup data
--
-- HOW TO RUN:
--   phpMyAdmin → select your DB → SQL tab → paste → Go
--   OR: mysql -u <user> -p <dbname> < reset_database.sql --force
--
-- ⚠️  IRREVERSIBLE — every row in every table will be deleted.
-- ══════════════════════════════════════════════════════════════════════════════

SET FOREIGN_KEY_CHECKS = 0;

-- ─── Chat ─────────────────────────────────────────────────────────────────────
TRUNCATE TABLE message_edit_history;
TRUNCATE TABLE message_reactions;
TRUNCATE TABLE message_read_status;
TRUNCATE TABLE message_attachments;
TRUNCATE TABLE pinned_messages;
TRUNCATE TABLE chat_activity;
TRUNCATE TABLE conversation_members;
TRUNCATE TABLE messages;
TRUNCATE TABLE conversations;

-- ─── Notes ────────────────────────────────────────────────────────────────────
TRUNCATE TABLE note_recent_searches;
TRUNCATE TABLE note_activity;
TRUNCATE TABLE note_mentions;
TRUNCATE TABLE note_tag_map;
TRUNCATE TABLE note_attachments;
TRUNCATE TABLE notes;
TRUNCATE TABLE note_tags;

-- ─── Todo ─────────────────────────────────────────────────────────────────────
TRUNCATE TABLE todo_group_members;
TRUNCATE TABLE todo_activity;
TRUNCATE TABLE todo_task_members;
TRUNCATE TABLE todo_list_members;
TRUNCATE TABLE todo_subtasks;
TRUNCATE TABLE todo_attachments;
TRUNCATE TABLE todo_notes;
TRUNCATE TABLE todo_tasks;
TRUNCATE TABLE todo_lists;
TRUNCATE TABLE todo_groups;

-- ─── Tasks ────────────────────────────────────────────────────────────────────
TRUNCATE TABLE task_subtasks;
TRUNCATE TABLE task_comments;
TRUNCATE TABLE task_attachments;
TRUNCATE TABLE task_members;
TRUNCATE TABLE tasks;

-- ─── Leads ────────────────────────────────────────────────────────────────────
TRUNCATE TABLE lead_services;
TRUNCATE TABLE leads;
TRUNCATE TABLE lead_meta_options;

-- ─── Employees ────────────────────────────────────────────────────────────────
TRUNCATE TABLE employee_field_change_requests;
TRUNCATE TABLE employee_field_permissions;
TRUNCATE TABLE employee_status_history;
TRUNCATE TABLE employee_assets;
TRUNCATE TABLE employee_agreements;
TRUNCATE TABLE employee_emergency_contacts;
TRUNCATE TABLE employee_bank_details;
TRUNCATE TABLE employee_salary_components;
TRUNCATE TABLE employee_addresses;
TRUNCATE TABLE employee_documents;

-- ─── Attendance & Leave ───────────────────────────────────────────────────────
TRUNCATE TABLE attendance_regularization_requests;
TRUNCATE TABLE wfh_requests;
TRUNCATE TABLE comp_off_requests;
TRUNCATE TABLE attendance_policies;
TRUNCATE TABLE attendance_logs;
TRUNCATE TABLE leave_balances;
TRUNCATE TABLE leave_requests;
TRUNCATE TABLE payroll_records;
TRUNCATE TABLE shifts;
TRUNCATE TABLE holidays;

-- ─── Subscriptions ────────────────────────────────────────────────────────────
TRUNCATE TABLE subscriptions;
TRUNCATE TABLE subscription_meta_options;

-- ─── Invoices ─────────────────────────────────────────────────────────────────
TRUNCATE TABLE invoice_items;
TRUNCATE TABLE invoices;

-- ─── Clients ──────────────────────────────────────────────────────────────────
TRUNCATE TABLE client_contacts;
TRUNCATE TABLE client_payments;
TRUNCATE TABLE client_credentials;
TRUNCATE TABLE client_documents;
TRUNCATE TABLE client_meta_options;
TRUNCATE TABLE clients;

-- ─── Core ─────────────────────────────────────────────────────────────────────
TRUNCATE TABLE notifications;
TRUNCATE TABLE employees;
TRUNCATE TABLE users;
TRUNCATE TABLE activity_logs;
TRUNCATE TABLE system_settings;
TRUNCATE TABLE _migrations;

SET FOREIGN_KEY_CHECKS = 1;

-- ══════════════════════════════════════════════════════════════════════════════
-- SEED: SUPER ADMIN
-- Password: Admin@123  (bcrypt rounds=12, freshly generated)
-- ══════════════════════════════════════════════════════════════════════════════

INSERT INTO users (name, email, password_hash, role, status) VALUES
  ('Super Admin', 'youtoopreneur@gmail.com',
   '$2b$12$TiZ2ty/4Tt/zI8.8fso/cOdseFnLlW9zCv1WjwQVSJBK.G0q6Flyu',
   'SUPER_ADMIN', 'ACTIVE');

-- ══════════════════════════════════════════════════════════════════════════════
-- SEED: SYSTEM SETTINGS
-- ══════════════════════════════════════════════════════════════════════════════

INSERT INTO system_settings (`key`, value) VALUES
  ('company_name',    'Agency OS'),
  ('company_tagline', 'Digital Marketing Agency'),
  ('company_email',   'contact@agencyos.in'),
  ('company_logo_url', NULL);

-- ══════════════════════════════════════════════════════════════════════════════
-- SEED: SUBSCRIPTION META OPTIONS
-- ══════════════════════════════════════════════════════════════════════════════

INSERT INTO subscription_meta_options (uuid, type, label, color, sort_order) VALUES
  (UUID(), 'billing_cycle', 'Monthly',        '#3B82F6', 1),
  (UUID(), 'billing_cycle', 'Quarterly',      '#8B5CF6', 2),
  (UUID(), 'billing_cycle', 'Annual',         '#10B981', 3),
  (UUID(), 'billing_cycle', 'Lifetime',       '#F59E0B', 4),
  (UUID(), 'billing_cycle', 'Weekly',         '#EF4444', 5),
  (UUID(), 'category',      'SaaS Tools',     '#6366F1', 1),
  (UUID(), 'category',      'Marketing',      '#EC4899', 2),
  (UUID(), 'category',      'Infrastructure', '#14B8A6', 3),
  (UUID(), 'category',      'Communication',  '#F97316', 4),
  (UUID(), 'category',      'Design',         '#A855F7', 5),
  (UUID(), 'category',      'Analytics',      '#06B6D4', 6),
  (UUID(), 'status',        'Active',         '#22C55E', 1),
  (UUID(), 'status',        'Expiring Soon',  '#F59E0B', 2),
  (UUID(), 'status',        'Expired',        '#EF4444', 3),
  (UUID(), 'status',        'Cancelled',      '#6B7280', 4),
  (UUID(), 'status',        'Paused',         '#94A3B8', 5);

-- ══════════════════════════════════════════════════════════════════════════════
-- SEED: LEAD META OPTIONS
-- ══════════════════════════════════════════════════════════════════════════════

INSERT INTO lead_meta_options (uuid, type, label, color, sort_order) VALUES
  (UUID(), 'source',   'From Ads',      '#3B82F6', 1),
  (UUID(), 'source',   'Word of Mouth', '#10B981', 2),
  (UUID(), 'source',   'Referral',      '#F59E0B', 3),
  (UUID(), 'source',   'Instagram',     '#EC4899', 4),
  (UUID(), 'source',   'WhatsApp',      '#25D366', 5),
  (UUID(), 'source',   'Others',        '#6B7280', 6),
  (UUID(), 'status',   'New',           '#6366F1', 1),
  (UUID(), 'status',   'Contacted',     '#3B82F6', 2),
  (UUID(), 'status',   'Qualified',     '#8B5CF6', 3),
  (UUID(), 'status',   'Proposal Sent', '#F97316', 4),
  (UUID(), 'status',   'Negotiation',   '#F59E0B', 5),
  (UUID(), 'status',   'Won',           '#22C55E', 6),
  (UUID(), 'status',   'Lost',          '#EF4444', 7),
  (UUID(), 'priority', 'Cold',          '#94A3B8', 1),
  (UUID(), 'priority', 'Warm',          '#F59E0B', 2),
  (UUID(), 'priority', 'Hot',           '#EF4444', 3),
  (UUID(), 'priority', 'Done',          '#22C55E', 4),
  (UUID(), 'service',  'Website',       '#3B82F6', 1),
  (UUID(), 'service',  'Ads',           '#EC4899', 2),
  (UUID(), 'service',  'SEO',           '#10B981', 3),
  (UUID(), 'service',  'Social Media',  '#8B5CF6', 4),
  (UUID(), 'service',  'Branding',      '#F97316', 5),
  (UUID(), 'service',  'Content',       '#F59E0B', 6),
  (UUID(), 'service',  'Others',        '#6B7280', 7);

-- ══════════════════════════════════════════════════════════════════════════════
-- SEED: CLIENT META OPTIONS  (requires SUPER_ADMIN id = 1)
-- ══════════════════════════════════════════════════════════════════════════════

INSERT INTO client_meta_options (type, label, color, sort_order, created_by) VALUES
  ('tag',           'VIP',        '#8B5CF6', 1, 1),
  ('tag',           'Risk',       '#EF4444', 2, 1),
  ('tag',           'Long-term',  '#14B8A6', 3, 1),
  ('contract_type', 'Monthly',    '#6366F1', 1, 1),
  ('contract_type', 'Quarterly',  '#3B82F6', 2, 1),
  ('contract_type', 'Annual',     '#10B981', 3, 1),
  ('contract_type', 'Project',    '#F59E0B', 4, 1);

-- ══════════════════════════════════════════════════════════════════════════════
-- SEED: NOTE TAGS  (requires SUPER_ADMIN id = 1)
-- ══════════════════════════════════════════════════════════════════════════════

INSERT INTO note_tags (name, color, created_by) VALUES
  ('Office',       '#3B82F6', 1),
  ('Marketplace',  '#8B5CF6', 1),
  ('Development',  '#10B981', 1),
  ('Client',       '#F59E0B', 1),
  ('Important',    '#EF4444', 1);

-- ══════════════════════════════════════════════════════════════════════════════
-- SEED: MIGRATIONS LOG
-- ══════════════════════════════════════════════════════════════════════════════

INSERT INTO _migrations (name) VALUES
  ('subscription_tracker'),
  ('leads_module'),
  ('clients_module_p1'),
  ('client_logo'),
  ('employees_enhancement'),
  ('task_members'),
  ('task_comments_attachments'),
  ('task_subtasks'),
  ('task_service'),
  ('todo_module'),
  ('todo_list_members'),
  ('todo_stage'),
  ('002_attendance_v2'),
  ('003_client_user'),
  ('004_todo_group_members'),
  ('notes_module'),
  ('chat_module'),
  ('client_meta'),
  ('system_settings'),
  ('invoice_milestone'),
  ('leave_halfday_compoff'),
  ('employee_self_service'),
  ('add_doc_to_change_requests'),
  ('subscription_renewal'),
  ('subscription_enhancements');

-- ══════════════════════════════════════════════════════════════════════════════
-- DONE.
-- Login:  youtoopreneur@gmail.com  /  Admin@123
-- ══════════════════════════════════════════════════════════════════════════════
