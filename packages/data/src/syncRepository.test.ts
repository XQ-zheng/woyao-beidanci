import { describe, expect, it } from 'vitest';

import type { SqliteDatabase } from './connection';
import { migrate, openDatabase } from './connection';
import { InvalidRepositoryInputError } from './errors';
import { createSyncRepository } from './index';

/** 迁移过的内存库。 */
function createDatabase(): SqliteDatabase {
  const db = openDatabase(':memory:');
  migrate(db, { now: new Date('2025-01-01T00:00:00.000Z') });
  return db;
}

describe('sync_outbox', () => {
  it('按入队顺序返回，payload 原样往返', () => {
    const db = createDatabase();
    const repo = createSyncRepository(db);

    repo.enqueueOutbox({
      entityType: 'WORD',
      entityId: 'w-1',
      operation: 'UPSERT',
      payload: { lemma: 'abandon', senses: ['放弃'] },
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    repo.enqueueOutbox({
      entityType: 'WORD',
      entityId: 'w-1',
      operation: 'DELETE',
      payload: null,
      createdAt: '2025-01-02T00:00:00.000Z',
    });

    const outbox = repo.listOutbox();

    expect(outbox.map((record) => record.operation)).toEqual(['UPSERT', 'DELETE']);
    expect(outbox.map((record) => record.seq)).toEqual([1, 2]);
    expect(outbox[0]?.payload).toEqual({ lemma: 'abandon', senses: ['放弃'] });
    expect(outbox[1]?.payload).toBeNull();
  });

  it('新入队的行 attempts=0、lastError=null（重试状态由上传流程维护）', () => {
    const db = createDatabase();
    const repo = createSyncRepository(db);

    repo.enqueueOutbox({
      entityType: 'DECK',
      entityId: 'deck-1',
      operation: 'UPSERT',
      payload: { name: '默认词库' },
    });

    const [record] = repo.listOutbox();
    expect(record?.attempts).toBe(0);
    expect(record?.lastError).toBeNull();
  });

  it('markSynced 删除该实体的全部待上传行（含不同操作）', () => {
    const db = createDatabase();
    const repo = createSyncRepository(db);
    repo.enqueueOutbox({ entityType: 'WORD', entityId: 'w-1', operation: 'UPSERT', payload: 1 });
    repo.enqueueOutbox({ entityType: 'WORD', entityId: 'w-1', operation: 'DELETE', payload: null });
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

describe('账号隔离', () => {
  it('不同 owner_scope 的同名词互不可见（账号切换不串数据）', () => {
    const db = createDatabase();
    const insert = db.prepare(
      `INSERT INTO words (id, owner_scope, lemma, normalized_lemma, created_at, updated_at)
       VALUES (?, ?, 'abandon', 'abandon', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    );
    insert.run('w-local', 'LOCAL');
    insert.run('w-acc', 'account-1');

    const rows = db
      .prepare('SELECT id FROM words WHERE owner_scope = ? AND normalized_lemma = ?')
      .all('account-1', 'abandon') as { id: string }[];

    expect(rows.map((row) => row.id)).toEqual(['w-acc']);
  });
});
