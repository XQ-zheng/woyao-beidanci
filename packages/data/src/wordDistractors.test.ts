/**
 * word_distractors（R5 数据层）的仓储测试：真表真约束的内存 SQLite。
 *
 * 锁定的行为：
 * - setWordDistractors 是全量替换：新词形 insert、被移除的 soft delete；
 * - 幂等：重复保存不推 revision、不改 updated_at；
 * - 删掉再重新加同一个词：UNIQUE (word_id, distractor_lemma) 下走复活（upsert）；
 * - 词形去重（去空白 + 小写）。
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  createWordRepository,
  migrate,
  openDatabase,
  InvalidRepositoryInputError,
  type SqliteDatabase,
  type WordRepository,
} from './index';

const NOW = new Date('2026-10-27T02:00:00.000Z');
const NOW_ISO = NOW.toISOString();
const DEVICE = 'device-test';

const databases: SqliteDatabase[] = [];
const repos: WordRepository[] = [];

afterEach(() => {
  while (repos.length > 0) {
    repos.pop();
  }
  while (databases.length > 0) {
    const db = databases.pop();
    if (db !== undefined) {
      closeDatabase(db);
    }
  }
});

/** 建一个已迁移的内存库 + 词条仓储 + 一个带义项的词条。 */
function makeRepo(): { db: SqliteDatabase; repo: WordRepository; wordId: string } {
  const db = openDatabase(':memory:');
  migrate(db);
  databases.push(db);
  db.prepare(
    `INSERT INTO sources (id, owner_scope, type, name, created_at, updated_at)
     VALUES ('local-user', 'LOCAL', 'USER', '测试来源', ?, ?)`,
  ).run(NOW_ISO, NOW_ISO);
  const repo = createWordRepository(db);
  repos.push(repo);
  const wordId = repo
    .createWord({
      ownerScope: 'LOCAL',
      lemma: 'abandon',
      senses: [{ pos: 'v.', simpleZh: '放弃', detailedZh: null, sourceId: 'local-user' }],
      deviceId: DEVICE,
      now: NOW,
    })
    .id;
  return { db, repo, wordId };
}

/** 读 word_distractors 原始行（含软删行）。 */
function rawRows(db: SqliteDatabase, wordId: string): {
  distractor_lemma: string;
  deleted_at: string | null;
  revision: number;
}[] {
  return db
    .prepare(
      `SELECT distractor_lemma, deleted_at, revision FROM word_distractors
        WHERE word_id = ? ORDER BY rowid ASC`,
    )
    .all(wordId) as { distractor_lemma: string; deleted_at: string | null; revision: number }[];
}

describe('setWordDistractors：全量替换', () => {
  it('新词形 insert，listWordDistractors 按加入顺序返回', () => {
    const { repo, wordId } = makeRepo();

    repo.setWordDistractors({
      wordId,
      lemmas: ['abolish', 'absorb'],
      deviceId: DEVICE,
      now: NOW,
    });

    expect(repo.listWordDistractors(wordId)).toEqual(['abolish', 'absorb']);
  });

  it('被移除的词形软删（行保留、deleted_at 置位、revision + 1）', () => {
    const { db, repo, wordId } = makeRepo();
    repo.setWordDistractors({ wordId, lemmas: ['abolish', 'absorb'], deviceId: DEVICE, now: NOW });
    const before = rawRows(db, wordId);
    expect(before).toHaveLength(2);

    repo.setWordDistractors({ wordId, lemmas: ['absorb'], deviceId: DEVICE, now: NOW });

    expect(repo.listWordDistractors(wordId)).toEqual(['absorb']);
    const rows = rawRows(db, wordId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ distractor_lemma: 'abolish', deleted_at: NOW_ISO });
    expect(rows[0]?.revision).toBeGreaterThan(0);
    // 保留的行未被触碰。
    expect(rows[1]).toMatchObject({ distractor_lemma: 'absorb', deleted_at: null, revision: 0 });
  });

  it('重复保存是幂等的：保留的行 revision 不变、不产生重复行', () => {
    const { db, repo, wordId } = makeRepo();
    repo.setWordDistractors({ wordId, lemmas: ['abolish'], deviceId: DEVICE, now: NOW });
    const first = rawRows(db, wordId);

    repo.setWordDistractors({ wordId, lemmas: ['abolish'], deviceId: DEVICE, now: NOW });

    const second = rawRows(db, wordId);
    expect(second).toHaveLength(1);
    expect(second[0]?.revision).toBe(first[0]?.revision);
  });

  it('删掉再重新加同一个词：走复活（不撞 UNIQUE，不产生第二行）', () => {
    const { db, repo, wordId } = makeRepo();
    repo.setWordDistractors({ wordId, lemmas: ['abolish'], deviceId: DEVICE, now: NOW });
    repo.setWordDistractors({ wordId, lemmas: [], deviceId: DEVICE, now: NOW });
    expect(repo.listWordDistractors(wordId)).toEqual([]);

    repo.setWordDistractors({ wordId, lemmas: ['abolish'], deviceId: DEVICE, now: NOW });

    expect(repo.listWordDistractors(wordId)).toEqual(['abolish']);
    const rows = rawRows(db, wordId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deleted_at: null });
    // 复活推进了 revision（同步侧按行合并）。
    expect(rows[0]?.revision).toBeGreaterThan(0);
  });

  it('词形去重（去空白 + 小写），保留首次出现的原词形', () => {
    const { repo, wordId } = makeRepo();

    repo.setWordDistractors({
      wordId,
      lemmas: ['Abolish', ' abolish ', 'ABOLISH', 'absorb'],
      deviceId: DEVICE,
      now: NOW,
    });

    expect(repo.listWordDistractors(wordId)).toEqual(['Abolish', 'absorb']);
  });

  it('词条不存在抛 InvalidRepositoryInputError', () => {
    const { repo } = makeRepo();

    expect(() =>
      repo.setWordDistractors({
        wordId: 'missing',
        lemmas: ['abolish'],
        deviceId: DEVICE,
        now: NOW,
      }),
    ).toThrow(InvalidRepositoryInputError);
  });

  it('空字符串词形被拒绝', () => {
    const { repo, wordId } = makeRepo();

    expect(() =>
      repo.setWordDistractors({ wordId, lemmas: ['   '], deviceId: DEVICE, now: NOW }),
    ).toThrow(InvalidRepositoryInputError);
    expect(repo.listWordDistractors(wordId)).toEqual([]);
  });
});

describe('listWordDistractors', () => {
  it('未设置过时返回空数组；软删行不出现在结果里', () => {
    const { db, repo, wordId } = makeRepo();

    expect(repo.listWordDistractors(wordId)).toEqual([]);

    repo.setWordDistractors({ wordId, lemmas: ['abolish'], deviceId: DEVICE, now: NOW });
    repo.setWordDistractors({ wordId, lemmas: [], deviceId: DEVICE, now: NOW });
    expect(rawRows(db, wordId)).toHaveLength(1);
    expect(repo.listWordDistractors(wordId)).toEqual([]);
  });
});
