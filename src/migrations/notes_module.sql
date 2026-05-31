-- ══════════════════════════════════════════════════════════════════════════════
-- NOTES MODULE — notes_module.sql
-- Safe to re-run: all tables use CREATE TABLE IF NOT EXISTS
-- ══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- Table 1: note_tags
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS note_tags (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  uuid       VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  name       VARCHAR(100) NOT NULL,
  color      VARCHAR(7) DEFAULT '#6366F1',
  created_by INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_created_by (created_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- Table 2: notes
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notes (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  uuid                VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  title               VARCHAR(500) NOT NULL,
  content             LONGTEXT,
  category            ENUM('lead','client','project','meeting','branding','personal','business','other') DEFAULT 'personal',
  priority            ENUM('low','medium','high','critical') DEFAULT 'low',
  status              ENUM('active','archived','deleted') DEFAULT 'active',
  is_starred          BOOLEAN DEFAULT FALSE,
  is_read             BOOLEAN DEFAULT TRUE,
  is_snoozed          BOOLEAN DEFAULT FALSE,
  snoozed_until       DATETIME,
  linked_client_id    INT,
  linked_module       ENUM('client','employee','task','invoice','subscription','todo','none') DEFAULT 'none',
  linked_module_id    INT,
  linked_module_uuid  VARCHAR(36),
  assigned_to         INT,
  created_by          INT NOT NULL,
  deleted_at          DATETIME,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (linked_client_id) REFERENCES clients(id) ON DELETE SET NULL,
  INDEX idx_created_by (created_by),
  INDEX idx_status     (status),
  INDEX idx_category   (category),
  INDEX idx_assigned   (assigned_to),
  INDEX idx_linked     (linked_module, linked_module_id),
  FULLTEXT INDEX ft_search (title, content)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- Table 3: note_tag_map
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS note_tag_map (
  id      INT AUTO_INCREMENT PRIMARY KEY,
  note_id INT NOT NULL,
  tag_id  INT NOT NULL,
  UNIQUE KEY unique_note_tag (note_id, tag_id),
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id)  REFERENCES note_tags(id) ON DELETE CASCADE,
  INDEX idx_note (note_id),
  INDEX idx_tag  (tag_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- Table 4: note_attachments
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS note_attachments (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  uuid        VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  note_id     INT NOT NULL,
  file_name   VARCHAR(200) NOT NULL,
  file_path   VARCHAR(500) NOT NULL,
  file_size   INT,
  file_type   VARCHAR(50),
  uploaded_by INT NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
  INDEX idx_note (note_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- Table 5: note_mentions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS note_mentions (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  note_id           INT NOT NULL,
  mentioned_user_id INT NOT NULL,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_mention (note_id, mentioned_user_id),
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
  INDEX idx_note (note_id),
  INDEX idx_user (mentioned_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- Table 6: note_activity
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS note_activity (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  note_id    INT NOT NULL,
  user_id    INT NOT NULL,
  action     VARCHAR(100) NOT NULL,
  detail     VARCHAR(500),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
  INDEX idx_note (note_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- Table 7: note_recent_searches
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS note_recent_searches (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  search_term VARCHAR(300) NOT NULL,
  searched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_user_search (user_id, search_term),
  INDEX idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- Default tags
-- NOTE: created_by = 1 assumes the seeded SUPER_ADMIN has id=1.
--       Verify: SELECT id, email, role FROM users WHERE id = 1;
-- ─────────────────────────────────────────────────────────────────────────────
INSERT IGNORE INTO note_tags (name, color, created_by) VALUES
  ('Office',      '#3B82F6', 1),
  ('Marketplace', '#8B5CF6', 1),
  ('Development', '#10B981', 1),
  ('Client',      '#F59E0B', 1),
  ('Important',   '#EF4444', 1)
