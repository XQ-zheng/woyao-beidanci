/**
 * replaceWordSenses（R1 数据层）的仓储测试：真表真约束的内存 SQLite。
 *
 * 锁定的行为：
 * - 全量重建：序号按数组顺序重排为 1..N，内容逐条生效；
 * - 多出的义项 soft delete（deleted_at 置位、revision + 1）；
 * - 不足的新 insert（revision 从 0 开始，来源沿用既有义项或显式传入）；
 * - 全部写在一个事务里：任何一步抛错时整体回滚、零残留。
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

/** 建一个已迁移的内存库 + 词条仓储，并播种 `local-user` 来源。 */
function makeRepo(): { db: SqliteDatabase; repo: WordRepository } {
  const db = openDatabase(':memory:');
  migrate(db);
  databases.push(db);
  db.prepare(
    `INSERT INTO sources (id, owner_scope, type, name, created_at, updated_at)
     VALUES ('local-user', 'LOCAL', 'USER', '测试来源', ?, ?)`,
  ).run(NOW_ISO, NOW_ISO);
  const repo = createWordRepository(db);
  repos.push(repo);
  return { db, repo };
}

/** 播种一个词条（义项 sourceId 统一 local-user），返回词条 id。 */
function seedWord(
  repo: WordRepository,
  senses: readonly { senseNo?: number; pos: string; simpleZh: string }[],
): string {
  const word = repo.createWord({
    ownerScope: 'LOCAL',
    lemma: 'abandon',
    senses: senses.map((sense) => ({
      ...(sense.senseNo === undefined ? {} : { senseNo: sense.senseNo }),
      pos: sense.pos,
      simpleZh: sense.simpleZh,
      detailedZh: null,
      contextText: null,
      sourceId: 'local-user',
    })),
    deviceId: DEVICE,
    now: NOW,
  });
  return word.id;
}

/** 读 word_senses 原始行（含软删行），按 rowid（插入顺序）排序保证断言稳定。 */
function rawSenseRows(db: SqliteDatabase, wordId: string): {
  sense_no: number;
  simple_zh: string;
  deleted_at: string | null;
  revision: number;
  source_id: string | null;
}[] {
  return db
    .prepare(
      `SELECT sense_no, simple_zh, deleted_at, revision, source_id
         FROM word_senses WHERE word_id = ? ORDER BY rowid ASC`,
    )
    .all(wordId) as {
    sense_no: number;
    simple_zh: string;
    deleted_at: string | null;
    revision: number;
    source_id: string | null;
  }[];
}

describe('replaceWordSenses：缩编（软删多余义项）', () => {
  it('3 → 2：前两条内容更新、序号保持 1..2，第三条软删且 revision + 1', () => {
    const { db, repo } = makeRepo();
    const wordId = seedWord(repo, [
      { pos: 'v.', simpleZh: '放弃' },
      { pos: 'v.', simpleZh: '抛弃' },
      { pos: 'n.', simpleZh: '放纵' },
    ]);

    const result = repo.replaceWordSenses({
      wordId,
      senses: [
        { pos: 'v.', simpleZh: '离弃', detailedZh: null },
        { pos: 'n.', simpleZh: '放纵', detailedZh: '自我放纵' },
      ],
      deviceId: DEVICE,
      now: NOW,
    });

    expect(result.map((sense) => `${String(sense.senseNo)}:${sense.simpleZh}`)).toEqual([
      '1:离弃',
      '2:放纵',
    ]);
    expect(result[0]?.detailedZh).toBeNull();
    expect(result[1]?.detailedZh).toBe('自我放纵');

    const rows = rawSenseRows(db, wordId);
    expect(rows).toHaveLength(3);
    // 前两条：更新（revision + 1），未删除。
    expect(rows[0]).toMatchObject({ sense_no: 1, simple_zh: '离弃', deleted_at: null });
    expect(rows[0]?.revision).toBeGreaterThan(0);
    expect(rows[1]).toMatchObject({ sense_no: 2, simple_zh: '放纵', deleted_at: null });
    // 第三条：软删（deleted_at 置位），内容原样保留（软删不篡改历史）。
    expect(rows[2]).toMatchObject({ sense_no: 3, simple_zh: '放纵', deleted_at: NOW_ISO });
    expect(rows[2]?.revision).toBeGreaterThan(0);
  });

  it('序号有空洞（1、3）时重建为 1..N（不残留空洞）', () => {
    const { repo } = makeRepo();
    const wordId = seedWord(repo, [
      { senseNo: 1, pos: 'v.', simpleZh: '放弃' },
      { senseNo: 3, pos: 'n.', simpleZh: '放纵' },
    ]);

    const result = repo.replaceWordSenses({
      wordId,
      senses: [
        { pos: 'n.', simpleZh: '新义一', detailedZh: null },
        { pos: 'v.', simpleZh: '新义二', detailedZh: null },
      ],
      deviceId: DEVICE,
      now: NOW,
    });

    expect(result.map((sense) => sense.senseNo)).toEqual([1, 2]);
    expect(result.map((sense) => sense.simpleZh)).toEqual(['新义一', '新义二']);
  });
});

describe('replaceWordSenses：扩编（新增义项）', () => {
  it('1 → 3：第一行更新，后两行新 insert（revision 从 0 开始，来源沿用既有义项）', () => {
    const { db, repo } = makeRepo();
    const wordId = seedWord(repo, [{ pos: 'v.', simpleZh: '放弃' }]);

    const result = repo.replaceWordSenses({
      wordId,
      senses: [
        { pos: 'v.', simpleZh: '离弃', detailedZh: null },
        { pos: 'n.', simpleZh: '放纵', detailedZh: null },
        { pos: 'adj.', simpleZh: '肆意的', detailedZh: null },
      ],
      deviceId: DEVICE,
      now: NOW,
    });

    expect(result.map((sense) => sense.simpleZh)).toEqual(['离弃', '放纵', '肆意的']);
    const rows = rawSenseRows(db, wordId);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.revision).toBeGreaterThan(0);
    expect(rows[1]).toMatchObject({ sense_no: 2, revision: 0, source_id: 'local-user' });
    expect(rows[2]).toMatchObject({ sense_no: 3, revision: 0 });
  });

  it('词条原本没有义项时必须显式给 sourceId，否则抛 InvalidRepositoryInputError', () => {
    const { repo } = makeRepo();
    const wordId = repo.createWord({
      ownerScope: 'LOCAL',
      lemma: 'ghost',
      senses: [],
      deviceId: DEVICE,
      now: NOW,
    }).id;

    expect(() =>
      repo.replaceWordSenses({
        wordId,
        senses: [{ pos: 'n.', simpleZh: '幽灵', detailedZh: null }],
        deviceId: DEVICE,
        now: NOW,
      }),
    ).toThrow(InvalidRepositoryInputError);

    // 显式给来源即可落库。
    const result = repo.replaceWordSenses({
      wordId,
      senses: [{ pos: 'n.', simpleZh: '幽灵', detailedZh: null }],
      sourceId: 'local-user',
      deviceId: DEVICE,
      now: NOW,
    });
    expect(result.map((sense) => sense.simpleZh)).toEqual(['幽灵']);
  });
});

describe('replaceWordSenses：校验与事务', () => {
  it('词条不存在抛 InvalidRepositoryInputError', () => {
    const { repo } = makeRepo();

    expect(() =>
      repo.replaceWordSenses({
        wordId: 'missing',
        senses: [{ pos: '', simpleZh: '任意', detailedZh: null }],
        deviceId: DEVICE,
        now: NOW,
      }),
    ).toThrow(InvalidRepositoryInputError);
  });

  it('空义项数组与空简明释义都被拒绝', () => {
    const { repo } = makeRepo();
    const wordId = seedWord(repo, [{ pos: 'v.', simpleZh: '放弃' }]);

    expect(() =>
      repo.replaceWordSenses({ wordId, senses: [], deviceId: DEVICE, now: NOW }),
    ).toThrow(InvalidRepositoryInputError);
    expect(() =>
      repo.replaceWordSenses({
        wordId,
        senses: [{ pos: '', simpleZh: '   ', detailedZh: null }],
        deviceId: DEVICE,
        now: NOW,
      }),
    ).toThrow(InvalidRepositoryInputError);
  });

  it('事务性：词条在校验失败时不留下任何中间态（幂等重试可成功）', () => {
    const { repo } = makeRepo();
    const wordId = seedWord(repo, [
      { pos: 'v.', simpleZh: '放弃' },
      { pos: 'n.', simpleZh: '放纵' },
    ]);

    // 第一次传入一个“空简明释义”的坏数组：整体失败，原义项一条都不能少。
    expect(() =>
      repo.replaceWordSenses({
        wordId,
        senses: [
          { pos: 'v.', simpleZh: '离弃', detailedZh: null },
          { pos: '', simpleZh: '', detailedZh: null },
        ],
        deviceId: DEVICE,
        now: NOW,
      }),
    ).toThrow(InvalidRepositoryInputError);
    expect(repo.listSenses(wordId).map((sense) => sense.simpleZh)).toEqual(['放弃', '放纵']);

    // 重试合法输入成功，说明失败没有污染任何状态。
    const result = repo.replaceWordSenses({
      wordId,
      senses: [{ pos: 'v.', simpleZh: '离弃', detailedZh: null }],
      deviceId: DEVICE,
      now: NOW,
    });
    expect(result.map((sense) => sense.simpleZh)).toEqual(['离弃']);
  });
});
