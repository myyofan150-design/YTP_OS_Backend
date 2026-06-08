-- Migration 004: Group-level sharing + list privacy flag
-- Adds todo_group_members table and is_private column to todo_lists

-- Group members: who has been shared a group (cascade = full group+lists+tasks visibility)
CREATE TABLE IF NOT EXISTS todo_group_members (
  id         INT          NOT NULL AUTO_INCREMENT,
  group_id   INT          NOT NULL,
  user_id    INT          NOT NULL,
  added_by   INT          NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_group_user (group_id, user_id),
  INDEX idx_group (group_id),
  INDEX idx_user  (user_id),
  CONSTRAINT fk_tgm_group FOREIGN KEY (group_id) REFERENCES todo_groups (id) ON DELETE CASCADE
);

-- Private flag on lists: when TRUE, group-level access does NOT cascade into this list
ALTER TABLE todo_lists
  ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT FALSE AFTER is_favorite;
