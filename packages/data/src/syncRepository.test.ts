import { afterEach, describe, expect, it } from 'vitest';

import type { SqliteDatabase } from './connection';
import { closeDatabase, migrate, openDatabase } from './connection';
import { InvalidRepositoryInputError } from './errors';
import { createSyncRepository } from './index';

/** 本文件创建的连接，`afterEach` 统一关闭。 */
const openDatabases: SqliteDatabase[] = [];

/** 迁移过的内存库。 */
function createDatabase(): SqliteDatabase {
  const db = openDatabase(':memory:');
  migrate(db);
  openDatabases.push(db);
  return db;
}

/** 固定时刻，避免断言依赖真实时钟。 */
const NOW = new Date('2025-01-01T00:00:00.000Z');

afterEach(() => {
  while (openDatabases.length > 0) {
    const db = openDatabases.pop();
    if (db !== undefined) {
      closeDatabase(db);
    }
  }
});

describe('sync_outbox', () => {
  it('enqueueOutbox 返回递增 seq，payload 原样往返', () => {
    const db = createDatabase();
    const repo = createSyncRepository(db);

    const firstSeq = repo.enqueueOutbox({
      entityType: 'WORD',
      entityId: 'w-1',
      operation: 'UPSERT',
      payload: { lemma: 'abandon', senses: ['放弃'] },
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    const secondSeq = repo.enqueueOutbox({
      entityType: 'WORD',
      entityId: 'w-1',
      operation: 'DELETE',
      payload: null,
      createdAt: '2025-01-02T00:00:00.000Z',
    });

    expect(secondSeq).toBeGreaterThan(firstSeq);

    const outbox = repo.listOutbox();
    expect(outbox.map((record) => record.seq)).toEqual([firstSeq, secondSeq]);
    expect(outbox.map((record) => record.operation)).toEqual(['UPSERT', 'DELETE']);
    expect(outbox[0]?.payload).toEqual({ lemma: 'abandon', senses: ['放弃'] });
    expect(outbox[1]?.payload).toBeNull();
  });

  it('未注入 createdAt 时由 SQLite 生成 UTC ISO 时间（数据层不用 new Date()）', () => {
    const db = createDatabase();
    const repo = createSyncRepository(db);

    repo.enqueueOutbox({ entityType: 'DECK', entityId: 'deck-1', operation: 'UPSERT', payload: 1 });

    const [record] = repo.listOutbox();
    expect(record?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    expect(record?.attempts).toBe(0);
    expect(record?.lastError).toBeNull();
  });

  it('listOutbox 按 seq 升序并尊重 limit（默认批量 100）', () => {
    const db = createDatabase();
    const repo = createSyncRepository(db);
    for (let index = 1; index <= 5; index += 1) {
      repo.enqueueOutbox({
        entityType: 'WORD',
        entityId: `w-${index}`,
        operation: 'UPSERT',
        payload: index,
      });
    }

    expect(repo.listOutbox(2).map((record) => record.entityId)).toEqual(['w-1', 'w-2']);
    expect(repo.listOutbox()).toHaveLength(5);
    expect(() => repo.listOutbox(0)).toThrow(InvalidRepositoryInputError);
  });

  it('deleteOutbox 只删除给定 seq（上传成功后的精确确认）', () => {
    const db = createDatabase();
    const repo = createSyncRepository(db);
    const first = repo.enqueueOutbox({ entityType: 'WORD', entityId: 'w-1', operation: 'UPSERT', payload: 1 });
    const second = repo.enqueueOutbox({ entityType: 'WORD', entityId: 'w-2', operation: 'UPSERT', payload: 2 });

    repo.deleteOutbox([first]);

    expect(repo.listOutbox().map((record) => record.seq)).toEqual([second]);
    expect(() => repo.deleteOutbox([0])).toThrow(InvalidRepositoryInputError);
    expect(() => repo.deleteOutbox([])).not.toThrow();
  });

  it('markSynced 删除该实体的全部待上传行（含不同操作）', () => {
    const db = createDatabase();
    const repo = createSyncRepository(db);
    repo.enqueueOutbox({ entityType: 'WORD', entityId: 'w-1', operation: 'UPSERT', payload: 1 });
    repo.enqueueOutbox({ entityType: 'DECK_WORD', entityId: 'w-1', operation: 'DELETE', payload: null });
    repo.enqueueOutbox({ entityType: 'WORD', entityId: 'w-2', operation: 'UPSERT', payload: 2 });

    repo.markSynced('w-1');

    expect(repo.listOutbox().map((record) => record.entityId)).toEqual(['w-2']);
  });

  it('markSynced 对不存在的实体是空操作（可安全重放）', () => {
    const db = createDatabase();
    const repo = createSyncRepository(db);

    expect(() => repo.markSynced('missing')).not.toThrow();
    expect(repo.listOutbox()).toEqual([]);
  });

  it('非法操作类型与空实体 id 抛类型化错误', () => {
    const db = createDatabase();
    const repo = createSyncRepository(db);

    expect(() =>
      repo.enqueueOutbox({
        entityType: 'WORD',
        entityId: 'w-1',
        operation: 'PATCH' as unknown as 'UPSERT',
        payload: {},
      }),
    ).toThrow(InvalidRepositoryInputError);
    expect(() =>
      repo.enqueueOutbox({ entityType: 'WORD', entityId: ' ', operation: 'UPSERT', payload: {} }),
    ).toThrow(InvalidRepositoryInputError);
    expect(() => repo.markSynced('')).toThrow(InvalidRepositoryInputError);
  });
});

describe('sync_state：每账号独立游标', () => {
  it('未同步过的账号返回 null，set 后可读回', () => {
    const db = createDatabase();
    const repo = createSyncRepository(db);

    expect(repo.getSyncState('u1')).toBeNull();

    repo.setSyncState({
      accountId: 'u1',
      cursor: 'cursor-1',
      lastPullAt: '2025-01-01T00:00:00.000Z',
      schemaVersion: 1,
    });

    expect(repo.getSyncState('u1')).toEqual({
      accountId: 'u1',
      cursor: 'cursor-1',
      lastPullAt: '2025-01-01T00:00:00.000Z',
      schemaVersion: 1,
    });
  });

  it('set 是 upsert：游标前移不会插出第二行', () => {
    const db = createDatabase();
    const repo = createSyncRepository(db);
    repo.setSyncState({ accountId: 'u1', cursor: 'c1', lastPullAt: null, schemaVersion: 1 });
    repo.setSyncState({
      accountId: 'u1',
      cursor: 'c2',
      lastPullAt: '2025-02-01T00:00:00.000Z',
      schemaVersion: 2,
    });

    expect(repo.getSyncState('u1')?.cursor).toBe('c2');
    expect(repo.getSyncState('u1')?.schemaVersion).toBe(2);
    const count = db.prepare('SELECT COUNT(*) AS n FROM sync_state').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('不同账号的游标互不影响（换账号不串进度）', () => {
    const db = createDatabase();
    const repo = createSyncRepository(db);
    repo.setSyncState({ accountId: 'u1', cursor: 'c1', lastPullAt: null, schemaVersion: 1 });
    repo.setSyncState({ accountId: 'u2', cursor: 'c2', lastPullAt: null, schemaVersion: 1 });

    expect(repo.getSyncState('u1')?.cursor).toBe('c1');
    expect(repo.getSyncState('u2')?.cursor).toBe('c2');
  });

  it('schemaVersion 必须是 >=1 的整数', () => {
    const repo = createSyncRepository(createDatabase());

    expect(() =>
      repo.setSyncState({ accountId: 'u1', cursor: null, lastPullAt: null, schemaVersion: 0 }),
    ).toThrow(InvalidRepositoryInputError);
    expect(() => repo.getSyncState('')).toThrow(InvalidRepositoryInputError);
  });
});

describe('sync_conflicts：冲突留档不丢数据', () => {
  it('recordConflict 返回 id，双方 JSON 都留档并出现在未处置列表', () => {
    const db = createDatabase();
    const repo = createSyncRepository(db);

    const id = repo.recordConflict({
      entityType: 'LEARNING_STATE',
      entityId: 'deck-1:w-1',
      local: { stage: 2 },
      remote: { stage: 3 },
    });

    const open = repo.listOpenConflicts();
    expect(open).toHaveLength(1);
    expect(open[0]?.id).toBe(id);
    expect(open[0]?.local).toEqual({ stage: 2 });
    expect(open[0]?.remote).toEqual({ stage: 3 });
    expect(open[0]?.resolution).toBeNull();
    expect(open[0]?.resolvedAt).toBeNull();
    expect(open[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  });

  it('resolveConflict 记录处置结果并从未处置列表移除；重复处置抛错', () => {
    const db = createDatabase();
    const repo = createSyncRepository(db);
    const id = repo.recordConflict({
      entityType: 'WORD',
      entityId: 'w-1',
      local: { lemma: 'abandon' },
      remote: { lemma: 'abandoned' },
    });

    repo.resolveConflict(id, 'KEEP_LOCAL', NOW);

    expect(repo.listOpenConflicts()).toEqual([]);
    const row = db
      .prepare('SELECT resolution, resolved_at FROM sync_conflicts WHERE id = ?')
      .get(id) as { resolution: string; resolved_at: string };
    expect(row.resolution).toBe('KEEP_LOCAL');
    expect(row.resolved_at).toBe(NOW.toISOString());

    expect(() => repo.resolveConflict(id, 'KEEP_REMOTE', NOW)).toThrow(InvalidRepositoryInputError);
  });

  it('不存在的冲突 id 不会被静默当成成功', () => {
    const repo = createSyncRepository(createDatabase());

    expect(() => repo.resolveConflict('missing', 'KEEP_LOCAL', NOW)).toThrow(
      InvalidRepositoryInputError,
    );
  });
});
