import { afterEach, describe, expect, it } from 'vitest';

import type { SqliteDatabase } from './connection';
import { closeDatabase, migrate, openDatabase } from './connection';
import { InvalidRepositoryInputError } from './errors';
import {
  createAssociationRepository,
  createWordRepository,
  type AssociationInput,
  type AssociationRepository,
} from './index';

/** 本文件创建的连接，`afterEach` 统一关闭。 */
const openDatabases: SqliteDatabase[] = [];

/** 迁移过的内存库。 */
function createDatabase(): SqliteDatabase {
  const db = openDatabase(':memory:');
  migrate(db);
  openDatabases.push(db);
  return db;
}

afterEach(() => {
  while (openDatabases.length > 0) {
    closeDatabase(openDatabases.pop() as SqliteDatabase);
  }
});

/** 两个注入时刻。 */
const NOW = new Date('2025-01-01T00:00:00.000Z');
const LATER = new Date('2025-01-02T00:00:00.000Z');

/** 造一条联想输入。 */
function makeInput(overrides: Partial<AssociationInput> = {}): AssociationInput {
  return {
    wordId: 'w-1',
    kind: 'MEANING',
    text: 'abandon → 阿爸，别抛弃我',
    sourceId: 'src-1',
    generatedBy: 'USER',
    deviceId: 'dev-1',
    now: NOW,
    ...overrides,
  };
}

/** 造词库/词条/来源，供外键与断言用。 */
function seedFixtures(db: SqliteDatabase): AssociationRepository {
  db.prepare(
    `INSERT INTO sources (id, owner_scope, type, name, created_at, updated_at)
     VALUES ('src-1', 'LOCAL', 'DICTIONARY', '来源', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
  ).run();
  createWordRepository(db).createWord({
    id: 'w-1',
    ownerScope: 'LOCAL',
    lemma: 'abandon',
    senses: [],
    deviceId: 'dev-1',
    now: NOW,
  });
  return createAssociationRepository(db);
}

function countRows(db: SqliteDatabase, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

describe('associationRepository', () => {
  it('listAssociations 排除软删，按 kind、createdAt 升序', () => {
    const db = createDatabase();
    const repo = seedFixtures(db);

    repo.upsertAssociation(makeInput({ id: 'a-pict', kind: 'PICTOGRAPH', now: NOW }));
    repo.upsertAssociation(makeInput({ id: 'a-mean', kind: 'MEANING', now: LATER }));
    repo.upsertAssociation(makeInput({ id: 'a-homo', kind: 'HOMOPHONE', now: NOW }));
    repo.upsertAssociation(makeInput({ id: 'a-del', kind: 'MEANING', text: '待删', now: NOW }));
    repo.deleteAssociation('a-del', 'dev-1', LATER);

    const list = repo.listAssociations('w-1');
    // kind 升序：HOMOPHONE < MEANING < PICTOGRAPH；同 kind 再按 createdAt 升序。
    expect(list.map((item) => item.id)).toEqual(['a-homo', 'a-mean', 'a-pict']);
    expect(list.some((item) => item.id === 'a-del')).toBe(false);
    // 软删不物理删除：行还在表里。
    expect(countRows(db, 'associations')).toBe(4);
  });

  it('upsertAssociation 幂等：同 id 两次只一行，且内容是后一次', () => {
    const db = createDatabase();
    const repo = seedFixtures(db);

    repo.upsertAssociation(makeInput({ id: 'a-1', text: '第一次' }));
    const second = repo.upsertAssociation(makeInput({ id: 'a-1', text: '第二次' }));

    expect(second.id).toBe('a-1');
    expect(second.text).toBe('第二次');
    expect(repo.listAssociations('w-1')).toHaveLength(1);
    expect(countRows(db, 'associations')).toBe(1);
  });

  it('deleteAssociation 对不存在/已删 id 是空操作', () => {
    const db = createDatabase();
    const repo = seedFixtures(db);
    repo.upsertAssociation(makeInput({ id: 'a-1' }));

    repo.deleteAssociation('a-1', 'dev-1', LATER);
    repo.deleteAssociation('a-1', 'dev-1', LATER);
    repo.deleteAssociation('ghost', 'dev-1', LATER);

    expect(repo.listAssociations('w-1')).toEqual([]);
    expect(countRows(db, 'associations')).toBe(1);
  });

  it('非法 kind / 空 text / 非法 generatedBy 都被拒', () => {
    const db = createDatabase();
    const repo = seedFixtures(db);

    expect(() =>
      repo.upsertAssociation(makeInput({ kind: 'RHYME' as unknown as 'MEANING' })),
    ).toThrow(InvalidRepositoryInputError);
    expect(() => repo.upsertAssociation(makeInput({ text: '   ' }))).toThrow(
      InvalidRepositoryInputError,
    );
    expect(() =>
      repo.upsertAssociation(makeInput({ generatedBy: 'AI' as unknown as 'USER' })),
    ).toThrow(InvalidRepositoryInputError);
    expect(countRows(db, 'associations')).toBe(0);
  });

  it('assetUri/originUrl 空串归一成 null，字段逐项回读正确', () => {
    const db = createDatabase();
    const repo = seedFixtures(db);

    const record = repo.upsertAssociation(
      makeInput({
        id: 'a-1',
        assetUri: 'file:///tmp/img.png',
        originUrl: 'https://example.com/abandon',
      }),
    );

    expect(record).toMatchObject({
      id: 'a-1',
      wordId: 'w-1',
      kind: 'MEANING',
      assetUri: 'file:///tmp/img.png',
      originUrl: 'https://example.com/abandon',
      sourceId: 'src-1',
      generatedBy: 'USER',
      reviewedAt: null,
    });
    // 空串按 null 处理（避免库里出现 '' 这种“假有值”）。
    const empty = repo.upsertAssociation(
      makeInput({ id: 'a-2', assetUri: '', originUrl: '' }),
    );
    expect(empty.assetUri).toBeNull();
    expect(empty.originUrl).toBeNull();
  });
});
