-- =============================================================================
-- 002_sync.sql —— 同步相关表（outbox / 游标 / 冲突 / 在线内容缓存）
--
-- 设计原则（系统设计 §4.2、§10）：
--   * 一切需要上传的变更都先落 `sync_outbox`，**与业务写入同一个事务**，
--     避免“本地改了但没排队上传”。
--   * 上传成功后删除对应 outbox 行；失败记录 `attempts` / `last_error` 供重试与诊断。
--   * 每个账号一条 `sync_state`（游标独立），避免多账号串数据。
--   * 冲突不丢数据：双方 JSON 都留档，`resolution` 记录自动/人工的处置方式。
-- =============================================================================

CREATE TABLE IF NOT EXISTS sync_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('UPSERT', 'DELETE')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_outbox_entity ON sync_outbox (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_seq ON sync_outbox (seq);

CREATE TABLE IF NOT EXISTS sync_state (
  account_id TEXT PRIMARY KEY,
  cursor TEXT,
  last_pull_at TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1)
);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  local_json TEXT NOT NULL,
  remote_json TEXT NOT NULL,
  resolution TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_conflicts_open
  ON sync_conflicts (entity_type, entity_id)
  WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS content_cache (
  cache_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at TEXT,
  source_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_content_cache_provider ON content_cache (provider, fetched_at);
