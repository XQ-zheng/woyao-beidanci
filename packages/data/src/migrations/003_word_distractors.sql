-- =============================================================================
-- 003_word_distractors.sql —— 自定义干扰词表（R5）
--
-- 设计要点：
--   * 用户为某个词条手工指定的「必出现在选择题干扰项里」的英文词形。
--     一行 = (词条, 干扰词形)，UNIQUE 约束防止同一干扰词重复挂到同一词条上。
--   * 与 `deck_words` / `word_senses` 同一套软删除 + revision + device_id 口径：
--     删除是 soft delete（deleted_at 置位、revision + 1），同步侧按行合并。
--   * `distractor_lemma` 故意不做外键：干扰词可以还不是词库里的词条
--     （服务层会在保存时通过导入/LLM 把它的释义预热到 content_cache）。
-- =============================================================================

CREATE TABLE IF NOT EXISTS word_distractors (
  id TEXT PRIMARY KEY,
  word_id TEXT NOT NULL REFERENCES words (id) ON DELETE CASCADE,
  distractor_lemma TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  UNIQUE (word_id, distractor_lemma)
);

CREATE INDEX IF NOT EXISTS idx_word_distractors_word ON word_distractors (word_id);
