/**
 * 同步仓储：outbox（发件箱）、账号游标、冲突留档、在线内容缓存。
 *
 * 为什么用 outbox 而不是“写库时顺手发请求”：
 * 本地优先应用必须先保证本地写入成功，再异步上传；outbox 与业务写入在**同一事务**里，
 * 因此不会出现“本地改了但没排队上传”的丢更新。上传成功后删除对应行，
 * 失败则累加 `attempts` 并记录 `lastError`，由服务层退避重试。
 */

import type { SqliteDatabase } from './connection';
import { InvalidRepositoryInputError } from './errors';
import { runInTransaction } from './transaction';

/** 需要同步的实体类型。 */
export type SyncEntityType =
  | 'WORD'
  | 'WORD_SENSE'
  | 'DECK'
  | 'DECK_WORD'
  | 'LEARNING_STATE'
  | 'SETTINGS'
  | 'ASSOCIATION'
  | 'STUDY_SESSION';

/** 同步操作。 */
export type SyncOperation = 'UPSERT' | 'DELETE';

/** 一条待上传的变更（对应 `sync_outbox` 一行）。 */
export interface EntityChange {
  /** 实体类型。 */
  readonly entityType: SyncEntityType;
  /** 实体 id。 */
  readonly entityId: string;
  /** 操作类型。 */
  readonly operation: SyncOperation;
  /** 变更内容（会被序列化成 JSON 存库，便于重放与排障）。 */
  readonly payload: unknown;
  /** 入队时间（UTC ISO 8601）；缺省取系统时钟。 */
  readonly createdAt?: string;
}

/** 已出队历史（读取用，带 seq 与重试信息）。 */
export interface OutboxRecord extends EntityChange {
  /** 自增序号，等于入队顺序。 */
  readonly seq: number;
  /** 已尝试次数。 */
  readonly attempts: number;
  /** 最近一次失败原因。 */
  readonly lastError: string | null;
  /** 入队时间（一定有值）。 */
  readonly createdAt: string;
}

/** 同步仓储契约（Task 5 直接消费）。 */
export interface SyncRepository {
  enqueueOutbox(change: EntityChange): void;
  listOutbox(): OutboxRecord[];
  markSynced(entityId: string): void;
}

/** `sync_outbox` 行的 snake_case 形状。 */
interface OutboxRow {
  seq: number;
  entity_type: SyncEntityType;
  entity_id: string;
  operation: SyncOperation;
  payload_json: string;
  created_at: string;
  attempts: number;
  last_error: string | null;
}

/**
 * 创建同步仓储。
 *
 * @param db 已迁移的连接。
 * @returns 仓储实例。
 */
export function createSyncRepository(db: SqliteDatabase): SyncRepository {
  const insertOutbox = db.prepare(
    `INSERT INTO sync_outbox (entity_type, entity_id, operation, payload_json, created_at, attempts, last_error)
     VALUES (?, ?, ?, ?, ?, 0, NULL)`,
  );
  const selectOutbox = db.prepare(
    `SELECT seq, entity_type, entity_id, operation, payload_json, created_at, attempts, last_error
       FROM sync_outbox
      ORDER BY seq`,
  );
  const deleteByEntity = db.prepare('DELETE FROM sync_outbox WHERE entity_id = ?');

  return {
    enqueueOutbox(change: EntityChange): void {
      if (change === null || typeof change !== 'object') {
        throw new InvalidRepositoryInputError('change', '变更不能为空');
      }
      if (typeof change.entityId !== 'string' || change.entityId.trim() === '') {
        throw new InvalidRepositoryInputError('entityId', '实体 id 必须是非空字符串');
      }
      if (change.operation !== 'UPSERT' && change.operation !== 'DELETE') {
        throw new InvalidRepositoryInputError(
          'operation',
          `操作只能是 UPSERT 或 DELETE，收到 ${String(change.operation)}`,
        );
      }
      const createdAt = change.createdAt ?? new Date().toISOString();
      insertOutbox.run(
        change.entityType,
        change.entityId,
        change.operation,
        JSON.stringify(change.payload ?? null),
        createdAt,
      );
    },

    listOutbox(): OutboxRecord[] {
      const rows = selectOutbox.all() as OutboxRow[];
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

    markSynced(entityId: string): void {
      if (typeof entityId !== 'string' || entityId.trim() === '') {
        throw new InvalidRepositoryInputError('entityId', '实体 id 必须是非空字符串');
      }
      runInTransaction(db, () => {
        deleteByEntity.run(entityId);
      }, { mode: 'IMMEDIATE' });
    },
  };
}

/**
 * 把一条变更**在当前事务内**写入 outbox。
 *
 * 供学习仓储等模块复用：调用方已在事务里时不要再用 `createSyncRepository` 的
 * 公开方法（那会自己开事务），而应直接调用本函数。
 *
 * @param db 连接。
 * @param change 变更。
 */
export function enqueueOutboxWithin(db: SqliteDatabase, change: EntityChange): void {
  if (typeof change.entityId !== 'string' || change.entityId.trim() === '') {
    throw new InvalidRepositoryInputError('entityId', '实体 id 必须是非空字符串');
  }
  db.prepare(
    `INSERT INTO sync_outbox (entity_type, entity_id, operation, payload_json, created_at, attempts, last_error)
     VALUES (?, ?, ?, ?, ?, 0, NULL)`,
  ).run(
    change.entityType,
    change.entityId,
    change.operation,
    JSON.stringify(change.payload ?? null),
    change.createdAt ?? new Date().toISOString(),
  );
}
