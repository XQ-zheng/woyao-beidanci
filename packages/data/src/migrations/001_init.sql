-- =============================================================================
-- 001_init.sql —— 「我要背单词」本地 SQLite 的领域表（对应系统设计 §4.2）
--
-- 约定（全库一致，后续迁移必须遵守）：
--   * 时间一律存 **UTC ISO 8601 毫秒字符串**（如 `2025-06-30T12:00:00.000Z`），
--     与 @woyao/core 的 `LearningState.dueAt` / `answeredAt` 完全同构，
--     不存本地时间、不存 epoch 数字，避免跨端/跨时区出现第二种解释。
--   * 布尔用 INTEGER 0/1 并配 CHECK，避免 SQLite 里出现 'true'/2 这类脏值。
--   * `device_id` + `revision` 是同步用的最小元数据；`deleted_at` 做软删除，
--     这样删除本身也能同步，且历史事件仍可回溯。
--   * 唯一约束用 **部分索引（WHERE deleted_at IS NULL）**：软删除后允许重新
--     添加同一个词/义项，否则「删除再添加」会撞唯一键。
--   * SQL 用 snake_case，TS DTO 用 camelCase，映射在仓储层显式完成。
--
-- **迁移文件的修改规则**：V1.0 尚未发布、没有真实用户库，因此最初的 DDL 允许就地修订；
-- **一旦发布，schema 的任何变更都只能新增迁移文件（003_xxx.sql…），不得再改既有文件**——
-- 已经执行过该版本的库不会被重放，改文件等于凭空造出两个不同的库结构。
-- =============================================================================

-- 词典、频率、音频、图片、字体等一切外部内容的来源（含用户自建内容的“本地”来源）。
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  owner_scope TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  url TEXT,
  license_code TEXT,
  license_url TEXT,
  attribution TEXT,
  redistribution_allowed INTEGER NOT NULL DEFAULT 0
    CHECK (redistribution_allowed IN (0, 1)),
  checksum TEXT,
  imported_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sources_owner_scope ON sources (owner_scope);

-- 词条。`normalized_lemma` 是标准化后的小写去空白形式，用于查重与查询；
-- `lemma` 保留用户/词典原本的词形（例如 `Abandon`、`ice cream`）。
CREATE TABLE IF NOT EXISTS words (
  id TEXT PRIMARY KEY,
  owner_scope TEXT NOT NULL,
  lemma TEXT NOT NULL,
  normalized_lemma TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  phonetic_uk TEXT,
  phonetic_us TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  CHECK (length(trim(lemma)) > 0),
  CHECK (length(normalized_lemma) > 0),
  CHECK (normalized_lemma = lower(trim(normalized_lemma)))
);

-- 同一 owner_scope 内，同一个标准化词形只能有一个“活着”的词条。
CREATE UNIQUE INDEX IF NOT EXISTS ux_words_owner_normalized
  ON words (owner_scope, normalized_lemma)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_words_normalized ON words (normalized_lemma);

-- 义项。多义项按 `sense_no` 展示；`source_id` 参与唯一键，
-- 因为两个来源可能对同一个词给出“同序号不同释义”。
CREATE TABLE IF NOT EXISTS word_senses (
  id TEXT PRIMARY KEY,
  word_id TEXT NOT NULL REFERENCES words (id) ON DELETE CASCADE,
  sense_no INTEGER NOT NULL CHECK (sense_no >= 1),
  pos TEXT NOT NULL DEFAULT '',
  simple_zh TEXT NOT NULL DEFAULT '',
  detailed_zh TEXT,
  context_text TEXT,
  source_id TEXT REFERENCES sources (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_word_senses_word_no_source
  ON word_senses (word_id, sense_no, ifnull(source_id, ''))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_word_senses_word ON word_senses (word_id);

-- 词库：内置（随应用分发）、自建、生词本。
CREATE TABLE IF NOT EXISTS decks (
  id TEXT PRIMARY KEY,
  owner_scope TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('BUILTIN', 'CUSTOM', 'NOTEBOOK')),
  source_id TEXT REFERENCES sources (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  CHECK (length(trim(name)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_decks_owner_kind ON decks (owner_scope, kind);

-- 词库与词的多对多；收藏即向 NOTEBOOK 添加一行。
CREATE TABLE IF NOT EXISTS deck_words (
  deck_id TEXT NOT NULL REFERENCES decks (id) ON DELETE CASCADE,
  word_id TEXT NOT NULL REFERENCES words (id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (deck_id, word_id)
);

CREATE INDEX IF NOT EXISTS idx_deck_words_word ON deck_words (word_id);

-- 学习状态：每词每词库一条（主键 `user_word_id` 由应用层生成，通常是
-- `${deckId}:${wordId}` 或用例可预测的稳定 ID）。
-- `stage = -1` 表示从未成功进入复习阶段（见 core 的 STAGE_NEVER_REVIEWED）；
-- `weight` 的区间与 core 的 WEIGHT_MIN/WEIGHT_MAX 一致，脏数据在写入前就该被钳制。
CREATE TABLE IF NOT EXISTS learning_state (
  user_word_id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL REFERENCES decks (id) ON DELETE CASCADE,
  word_id TEXT NOT NULL REFERENCES words (id) ON DELETE CASCADE,
  stage INTEGER NOT NULL DEFAULT -1 CHECK (stage >= -1),
  due_at TEXT NOT NULL,
  last_reviewed_at TEXT,
  correct_count INTEGER NOT NULL DEFAULT 0 CHECK (correct_count >= 0),
  wrong_count INTEGER NOT NULL DEFAULT 0 CHECK (wrong_count >= 0),
  streak_correct INTEGER NOT NULL DEFAULT 0 CHECK (streak_correct >= 0),
  last_result TEXT CHECK (last_result IS NULL OR last_result IN ('CORRECT', 'WRONG')),
  weight REAL NOT NULL DEFAULT 1 CHECK (weight >= 0.25 AND weight <= 4),
  suppressed_at TEXT,
  state_updated_at TEXT NOT NULL,
  device_id TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_learning_state_due ON learning_state (deck_id, due_at);
CREATE INDEX IF NOT EXISTS idx_learning_state_word ON learning_state (word_id);

-- 作答事件：只追加、不更新学习事实。`event_id` 是幂等键——
-- 同一条事件重放（同步、重试、双击）不得重复加计数。
-- 刻意 **不** 加 `user_word_id → learning_state` 外键：设计允许“先用事件重建状态”，
-- 事件可能先于状态落库。
CREATE TABLE IF NOT EXISTS learning_events (
  event_id TEXT PRIMARY KEY,
  user_word_id TEXT NOT NULL,
  -- `deck_id` / `word_id` 是**冗余写**：可由 `user_word_id` 反解（`${deckId}:${wordId}`）或
  -- JOIN `learning_state` 得到。保留它们是为了让「按词库/按词汇总」与同步 payload 不必 JOIN，
  -- 代价是一次写入两列冗余值；真相仍然只有 `user_word_id` + `learning_state` 一处。
  -- 取舍记在 docs/architecture.md §4.2（b37d647）。
  deck_id TEXT,
  word_id TEXT,
  session_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('EN_TO_ZH', 'ZH_TO_EN', 'MIXED')),
  prompt TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  is_correct INTEGER NOT NULL CHECK (is_correct IN (0, 1)),
  recognition TEXT NOT NULL CHECK (recognition IN ('KNOWN', 'UNKNOWN')),
  stage_before INTEGER,
  stage_after INTEGER,
  -- 复习事件记录本次作答所履行的到期时间；新词首答为 NULL。
  -- 它是评估 M 项（到期复习 48h 内答对率）的样本来源：core 按
  -- `answered_at >= due_at && answered_at - due_at <= 48h` 过滤，这里不重复过滤。
  due_at TEXT,
  answered_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  device_id TEXT NOT NULL DEFAULT '',
  synced_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_learning_events_user_word ON learning_events (user_word_id, answered_at);
CREATE INDEX IF NOT EXISTS idx_learning_events_answered ON learning_events (answered_at);
CREATE INDEX IF NOT EXISTS idx_learning_events_session ON learning_events (session_id);
-- 日统计（learning_events 按 local_date 分组）走这条索引，否则每次开统计页都全表扫。
CREATE INDEX IF NOT EXISTS idx_learning_events_local_date ON learning_events (local_date);

-- 学习会话：完成统计与历史快照。
CREATE TABLE IF NOT EXISTS study_sessions (
  session_id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL REFERENCES decks (id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  local_date TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  new_count INTEGER NOT NULL DEFAULT 0 CHECK (new_count >= 0),
  review_count INTEGER NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  active_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (active_duration_ms >= 0),
  plan_snapshot_json TEXT,
  device_id TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_study_sessions_deck_date ON study_sessions (deck_id, local_date);

-- 键值设置：每键独立冲突（同步按 key 合并，而不是整表覆盖）。
-- `deleted_at` 是**软删除**：删除本身也要能同步给其他设备，
-- 直接 DELETE 会让对端永远不知道自己该删这个键。
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  device_id TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);

-- 多学习时段；跨午夜的时段由应用层拆成两条。
CREATE TABLE IF NOT EXISTS plan_windows (
  id TEXT PRIMARY KEY,
  effective_local_date TEXT NOT NULL,
  start_minute INTEGER NOT NULL CHECK (start_minute >= 0 AND start_minute < 1440),
  end_minute INTEGER NOT NULL CHECK (end_minute > 0 AND end_minute <= 1440),
  time_zone TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  device_id TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  CHECK (end_minute > start_minute)
);

CREATE INDEX IF NOT EXISTS idx_plan_windows_date ON plan_windows (effective_local_date, start_minute);

-- 联想（助记/谐音/象形）。`asset_uri` 是本机缓存地址，不参与同步；
-- `origin_url` 是可核验来源，同步时要带上，避免“无来源的图片”。
CREATE TABLE IF NOT EXISTS associations (
  id TEXT PRIMARY KEY,
  word_id TEXT NOT NULL REFERENCES words (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('MEANING', 'HOMOPHONE', 'PICTOGRAPH')),
  text TEXT NOT NULL DEFAULT '',
  asset_uri TEXT,
  origin_url TEXT,
  source_id TEXT REFERENCES sources (id),
  generated_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_associations_word ON associations (word_id, kind);

-- 词频条目：仅允许真实导入（不虚构语料）。
-- `rank`  = 该语料版本内按 frequency 降序的名次；同频次并列共享**组内最小名次**。
-- `equal_count` = 该并列组的条数（含自身），供 core 的
--   `percentile = (less + 0.5*equal) / knownWordCount` 使用。
-- 两列必须同时写入：只写 rank 而让 equal_count 走默认 1，
-- 会把 P60–P90 的词误判为高频（见 @woyao/core 的 frequency.ts 注释）。
--
-- 主键**不含 source_id**：读路径 `listFrequencyEntries(exam, corpusVersion)` 没有来源维度，
-- 若把来源放进主键，同一 exam+version 下换一个来源重导就会留下两份、读回行数翻倍，
-- 直接破坏“每词一行 == knownWordCount”的前提。一个 exam+version 只允许一份权威语料，
-- 重导时按 (exam, corpus_version) 整体覆盖（见 wordRepository.writeFrequencyCorpus）。
CREATE TABLE IF NOT EXISTS frequency_entries (
  word_id TEXT NOT NULL REFERENCES words (id) ON DELETE CASCADE,
  exam TEXT NOT NULL DEFAULT 'ALL',
  corpus_version TEXT NOT NULL,
  frequency INTEGER NOT NULL CHECK (frequency >= 0),
  -- 语料总词数：可为 NULL（来源没给出时宁可空着，也不写 0 冒充“统计过”）。
  total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
  rank INTEGER CHECK (rank IS NULL OR rank >= 1),
  equal_count INTEGER NOT NULL DEFAULT 1 CHECK (equal_count >= 1),
  -- 当前生效语料的来源；重导时随主键行一起改写（它描述“这行是谁给的”，不是身份的一部分）。
  source_id TEXT NOT NULL REFERENCES sources (id),
  -- ⚠️ **`created_at` 语义的例外**：§4.1 的通则是“created_at = 首次创建时间”，而本表按
  -- (exam, corpus_version) **整卷替换**——重导时旧行被 DELETE、新行重新 INSERT，
  -- 所以这里记的是“**本行最近一次导入的时间**”，不是首次创建时间。
  -- 不做成“保留旧值”的理由：整卷替换时行是重建的，保留旧值没有语义，
  -- 还会让 created_at 与 source_id/frequency 这些同样被覆盖的列互相矛盾
  -- （同一行里一半是新语料的值、一半是旧语料的建行时间）。
  -- 因此 `ON CONFLICT ... DO UPDATE` 里**不要**写 `created_at = frequency_entries.created_at`。
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (word_id, exam, corpus_version)
);

CREATE INDEX IF NOT EXISTS idx_frequency_corpus ON frequency_entries (corpus_version, exam);
