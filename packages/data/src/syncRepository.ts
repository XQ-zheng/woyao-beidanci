/**
 * 同步仓储：outbox（发件箱）、账号游标、冲突留档。
 *
 * 为什么用 outbox 而不是“写库时顺手发请求”：
 * 本地优先应用必须先保证本地写入成功，再异步上传；outbox 与业务写入在**同一事务**里，
 * 因此不会出现“本地改了但没排队上传”的丢更新。上传成功后按 `seq` 删除对应行，
 * 失败则累加 `attempts` 并记录 `last_error`，由服务层退避重试。
 *
 * 入队时间允许调用方注入（同步/测试要确定性）；没注入时交给 SQLite 的 `strftime`，
 * 于是本模块同样不需要 `new Date()`。
 */

import type { SqliteDatabase } from './connection';
import { InvalidRepositoryInputError } from './errors';
import { runInTransaction } from './transaction';

/** 需要同步的实体类型（与系统设计 §10 的实体清单一一对应）。 */
export type EntityType =
  | 'SOURCE'
  | 'WORD'
  | 'WORD_SENSE'
  | 'DECK'
  | 'DECK_WORD'
  | 'LEARNING_STATE'
  | 'LEARNING_EVENT'
  | 'STUDY_SESSION'
  | 'SETTINGS'
  | 'PLAN_WINDOW'
  | 'ASSOCIATION';

/** 同步操作。 */
export type OutboxOperation = 'UPSERT' | 'DELETE';

/** 一条待上传的变更（对应 `sync_outbox` 一行）。 */
export interface EntityChange {
  /** 入队后由数据库分配；入参时可省略。 */
  readonly seq?: number;
  /** 实体类型。 */
  readonly entityType: EntityType;
  /** 实体 id。 */
  readonly entityId: string;
  /** 操作类型。 */
  readonly operation: OutboxOperation;
  /** 变更内容（序列化成 JSON 存库，便于重放与排障）。 */
  readonly payload: unknown;
  /** 入队时间（UTC ISO-8601）；省略时由 SQLite 生成。 */
  readonly createdAt?: string;
  /** 已尝试上传次数；入参时忽略（由上传流程维护）。 */
  readonly attempts?: number;
  /** 最近一次失败原因；入参时忽略。 */
  readonly lastError?: string | null;
}

/** 每个账号的同步游标。 */
export interface SyncStateRecord {
  readonly accountId: string;
  readonly cursor: string | null;
  readonly lastPullAt: string | null;
  readonly schemaVersion: number;
}

/** 一条冲突的入参。 */
export interface SyncConflictInput {
  readonly entityType: EntityType;
  readonly entityId: string;
  readonly local: unknown;
  readonly remote: unknown;
}

/** 一条冲突记录（含处置结果）。 */
export interface SyncConflictRecord extends SyncConflictInput {
  readonly id: string;
  readonly resolution: string | null;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

/** 同步仓储契约（Task 5 直接消费）。 */
export interface SyncRepository {
  enqueueOutbox(change: EntityChange): number;
  listOutbox(limit?: number): EntityChange[];
  deleteOutbox(seqs: readonly number[]): void;
  markSynced(entityId: string): void;
  getSyncState(accountId: string): SyncStateRecord | null;
  setSyncState(state: SyncStateRecord): void;
  recordConflict(input: SyncConflictInput): string;
  listOpenConflicts(): SyncConflictRecord[];
  resolveConflict(id: string, resolution: string, now: Date): void;
}

/** `listOutbox` 的默认批量。 */
export const DEFAULT_OUTBOX_BATCH = 100;

/** `sync_outbox` 行的 snake_case 形状。 */
interface OutboxRow {
  seq: number;
  entity_type: EntityType;
  entity_id: string;
  operation: OutboxOperation;
  payload_json: string;
  created_at: string;
  attempts: number;
  last_error: string | null;
}

/** `sync_conflicts` 行的 snake_case 形状。 */
interface ConflictRow {
  id: string;
  entity_type: EntityType;
  entity_id: string;
  local_json: string;
  remote_json: string;
  resolution: string | null;
  created_at: string;
  resolved_at: string | null;
}

/** 入队语句：`created_at` 由调用方注入，未注入则用 SQLite 时钟。 */
const INSERT_OUTBOX_SQL = `INSERT INTO sync_outbox
    (entity_type, entity_id, operation, payload_json, created_at, attempts, last_error)
  VALUES (?, ?, ?, ?, coalesce(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), 0, NULL)`;

/**
 * 校验非空字符串字段。
 *
 * @param value 待校验值。
 * @param field 字段名。
 * @returns 原值。
 * @throws {InvalidRepositoryInputError} 不是非空字符串时。
 */
function requireNonEmptyString(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidRepositoryInputError(field, '必须是非空字符串');
  }
  return value;
}

/**
 * 校验一条变更（入队前）。
 *
 * @param change 变更。
 * @throws {InvalidRepositoryInputError} 任一字段非法时。
 */
function assertValidChange(change: EntityChange): void {
  if (change === null || typeof change !== 'object') {
    throw new InvalidRepositoryInputError('change', '变更不能为空');
  }
  requireNonEmptyString(change.entityType, 'entityType');
  requireNonEmptyString(change.entityId, 'entityId');
  if (change.operation !== 'UPSERT' && change.operation !== 'DELETE') {
    throw new InvalidRepositoryInputError(
      'operation',
      `操作只能是 UPSERT 或 DELETE，收到 ${String(change.operation)}`,
    );
  }
}

/**
 * 把一条变更**在当前事务内**写入 outbox，并返回分配的 `seq`。
 *
 * 供学习仓储等模块复用：调用方已在事务里时不要用 `createSyncRepository` 的公开方法
 * （那会自己开事务），而应直接调用本函数。
 *
 * @param db 连接。
 * @param change 变更。
 * @returns 新行的 `seq`。
 * @throws {InvalidRepositoryInputError} 变更非法时。
 */
export function enqueueOutboxWithin(db: SqliteDatabase, change: EntityChange): number {
  assertValidChange(change);
  const info = db
    .prepare(INSERT_OUTBOX_SQL)
    .run(
      change.entityType,
      change.entityId,
      change.operation,
      JSON.stringify(change.payload ?? null),
      change.createdAt ?? null,
    );
  return Number(info.lastInsertRowid);
}

/**
 * 创建同步仓储。
 *
 * @param db 已迁移的连接。
 * @returns 仓储实例。
 */
export function createSyncRepository(db: SqliteDatabase): SyncRepository {
  const insertOutbox = db.prepare(INSERT_OUTBOX_SQL);
  const selectOutbox = db.prepare(
    `SELECT seq, entity_type, entity_id, operation, payload_json, created_at, attempts, last_error
       FROM sync_outbox
      ORDER BY seq ASC
      LIMIT ?`,
  );
  const deleteBySeq = db.prepare('DELETE FROM sync_outbox WHERE seq = ?');
  const deleteByEntity = db.prepare('DELETE FROM sync_outbox WHERE entity_id = ?');
  const selectSyncState = db.prepare(
    'SELECT account_id, cursor, last_pull_at, schema_version FROM sync_state WHERE account_id = ?',
  );
  const upsertSyncState = db.prepare(
    `INSERT INTO sync_state (account_id, cursor, last_pull_at, schema_version)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET
       cursor = excluded.cursor,
       last_pull_at = excluded.last_pull_at,
       schema_version = excluded.schema_version`,
  );
  const insertConflict = db.prepare(
    `INSERT INTO sync_conflicts
       (id, entity_type, entity_id, local_json, remote_json, resolution, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL)`,
  );
  const selectOpenConflicts = db.prepare(
    `SELECT id, entity_type, entity_id, local_json, remote_json, resolution, created_at, resolved_at
       FROM sync_conflicts
      WHERE resolved_at IS NULL
      ORDER BY created_at ASC, id ASC`,
  );
  const resolveConflictRow = db.prepare(
    'UPDATE sync_conflicts SET resolution = ?, resolved_at = ? WHERE id = ? AND resolved_at IS NULL',
  );

  return {
    enqueueOutbox(change: EntityChange): number {
      assertValidChange(change);
      return runInTransaction(
        db,
        () => {
          const info = insertOutbox.run(
            change.entityType,
            change.entityId,
            change.operation,
            JSON.stringify(change.payload ?? null),
            change.createdAt ?? null,
          );
          return Number(info.lastInsertRowid);
        },
        { mode: 'IMMEDIATE' },
      );
    },

    listOutbox(limit: number = DEFAULT_OUTBOX_BATCH): EntityChange[] {
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new InvalidRepositoryInputError('limit', `limit 必须是正整数，收到 ${String(limit)}`);
      }
      const rows = selectOutbox.all(limit) as OutboxRow[];
      return rows.map((row) => ({
        seq: row.seq,
        entityType: row.entity_type,
        entityId: row.entity_id,
        operation: row.operation,
        payload: JSON.parse(row.payload_json) as unknown,
        createdAt: row.created_at,
        attempts: row.attempts,
        lastError: row.last_error,
      }));
    },

    deleteOutbox(seqs: readonly number[]): void {
      if (!Array.isArray(seqs)) {
        throw new InvalidRepositoryInputError('seqs', 'seqs 必须是数组');
      }
      for (const seq of seqs) {
        if (!Number.isInteger(seq) || seq <= 0) {
          throw new InvalidRepositoryInputError('seqs', `seq 必须是正整数，收到 ${String(seq)}`);
        }
      }
      if (seqs.length === 0) {
        return;
      }
      runInTransaction(
        db,
        () => {
          for (const seq of seqs) {
            deleteBySeq.run(seq);
          }
        },
        { mode: 'IMMEDIATE' },
      );
    },

    markSynced(entityId: string): void {
      requireNonEmptyString(entityId, 'entityId');
      runInTransaction(
        db,
        () => {
          deleteByEntity.run(entityId);
        },
        { mode: 'IMMEDIATE' },
      );
    },

    getSyncState(accountId: string): SyncStateRecord | null {
      requireNonEmptyString(accountId, 'accountId');
      const row = selectSyncState.get(accountId) as
        | { account_id: string; cursor: string | null; last_pull_at: string | null; schema_version: number }
        | undefined;
      if (row === undefined) {
        return null;
      }
      return {
        accountId: row.account_id,
        cursor: row.cursor,
        lastPullAt: row.last_pull_at,
        schemaVersion: row.schema_version,
      };
    },

    setSyncState(state: SyncStateRecord): void {
      if (state === null || typeof state !== 'object') {
        throw new InvalidRepositoryInputError('state', '同步状态不能为空');
      }
      requireNonEmptyString(state.accountId, 'accountId');
      if (!Number.isInteger(state.schemaVersion) || state.schemaVersion < 1) {
        throw new InvalidRepositoryInputError(
          'schemaVersion',
          `schemaVersion 必须是 >=1 的整数，收到 ${String(state.schemaVersion)}`,
        );
      }
      runInTransaction(
        db,
        () => {
          upsertSyncState.run(state.accountId, state.cursor, state.lastPullAt, state.schemaVersion);
        },
        { mode: 'IMMEDIATE' },
      );
    },

    recordConflict(input: SyncConflictInput): string {
      if (input === null || typeof input !== 'object') {
        throw new InvalidRepositoryInputError('input', '冲突输入不能为空');
      }
      requireNonEmptyString(input.entityType, 'entityType');
      requireNonEmptyString(input.entityId, 'entityId');
      const id = globalThis.crypto.randomUUID();
      runInTransaction(
        db,
        () => {
          insertConflict.run(
            id,
            input.entityType,
            input.entityId,
            JSON.stringify(input.local ?? null),
            JSON.stringify(input.remote ?? null),
          );
        },
        { mode: 'IMMEDIATE' },
      );
      return id;
    },

    listOpenConflicts(): SyncConflictRecord[] {
      const rows = selectOpenConflicts.all() as ConflictRow[];
      return rows.map((row) => ({
        id: row.id,
        entityType: row.entity_type,
        entityId: row.entity_id,
        local: JSON.parse(row.local_json) as unknown,
        remote: JSON.parse(row.remote_json) as unknown,
        resolution: row.resolution,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at,
      }));
    },

    resolveConflict(id: string, resolution: string, now: Date): void {
      requireNonEmptyString(id, 'id');
      requireNonEmptyString(resolution, 'resolution');
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new InvalidRepositoryInputError('now', 'now 必须是有效 Date');
      }
      runInTransaction(
        db,
        () => {
          const info = resolveConflictRow.run(resolution, now.toISOString(), id);
          if (info.changes === 0) {
            throw new InvalidRepositoryInputError(
              'id',
              `冲突 ${id} 不存在或已被处置（resolveConflict 不能静默成功）`,
            );
          }
        },
        { mode: 'IMMEDIATE' },
      );
    },
  };
}
