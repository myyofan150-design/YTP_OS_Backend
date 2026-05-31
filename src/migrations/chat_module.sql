-- chat_module.sql
-- Chat System tables for Agency OS

CREATE TABLE IF NOT EXISTS conversations (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  uuid                 VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  type                 ENUM('direct','group','contextual') NOT NULL,
  name                 VARCHAR(200),
  description          TEXT,
  avatar_url           VARCHAR(500),
  is_announcement_only BOOLEAN DEFAULT FALSE,
  is_archived          BOOLEAN DEFAULT FALSE,
  linked_module        ENUM('none','client','task','project','todo') DEFAULT 'none',
  linked_module_uuid   VARCHAR(36),
  created_by           INT NOT NULL,
  last_message_at      DATETIME,
  last_message_preview VARCHAR(300),
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_type (type),
  INDEX idx_last_message (last_message_at DESC)
);

CREATE TABLE IF NOT EXISTS conversation_members (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  conversation_id INT NOT NULL,
  user_id         INT NOT NULL,
  role            ENUM('admin','member') DEFAULT 'member',
  is_muted        BOOLEAN DEFAULT FALSE,
  joined_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_read_at    DATETIME,
  left_at         DATETIME,
  UNIQUE KEY unique_member (conversation_id, user_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  INDEX idx_user (user_id),
  INDEX idx_conversation (conversation_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  uuid            VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  conversation_id INT NOT NULL,
  sender_id       INT NOT NULL,
  type            ENUM('text','image','file','system') DEFAULT 'text',
  content         TEXT,
  reply_to_id     BIGINT,
  is_edited       BOOLEAN DEFAULT FALSE,
  edited_at       DATETIME,
  is_deleted      BOOLEAN DEFAULT FALSE,
  deleted_at      DATETIME,
  is_pinned       BOOLEAN DEFAULT FALSE,
  pinned_by       INT,
  pinned_at       DATETIME,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  INDEX idx_conversation (conversation_id, created_at DESC),
  INDEX idx_sender (sender_id)
);

CREATE TABLE IF NOT EXISTS message_attachments (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  uuid           VARCHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  message_id     BIGINT NOT NULL,
  file_name      VARCHAR(200) NOT NULL,
  file_path      VARCHAR(500) NOT NULL,
  file_size      INT,
  file_type      VARCHAR(100),
  thumbnail_path VARCHAR(500),
  download_count INT DEFAULT 0,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  INDEX idx_message (message_id)
);

CREATE TABLE IF NOT EXISTS message_reactions (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  message_id BIGINT NOT NULL,
  user_id    INT NOT NULL,
  emoji      VARCHAR(10) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_reaction (message_id, user_id, emoji),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_read_status (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  message_id BIGINT NOT NULL,
  user_id    INT NOT NULL,
  read_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_read (message_id, user_id),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  INDEX idx_user_message (user_id, message_id)
);

CREATE TABLE IF NOT EXISTS message_edit_history (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  message_id  BIGINT NOT NULL,
  old_content TEXT NOT NULL,
  edited_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pinned_messages (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  conversation_id INT NOT NULL,
  message_id      BIGINT NOT NULL,
  pinned_by       INT NOT NULL,
  pinned_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_pin (conversation_id, message_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chat_activity (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  conversation_id INT,
  user_id         INT NOT NULL,
  action          VARCHAR(100) NOT NULL,
  detail          VARCHAR(500),
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_conversation (conversation_id)
);
