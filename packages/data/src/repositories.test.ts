import { afterEach, describe, expect, it } from 'vitest';

import type { LearningState } from '@woyao/core';
import { createInitialLearningState } from '@woyao/core';

import type { SqliteDatabase } from './connection';
import { closeDatabase, migrate, openDatabase } from './connection';
import {
  FrequencyCorpusMismatchError,
  InvalidOwnerScopeError,
  InvalidRepositoryInputError,
  RepositoryInvariantError,
} from './errors';
import type {
  DeckInput,
  FrequencyCorpusEntry,
  FrequencyCorpusInput,
  LearningEventRecord,
  PlanWindowRecord,
  WordInput,
} from './index';
import {
  LOCAL_OWNER_SCOPE,
  accountOwnerScope,
  createLearningRepository,
  createSettingsRepository,
  createSyncRepository,
  createWordRepository,
  makeUserWordId,
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

/** 两个注入时刻（避免任何断言依赖真实时钟）。 */
const NOW = new Date('2025-01-01T00:00:00.000Z');
const LATER = new Date('2025-01-02T00:00:00.000Z');

/** 造一个来源行（`word_senses.source_id` / `frequency_entries.source_id` 都有外键）。 */
function seedSource(db: SqliteDatabase, sourceId = 'src-1'): void {
  db.prepare(
    `INSERT INTO sources (id, owner_scope, type, name, created_at, updated_at)
     VALUES (?, 'LOCAL', 'DICTIONARY', ?, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
  ).run(sourceId, `来源-${sourceId}`);
}

/** 造一条词条输入。 */
function makeWordInput(overrides: Partial<WordInput> = {}): WordInput {
  return {
    ownerScope: LOCAL_OWNER_SCOPE,
    lemma: 'abandon',
    senses: [],
    deviceId: 'dev-1',
    now: NOW,
    ...overrides,
  };
}

/** 造一条词库输入。 */
function makeDeckInput(overrides: Partial<DeckInput> = {}): DeckInput {
  return {
    ownerScope: LOCAL_OWNER_SCOPE,
    name: '默认词库',
    kind: 'BUILTIN',
    deviceId: 'dev-1',
    now: NOW,
    ...overrides,
  };
}

/** 造一条作答事件。 */
function makeEvent(overrides: Partial<LearningEventRecord> = {}): LearningEventRecord {
  return {
    eventId: 'evt-1',
    userWordId: 'deck-1:w-1',
    sessionId: 'sess-1',
    mode: 'EN_TO_ZH',
    prompt: 'abandon',
    answer: '放弃',
    isCorrect: true,
    recognition: 'KNOWN',
    stageBefore: -1,
    stageAfter: 0,
    answeredAt: '2025-01-05T01:00:00.000Z',
    localDate: '2025-01-05',
    timeZone: 'Asia/Shanghai',
    durationMs: 3200,
    deviceId: 'dev-1',
    syncedAt: null,
    ...overrides,
  };
}

/** 造一条学习状态。 */
function makeState(overrides: Partial<LearningState> = {}): LearningState {
  return {
    ...createInitialLearningState({
      userWordId: 'deck-1:w-1',
      deckId: 'deck-1',
      wordId: 'w-1',
      dueAt: '2025-02-01T01:00:00.000Z',
    }),
    ...overrides,
  };
}

/** 数一张表的行数。 */
function countRows(db: SqliteDatabase, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

/**
 * 断言抛出的是**指定 kind** 的词频失配，并返回错误对象供继续断言消息。
 *
 * 只断言消息子串是不够的：`equal_count mismatch` 这条消息同时由「并列组写了默认值 1」
 * 与「equalCount 写成了别的数」两处抛出，兜底分支会替前面那条守卫“接住”变异，
 * 于是用例看起来绿、实际没守住任何东西（本轮反向验证就抓到过这种假绿）。
 * 这里强制断言 `kind` 与 `code` 两个机器可读字段。
 *
 * @param run 待执行并应失败的写入。
 * @param expectedKind 期望的失配类型。
 * @returns 抛出的错误对象。
 */
function expectFrequencyMismatch(
  run: () => void,
  expectedKind: FrequencyCorpusMismatchError['kind'],
): FrequencyCorpusMismatchError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(FrequencyCorpusMismatchError);
    if (!(error instanceof FrequencyCorpusMismatchError)) {
      throw error;
    }
    expect(error.kind).toBe(expectedKind);
    expect(error.code).toBe(`FREQUENCY_${expectedKind}`);
    return error;
  }
  throw new Error(`期望抛出 ${expectedKind}，但写入成功了（校验没生效）`);
}

afterEach(() => {
  while (openDatabases.length > 0) {
    const db = openDatabases.pop();
    if (db !== undefined) {
      closeDatabase(db);
    }
  }
});

describe('createWord：标准化与幂等', () => {
  it('标准化词形但保留原词形大小写，并写入同步元数据', () => {
    const db = createDatabase();
    const repo = createWordRepository(db);

    const word = repo.createWord(makeWordInput({ lemma: '  Abandon ', deviceId: 'dev-9' }));

    expect(word.normalizedLemma).toBe('abandon');
    expect(word.lemma).toBe('Abandon');
    expect(word.ownerScope).toBe(LOCAL_OWNER_SCOPE);
    expect(word.deviceId).toBe('dev-9');
    expect(word.revision).toBe(0);
    expect(word.deletedAt).toBeNull();
    expect(word.createdAt).toBe(NOW.toISOString());
  });

  it('同一词形重复导入返回同一条记录：createdAt 不变、updatedAt 前移、revision 自增', () => {
    const db = createDatabase();
    const repo = createWordRepository(db);

    const first = repo.createWord(makeWordInput({ lemma: 'abandon' }));
    const second = repo.createWord(makeWordInput({ lemma: 'ABANDON', now: LATER }));

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(NOW.toISOString());
    expect(second.updatedAt).toBe(LATER.toISOString());
    expect(second.revision).toBe(1);
    expect(countRows(db, 'words')).toBe(1);
  });

  it('义项按 (wordId, senseNo, sourceId) upsert：重复导入是更新而不是插入重复义项', () => {
    const db = createDatabase();
    seedSource(db);
    const repo = createWordRepository(db);

    const first = repo.createWord(
      makeWordInput({ senses: [{ pos: 'v.', simpleZh: '放弃', sourceId: 'src-1' }] }),
    );
    const second = repo.createWord(
      makeWordInput({
        now: LATER,
        senses: [{ pos: 'v.', simpleZh: '放弃；抛弃', sourceId: 'src-1' }],
      }),
    );

    expect(second.id).toBe(first.id);
    const senses = repo.listSenses(second.id);
    expect(senses).toHaveLength(1);
    expect(senses[0]?.simpleZh).toBe('放弃；抛弃');
    expect(senses[0]?.senseNo).toBe(1);
    expect(senses[0]?.revision).toBe(1);
  });

  it('senseNo 缺省按数组序 1..n，listSenses 按 senseNo 升序且排除软删', () => {
    const db = createDatabase();
    seedSource(db);
    const repo = createWordRepository(db);

    const word = repo.createWord(
      makeWordInput({
        senses: [
          { pos: 'n.', simpleZh: '能力', sourceId: 'src-1' },
          { pos: 'v.', simpleZh: '放弃', sourceId: 'src-1' },
        ],
      }),
    );

    expect(repo.listSenses(word.id).map((sense) => sense.senseNo)).toEqual([1, 2]);

    db.prepare("UPDATE word_senses SET deleted_at = ? WHERE sense_no = 2").run(NOW.toISOString());
    expect(repo.listSenses(word.id).map((sense) => sense.simpleZh)).toEqual(['能力']);
  });

  it('getWordByLemma 按归属范围隔离；getWordById 对软删词返回 null', () => {
    const db = createDatabase();
    const repo = createWordRepository(db);
    const local = repo.createWord(makeWordInput({ ownerScope: LOCAL_OWNER_SCOPE }));
    const account = repo.createWord(makeWordInput({ ownerScope: accountOwnerScope('u1') }));

    expect(local.id).not.toBe(account.id);
    expect(repo.getWordByLemma('abandon', LOCAL_OWNER_SCOPE)?.id).toBe(local.id);
    expect(repo.getWordByLemma('  ABANDON ', accountOwnerScope('u1'))?.id).toBe(account.id);

    repo.createWord(makeWordInput({ lemma: 'ability' }));
    const ability = repo.getWordByLemma('ability', LOCAL_OWNER_SCOPE);
    expect(ability).not.toBeNull();
    db.prepare('UPDATE words SET deleted_at = ? WHERE id = ?').run(NOW.toISOString(), ability?.id);
    expect(repo.getWordById(ability?.id ?? '')).toBeNull();
  });

  it('listWordsByIds 保持入参顺序、缺失与软删的跳过', () => {
    const db = createDatabase();
    const repo = createWordRepository(db);
    const abandon = repo.createWord(makeWordInput({ lemma: 'abandon' }));
    const ability = repo.createWord(makeWordInput({ lemma: 'ability' }));
    const absent = repo.createWord(makeWordInput({ lemma: 'absent' }));

    expect(repo.listWordsByIds([absent.id, abandon.id, 'missing', ability.id]).map((w) => w.id)).toEqual(
      [absent.id, abandon.id, ability.id],
    );

    db.prepare('UPDATE words SET deleted_at = ? WHERE id = ?').run(NOW.toISOString(), ability.id);
    expect(repo.listWordsByIds([ability.id, abandon.id]).map((w) => w.id)).toEqual([abandon.id]);
  });

  it('listWordsByIds 跨批次（>500）仍保持入参顺序、缺失的跳过', () => {
    const db = createDatabase();
    const repo = createWordRepository(db);
    const first = repo.createWord(makeWordInput({ lemma: 'abandon' }));
    const second = repo.createWord(makeWordInput({ lemma: 'ability' }));
    const third = repo.createWord(makeWordInput({ lemma: 'absent' }));
    // 498 个不存在的 id 把总量顶到 501，强制跨过一次 500 的分块边界。
    const padding = Array.from({ length: 498 }, (_, index) => `missing-${index}`);
    const ids = [third.id, ...padding, first.id, second.id];

    expect(ids).toHaveLength(501);
    expect(repo.listWordsByIds(ids).map((word) => word.id)).toEqual([
      third.id,
      first.id,
      second.id,
    ]);
    // 重复 id 按入参重复出现（调用方可能用它对齐别处的数组）。
    expect(repo.listWordsByIds([first.id, first.id]).map((word) => word.id)).toEqual([
      first.id,
      first.id,
    ]);
  });

  it('归属范围只允许 BUILTIN / LOCAL / acct:<id>（自创形态会让隔离形同虚设）', () => {
    const db = createDatabase();
    const repo = createWordRepository(db);

    expect(() => repo.createWord(makeWordInput({ ownerScope: 'account-1' }))).toThrow(
      InvalidOwnerScopeError,
    );
    expect(() => repo.createWord(makeWordInput({ ownerScope: '' }))).toThrow(InvalidOwnerScopeError);
    expect(accountOwnerScope('u1')).toBe('acct:u1');
    expect(() => accountOwnerScope('  ')).toThrow(InvalidOwnerScopeError);
  });

  it('非法输入抛 InvalidRepositoryInputError（不是静默写脏数据）', () => {
    const db = createDatabase();
    const repo = createWordRepository(db);

    expect(() => repo.createWord(makeWordInput({ lemma: '   ' }))).toThrow(
      InvalidRepositoryInputError,
    );
    expect(() => repo.createWord(makeWordInput({ now: new Date(Number.NaN) }))).toThrow(
      InvalidRepositoryInputError,
    );
    expect(() => repo.createWord(makeWordInput({ deviceId: '' }))).toThrow(
      InvalidRepositoryInputError,
    );
  });
});

describe('词库与收藏', () => {
  it('upsertDeck 创建后可更新（revision 自增、createdAt 不变）', () => {
    const db = createDatabase();
    const repo = createWordRepository(db);

    const deck = repo.upsertDeck(makeDeckInput());
    const renamed = repo.upsertDeck(
      makeDeckInput({ id: deck.id, name: '考研核心', kind: 'CUSTOM', now: LATER }),
    );

    expect(renamed.id).toBe(deck.id);
    expect(renamed.name).toBe('考研核心');
    expect(renamed.kind).toBe('CUSTOM');
    expect(renamed.createdAt).toBe(NOW.toISOString());
    expect(renamed.updatedAt).toBe(LATER.toISOString());
    expect(renamed.revision).toBe(1);
    expect(repo.getDeckById(deck.id)?.name).toBe('考研核心');
  });

  it('listDecks 按归属范围隔离（换账号看不到别人的词库）', () => {
    const db = createDatabase();
    const repo = createWordRepository(db);
    repo.upsertDeck(makeDeckInput({ name: '本地词库' }));
    repo.upsertDeck(makeDeckInput({ name: '账号词库', ownerScope: accountOwnerScope('u1') }));

    expect(repo.listDecks(LOCAL_OWNER_SCOPE).map((deck) => deck.name)).toEqual(['本地词库']);
    expect(repo.listDecks(accountOwnerScope('u1')).map((deck) => deck.name)).toEqual(['账号词库']);
  });

  it('不能把已有词库改到别的账号名下', () => {
    const db = createDatabase();
    const repo = createWordRepository(db);
    const deck = repo.upsertDeck(makeDeckInput());

    expect(() =>
      repo.upsertDeck(makeDeckInput({ id: deck.id, ownerScope: accountOwnerScope('u1') })),
    ).toThrow(InvalidRepositoryInputError);
  });

  it('addDeckWord 幂等；removeDeckWord 软删；再次 add 复活同一条记录', () => {
    const db = createDatabase();
    const repo = createWordRepository(db);
    const deck = repo.upsertDeck(makeDeckInput());
    const word = repo.createWord(makeWordInput());

    repo.addDeckWord(deck.id, word.id, 'dev-1', NOW);
    repo.addDeckWord(deck.id, word.id, 'dev-1', LATER);
    expect(repo.listDeckWordIds(deck.id)).toEqual([word.id]);
    const firstRevision = db.prepare('SELECT revision FROM deck_words').get() as { revision: number };
    expect(firstRevision.revision).toBe(0);

    repo.removeDeckWord(deck.id, word.id, 'dev-1', LATER);
    expect(repo.listDeckWordIds(deck.id)).toEqual([]);

    repo.addDeckWord(deck.id, word.id, 'dev-1', new Date('2025-01-03T00:00:00.000Z'));
    expect(repo.listDeckWordIds(deck.id)).toEqual([word.id]);
    expect(countRows(db, 'deck_words')).toBe(1);
  });

  it('deleteDeck 是软删：listDecks 不再返回、词库行与词库里的词都还在；重复删除是空操作', () => {
    const db = createDatabase();
    const repo = createWordRepository(db);
    const deck = repo.upsertDeck(makeDeckInput());
    const word = repo.createWord(makeWordInput());
    repo.addDeckWord(deck.id, word.id, 'dev-1', NOW);

    repo.deleteDeck(deck.id, 'dev-1', LATER);

    expect(repo.listDecks('LOCAL')).toEqual([]);
    expect(repo.getDeckById(deck.id)).toBeNull();
    // 软删：行还在（deleted_at 有值），词库里的词也还在——删除词库不等于删词。
    expect(countRows(db, 'decks')).toBe(1);
    expect(repo.listDeckWordIds(deck.id)).toEqual([word.id]);
    const deleted = db.prepare('SELECT deleted_at, revision FROM decks WHERE id = ?').get(deck.id) as {
      deleted_at: string | null;
      revision: number;
    };
    expect(deleted.deleted_at).toBe(LATER.toISOString());
    expect(deleted.revision).toBe(1);

    // 幂等：已经删了再删一次，不命中任何行，revision 不再自增。
    repo.deleteDeck(deck.id, 'dev-1', new Date('2025-01-05T00:00:00.000Z'));
    const after = db.prepare('SELECT revision FROM decks WHERE id = ?').get(deck.id) as { revision: number };
    expect(after.revision).toBe(1);
  });
});

describe('writeFrequencyCorpus：三条校验 + 整体回滚', () => {
  /** 造三个词（w-1 高频、w-2/w-3 并列第二）。 */
  function seedWords(db: SqliteDatabase): void {
    seedSource(db, 'src-ngsl');
    const repo = createWordRepository(db);
    for (const lemma of ['abandon', 'ability', 'absent']) {
      repo.createWord(makeWordInput({ lemma, id: `w-${lemma}` }));
    }
  }

  /** 一份自洽的语料：3 个词，第 2 名并列两人。 */
  function makeCorpus(overrides: Partial<FrequencyCorpusInput> = {}): FrequencyCorpusInput {
    return {
      exam: 'CET4',
      corpusVersion: 'ngsl-1.2',
      sourceId: 'src-ngsl',
      totalTokens: 1000,
      knownWordCount: 3,
      entries: [
        { wordId: 'w-abandon', frequency: 100, rank: 1, equalCount: 1 },
        { wordId: 'w-ability', frequency: 90, rank: 2, equalCount: 2 },
        { wordId: 'w-absent', frequency: 90, rank: 2, equalCount: 2 },
      ],
      ...overrides,
    };
  }

  it('并列语料写入成功，round-trip 的 rank/equalCount 与写入逐行相等（不现场重算）', () => {
    const db = createDatabase();
    seedWords(db);
    const repo = createWordRepository(db);
    const corpus = makeCorpus();

    repo.writeFrequencyCorpus(corpus);

    const stored = repo.listFrequencyEntries('CET4', 'ngsl-1.2');
    const expected = corpus.entries.map((entry: FrequencyCorpusEntry) => ({
      wordId: entry.wordId,
      frequency: entry.frequency,
      rank: entry.rank,
      equalCount: entry.equalCount,
      corpusVersion: 'ngsl-1.2',
      sourceId: 'src-ngsl',
    }));
    expect(stored).toEqual(
      [...expected].sort((left, right) => left.rank - right.rank || left.wordId.localeCompare(right.wordId)),
    );
  });

  it('rank 不连续（缺 2）抛 RANK_GAP，且旧语料原样保留', () => {
    const db = createDatabase();
    seedWords(db);
    const repo = createWordRepository(db);
    repo.writeFrequencyCorpus(makeCorpus());

    const broken = makeCorpus({
      entries: [
        { wordId: 'w-abandon', frequency: 100, rank: 1, equalCount: 1 },
        { wordId: 'w-ability', frequency: 90, rank: 3, equalCount: 1 },
        { wordId: 'w-absent', frequency: 90, rank: 3, equalCount: 1 },
      ],
    });

    const error = expectFrequencyMismatch(() => repo.writeFrequencyCorpus(broken), 'RANK_GAP');
    expect(error.message).toMatch(/rank gap at frequency=90 expected=2 actual=3/u);
    expect(repo.listFrequencyEntries('CET4', 'ngsl-1.2')).toHaveLength(3);
    expect(repo.listFrequencyEntries('CET4', 'ngsl-1.2').map((entry) => entry.rank)).toEqual([1, 2, 2]);
  });

  it('并列组里仍写默认 equalCount=1 抛 TIE_GROUP_DEFAULT（team-lead 追加的验收项）', () => {
    const db = createDatabase();
    seedWords(db);
    const repo = createWordRepository(db);

    const broken = makeCorpus({
      entries: [
        { wordId: 'w-abandon', frequency: 100, rank: 1, equalCount: 1 },
        { wordId: 'w-ability', frequency: 90, rank: 2, equalCount: 1 },
        { wordId: 'w-absent', frequency: 90, rank: 2, equalCount: 1 },
      ],
    });

    // 「并列组写了默认值 1」必须与「equalCount 写成别的数」区分开：
    // 前者是导入脚本漏算并列，后者是数据本身有误，处置方式不同。
    const error = expectFrequencyMismatch(
      () => repo.writeFrequencyCorpus(broken),
      'TIE_GROUP_DEFAULT',
    );
    expect(error.message).toMatch(/equal_count mismatch at frequency=90 expected=2 actual=1/u);
    // 整份语料整体回滚：一行都没落地。
    expect(repo.listFrequencyEntries('CET4', 'ngsl-1.2')).toEqual([]);
  });

  it('equalCount 与并列组大小不符（2 人的组写了 3）抛 EQUAL_COUNT_MISMATCH', () => {
    const db = createDatabase();
    seedWords(db);
    const repo = createWordRepository(db);

    const broken = makeCorpus({
      entries: [
        { wordId: 'w-abandon', frequency: 100, rank: 1, equalCount: 1 },
        { wordId: 'w-ability', frequency: 90, rank: 2, equalCount: 3 },
        { wordId: 'w-absent', frequency: 90, rank: 2, equalCount: 3 },
      ],
    });

    const error = expectFrequencyMismatch(
      () => repo.writeFrequencyCorpus(broken),
      'EQUAL_COUNT_MISMATCH',
    );
    expect(error.message).toMatch(/equal_count mismatch at frequency=90 expected=2 actual=3/u);
  });

  it('覆盖词数与 knownWordCount 不符抛 TOTAL_MISMATCH，旧语料保持不变', () => {
    const db = createDatabase();
    seedWords(db);
    const repo = createWordRepository(db);
    repo.writeFrequencyCorpus(makeCorpus());

    const broken = makeCorpus({ knownWordCount: 5 });

    const error = expectFrequencyMismatch(
      () => repo.writeFrequencyCorpus(broken),
      'TOTAL_MISMATCH',
    );
    expect(error.message).toMatch(/knownWordCount mismatch expected=5 actual=3/u);
    // 这条同时守住“校验在事务外”：重导会先 DELETE 同一 (exam, version) 的旧行，
    // 若把校验挪进事务、或退化成“先删后校验”，这里的旧语料就会被删掉。
    expect(repo.listFrequencyEntries('CET4', 'ngsl-1.2').map((entry) => entry.wordId)).toEqual([
      'w-abandon',
      'w-ability',
      'w-absent',
    ]);
    expect(repo.listFrequencyEntries('CET4', 'ngsl-1.2').map((entry) => entry.rank)).toEqual([1, 2, 2]);
  });

  it('同一个词在一份语料里出现两次抛 DUPLICATE_WORD', () => {
    const db = createDatabase();
    seedWords(db);
    const repo = createWordRepository(db);

    const broken = makeCorpus({
      entries: [
        { wordId: 'w-abandon', frequency: 100, rank: 1, equalCount: 1 },
        { wordId: 'w-abandon', frequency: 90, rank: 2, equalCount: 1 },
        { wordId: 'w-absent', frequency: 80, rank: 3, equalCount: 1 },
      ],
    });

    const error = expectFrequencyMismatch(
      () => repo.writeFrequencyCorpus(broken),
      'DUPLICATE_WORD',
    );
    expect(error.message).toContain('w-abandon');
  });

  it('四类失配各报各的 kind（kind 有区分度，不是同一分支的别名）', () => {
    const db = createDatabase();
    seedWords(db);
    const repo = createWordRepository(db);

    const rankGap = makeCorpus({
      entries: [
        { wordId: 'w-abandon', frequency: 100, rank: 1, equalCount: 1 },
        { wordId: 'w-ability', frequency: 90, rank: 3, equalCount: 1 },
        { wordId: 'w-absent', frequency: 80, rank: 4, equalCount: 1 },
      ],
    });
    const tieDefault = makeCorpus({
      entries: [
        { wordId: 'w-abandon', frequency: 100, rank: 1, equalCount: 1 },
        { wordId: 'w-ability', frequency: 90, rank: 2, equalCount: 1 },
        { wordId: 'w-absent', frequency: 90, rank: 2, equalCount: 1 },
      ],
    });
    const equalCountWrong = makeCorpus({
      entries: [
        { wordId: 'w-abandon', frequency: 100, rank: 1, equalCount: 1 },
        { wordId: 'w-ability', frequency: 90, rank: 2, equalCount: 3 },
        { wordId: 'w-absent', frequency: 90, rank: 2, equalCount: 3 },
      ],
    });
    const totalWrong = makeCorpus({ knownWordCount: 9 });

    const kinds = [rankGap, tieDefault, equalCountWrong, totalWrong].map((corpus) => {
      try {
        repo.writeFrequencyCorpus(corpus);
        return 'NO_ERROR';
      } catch (error) {
        return error instanceof FrequencyCorpusMismatchError ? error.kind : 'WRONG_TYPE';
      }
    });

    expect(kinds).toEqual([
      'RANK_GAP',
      'TIE_GROUP_DEFAULT',
      'EQUAL_COUNT_MISMATCH',
      'TOTAL_MISMATCH',
    ]);
    // 四份错误语料一行都不该落地（顺序无关，这里断言总量）。
    expect(repo.listFrequencyEntries('CET4', 'ngsl-1.2')).toEqual([]);
  });

  it('同一 exam+version 换来源重导只留一份语料（读回 2 行，来源是后导入的那个）', () => {
    const db = createDatabase();
    seedWords(db);
    seedSource(db, 'src-other');
    const repo = createWordRepository(db);

    const twoWords = (sourceId: string): FrequencyCorpusInput =>
      makeCorpus({
        sourceId,
        knownWordCount: 2,
        entries: [
          { wordId: 'w-abandon', frequency: 100, rank: 1, equalCount: 1 },
          { wordId: 'w-ability', frequency: 90, rank: 2, equalCount: 1 },
        ],
      });

    repo.writeFrequencyCorpus(twoWords('src-ngsl'));
    repo.writeFrequencyCorpus(twoWords('src-other'));

    const rows = repo.listFrequencyEntries('CET4', 'ngsl-1.2');

    // 主键若含 source_id，这里会是 4 行（两个来源各一份），直接破坏“每词一行”的前提。
    // ⚠️ 但本用例**不足以**单独证明 I1：把主键改回四列时它仍然通过，因为 I2 在同一事务内
    // 按 (exam, corpus_version) 整段删除，旧来源的行根本留不下来。I1 的独立证据是
    // migrations.test.ts 里那条「主键列集合」断言，那条不可删。
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.sourceId)).toEqual(['src-other', 'src-other']);
  });

  it('重导只按 (exam, corpus_version) 清旧行：换来源且新语料更短时旧词不残留', () => {
    const db = createDatabase();
    seedWords(db);
    seedSource(db, 'src-other');
    const repo = createWordRepository(db);
    repo.writeFrequencyCorpus(makeCorpus());

    // 新来源、只含 1 个词：若删除按 (exam, version, source) 过滤，w-ability / w-absent 会残留。
    repo.writeFrequencyCorpus(
      makeCorpus({
        sourceId: 'src-other',
        knownWordCount: 1,
        entries: [{ wordId: 'w-abandon', frequency: 100, rank: 1, equalCount: 1 }],
      }),
    );

    const rows = repo.listFrequencyEntries('CET4', 'ngsl-1.2');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.wordId).toBe('w-abandon');
    expect(rows[0]?.sourceId).toBe('src-other');
  });

  it('重导在写入阶段失败（外键）时旧语料整体回滚，不留半份新语料', () => {
    const db = createDatabase();
    seedWords(db);
    seedSource(db, 'src-other');
    const repo = createWordRepository(db);
    // 原语料：w-abandon(100) / w-ability(90)，来源 src-ngsl。
    repo.writeFrequencyCorpus(
      makeCorpus({
        knownWordCount: 2,
        entries: [
          { wordId: 'w-abandon', frequency: 100, rank: 1, equalCount: 1 },
          { wordId: 'w-ability', frequency: 90, rank: 2, equalCount: 1 },
        ],
      }),
    );

    // 新语料能过全部三条**内存校验**（词数 2、rank 连续、无并列），但第二行的 word_id 在库里不存在，
    // 于是 INSERT 时才被外键拦下——这是“写入阶段失败”，与前面几条“校验阶段失败”是两条不同的路径。
    // 关键点：第一行（w-abandon，frequency 改成 555、来源改成 src-other）在事务内是**写入成功**的，
    // 所以回滚必须同时撤销“DELETE 旧行”和“这一行已经落地的 UPSERT”，不能只回滚失败的那一条。
    const broken = makeCorpus({
      sourceId: 'src-other',
      knownWordCount: 2,
      entries: [
        { wordId: 'w-abandon', frequency: 555, rank: 1, equalCount: 1 },
        { wordId: 'ghost-word', frequency: 90, rank: 2, equalCount: 1 },
      ],
    });

    let thrown: unknown = null;
    try {
      repo.writeFrequencyCorpus(broken);
    } catch (error: unknown) {
      thrown = error;
    }
    // 先确认“确实抛了、抛的是外键约束”，否则后面的“数据没变”可能只是因为压根没执行。
    expect(thrown).not.toBeNull();
    expect((thrown as { code?: unknown }).code).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');

    const rows = repo.listFrequencyEntries('CET4', 'ngsl-1.2');
    // 仍是原来那 2 行：既没被删光，也没被新语料顶替。
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => ({ wordId: row.wordId, frequency: row.frequency, sourceId: row.sourceId })))
      .toEqual([
        { wordId: 'w-abandon', frequency: 100, sourceId: 'src-ngsl' },
        { wordId: 'w-ability', frequency: 90, sourceId: 'src-ngsl' },
      ]);
    expect(rows.map((row) => row.rank)).toEqual([1, 2]);
    // 表里总行数也没变（整卷替换是 DELETE + 多条 INSERT，半份新语料最容易在这里露出来）。
    expect(countRows(db, 'frequency_entries')).toBe(2);
    const ghostRows = db
      .prepare('SELECT COUNT(*) AS total FROM frequency_entries WHERE word_id = ?')
      .get('ghost-word') as { total: number };
    expect(ghostRows.total).toBe(0);
  });

  it('totalTokens 可为 null（来源没给出统计口径时不写 0 冒充）', () => {
    const db = createDatabase();
    seedWords(db);
    const repo = createWordRepository(db);

    repo.writeFrequencyCorpus(makeCorpus({ totalTokens: null }));

    const row = db
      .prepare('SELECT total_tokens FROM frequency_entries LIMIT 1')
      .get() as { total_tokens: number | null };
    expect(row.total_tokens).toBeNull();
  });
});

describe('appendEventAndUpdateState：幂等与原子性', () => {
  /** 造词库 + 三个词，供学习相关用例使用。 */
  function seedDeckAndWords(db: SqliteDatabase): void {
    const repo = createWordRepository(db);
    repo.upsertDeck(makeDeckInput({ id: 'deck-1' }));
    for (const wordId of ['w-1', 'w-2', 'w-3']) {
      repo.createWord(makeWordInput({ id: wordId, lemma: `word-${wordId}` }));
    }
  }

  it('单事务写入事件 + 状态 + 两条发件箱，返回递增的 outboxSeqs', () => {
    const db = createDatabase();
    seedDeckAndWords(db);
    const learning = createLearningRepository(db);
    const sync = createSyncRepository(db);
    const state = makeState({ correctCount: 1, lastReviewedAt: '2025-01-05T01:00:00.000Z' });

    const result = learning.appendEventAndUpdateState(makeEvent(), state);

    expect(result.applied).toBe(true);
    expect(result.outboxSeqs).toHaveLength(2);
    expect(result.outboxSeqs[1]).toBeGreaterThan(result.outboxSeqs[0] ?? 0);
    expect(countRows(db, 'learning_events')).toBe(1);
    expect(learning.getState('deck-1:w-1')).toEqual(state);

    const outbox = sync.listOutbox();
    expect(outbox.map((record) => record.entityType)).toEqual(['LEARNING_EVENT', 'LEARNING_STATE']);
    expect(outbox[0]?.entityId).toBe('evt-1');
    expect(outbox[1]?.entityId).toBe('deck-1:w-1');
    // 发件箱的入队时间取事件时间，而不是本地时钟（回放可复现）。
    expect(outbox[0]?.createdAt).toBe('2025-01-05T01:00:00.000Z');
  });

  it('重复 eventId 返回 applied:false，且不动状态/计数/发件箱', () => {
    const db = createDatabase();
    seedDeckAndWords(db);
    const learning = createLearningRepository(db);
    learning.appendEventAndUpdateState(makeEvent(), makeState({ wrongCount: 1 }));

    const before = {
      state: learning.getState('deck-1:w-1'),
      events: countRows(db, 'learning_events'),
      outbox: countRows(db, 'sync_outbox'),
    };

    const second = learning.appendEventAndUpdateState(
      makeEvent({ isCorrect: false, answeredAt: '2025-01-06T01:00:00.000Z' }),
      makeState({ wrongCount: 9, correctCount: 9 }),
    );

    expect(second).toEqual({ applied: false, outboxSeqs: [] });
    expect(learning.getState('deck-1:w-1')).toEqual(before.state);
    expect(countRows(db, 'learning_events')).toBe(before.events);
    expect(countRows(db, 'sync_outbox')).toBe(before.outbox);
  });

  it('事件与状态主键不一致抛 RepositoryInvariantError，且一行都不留', () => {
    const db = createDatabase();
    seedDeckAndWords(db);
    const learning = createLearningRepository(db);

    try {
      learning.appendEventAndUpdateState(
        makeEvent({ userWordId: 'deck-1:w-2' }),
        makeState({ userWordId: 'deck-1:w-1' }),
      );
      expect.unreachable('应当抛出 RepositoryInvariantError');
    } catch (error) {
      // 断到「哪条不变量、双方各是谁」：只断言错误类会让“串错主键”和“别的不变量”混在一起。
      expect(error).toBeInstanceOf(RepositoryInvariantError);
      if (error instanceof RepositoryInvariantError) {
        expect(error.code).toBe('REPOSITORY_INVARIANT_VIOLATION');
        expect(error.invariant).toBe('event.userWordId === state.userWordId');
        expect(error.detail).toContain('deck-1:w-2');
        expect(error.detail).toContain('deck-1:w-1');
      }
    }

    expect(countRows(db, 'learning_events')).toBe(0);
    expect(countRows(db, 'learning_state')).toBe(0);
    expect(countRows(db, 'sync_outbox')).toBe(0);
  });

  it('syncedAt 非 null 时拒绝写入（本地新事件必须由同步流程回填）', () => {
    const db = createDatabase();
    seedDeckAndWords(db);
    const learning = createLearningRepository(db);

    try {
      learning.appendEventAndUpdateState(
        makeEvent({ syncedAt: '2025-01-05T02:00:00.000Z' }),
        makeState(),
      );
      expect.unreachable('应当抛出 InvalidRepositoryInputError');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRepositoryInputError);
      if (error instanceof InvalidRepositoryInputError) {
        // 断言是**哪个字段**出的问题，避免这条用例被任何一条入参校验"顺手"接住。
        expect(error.field).toBe('syncedAt');
      }
    }
  });

  it('makeUserWordId 拼出稳定的 ${deckId}:${wordId}', () => {
    expect(makeUserWordId('deck-1', 'w-1')).toBe('deck-1:w-1');
    expect(() => makeUserWordId('', 'w-1')).toThrow(InvalidRepositoryInputError);
  });

  it('时间必须是 UTC ISO-8601 毫秒格式：偏移 / 无毫秒 / 本地写法一律拒绝并指出字段', () => {
    const db = createDatabase();
    seedDeckAndWords(db);
    const learning = createLearningRepository(db);

    const cases: {
      readonly field: string;
      readonly event?: Partial<LearningEventRecord>;
      readonly state?: Partial<LearningState>;
    }[] = [
      // 带时区偏移：字典序会把它排到同一时刻之后（`+08:00` 的 12:00 排 04:00Z 之后）。
      { field: 'state.dueAt', state: { dueAt: '2025-06-30T12:00:00+08:00' } },
      // 无毫秒：与带毫秒的值比较时长度不同，边界会错。
      { field: 'answeredAt', event: { answeredAt: '2025-06-30T04:00:00Z' } },
      // 本地/空格写法：既非 UTC 也不可比。
      { field: 'state.lastReviewedAt', state: { lastReviewedAt: '2025-06-30 04:00:00' } },
      // 只有日期：同样是“能 Date.parse 但不能比较”的形态。
      { field: 'state.suppressedAt', state: { suppressedAt: '2025-06-30' } },
    ];

    for (const testCase of cases) {
      try {
        learning.appendEventAndUpdateState(makeEvent(testCase.event), makeState(testCase.state));
        expect.unreachable(`应当拒绝 ${testCase.field}`);
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidRepositoryInputError);
        if (error instanceof InvalidRepositoryInputError) {
          expect(error.field).toBe(testCase.field);
        }
      }
    }

    // 四种写法一条都不许落库（校验在事务内失败也要整体回滚）。
    expect(countRows(db, 'learning_events')).toBe(0);
    expect(countRows(db, 'learning_state')).toBe(0);
  });

  it('标准 UTC 毫秒格式照常入库，listDue 的字符串比较能命中（含 == now 的边界）', () => {
    const db = createDatabase();
    seedDeckAndWords(db);
    const learning = createLearningRepository(db);
    const state = makeState({ dueAt: '2025-01-05T00:00:00.000Z' });

    expect(learning.appendEventAndUpdateState(makeEvent(), state).applied).toBe(true);
    expect(
      learning.listDue('deck-1', new Date('2025-01-06T00:00:00.000Z')).map((item) => item.userWordId),
    ).toEqual(['deck-1:w-1']);
    // due_at <= now，恰好相等也算到期。
    expect(learning.listDue('deck-1', new Date('2025-01-05T00:00:00.000Z'))).toHaveLength(1);
  });
});

describe('查询：到期队列、错词本、日统计、会话', () => {
  /** 造词库 + 三个词。 */
  function seedDeckAndWords(db: SqliteDatabase): void {
    const repo = createWordRepository(db);
    repo.upsertDeck(makeDeckInput({ id: 'deck-1' }));
    for (const wordId of ['w-1', 'w-2', 'w-3']) {
      repo.createWord(makeWordInput({ id: wordId, lemma: `word-${wordId}` }));
    }
  }

  it('listDue 排除 suppressed 与未到期，按 dueAt 升序', () => {
    const db = createDatabase();
    seedDeckAndWords(db);
    const learning = createLearningRepository(db);

    learning.appendEventAndUpdateState(
      makeEvent({ eventId: 'e1' }),
      makeState({ dueAt: '2025-01-05T00:00:00.000Z' }),
    );
    learning.appendEventAndUpdateState(
      makeEvent({ eventId: 'e2', userWordId: 'deck-1:w-2' }),
      makeState({
        userWordId: 'deck-1:w-2',
        wordId: 'w-2',
        dueAt: '2025-02-01T00:00:00.000Z',
      }),
    );
    learning.appendEventAndUpdateState(
      makeEvent({ eventId: 'e3', userWordId: 'deck-1:w-3' }),
      makeState({
        userWordId: 'deck-1:w-3',
        wordId: 'w-3',
        dueAt: '2025-01-06T00:00:00.000Z',
      }),
    );
    db.prepare('UPDATE learning_state SET suppressed_at = ? WHERE user_word_id = ?').run(
      NOW.toISOString(),
      'deck-1:w-3',
    );

    const due = learning.listDue('deck-1', new Date('2025-01-10T00:00:00.000Z'));

    expect(due.map((state) => state.userWordId)).toEqual(['deck-1:w-1']);
    expect(learning.listStatesByDeck('deck-1')).toHaveLength(3);
  });

  it('listMistakes：lastWrongAt 由事件派生（取最近一次答错），只含答错过的词并按错次降序', () => {
    const db = createDatabase();
    seedDeckAndWords(db);
    const learning = createLearningRepository(db);

    // w-1：01-05 错、01-07 错、01-09 对（最近答错时间必须是 01-07，不是 01-09）。
    learning.appendEventAndUpdateState(
      makeEvent({
        eventId: 'e1',
        isCorrect: false,
        answeredAt: '2025-01-05T01:00:00.000Z',
        localDate: '2025-01-05',
      }),
      makeState({ wrongCount: 1 }),
    );
    learning.appendEventAndUpdateState(
      makeEvent({
        eventId: 'e2',
        isCorrect: false,
        answeredAt: '2025-01-07T01:00:00.000Z',
        localDate: '2025-01-07',
      }),
      makeState({ wrongCount: 2 }),
    );
    learning.appendEventAndUpdateState(
      makeEvent({ eventId: 'e3', answeredAt: '2025-01-09T01:00:00.000Z', localDate: '2025-01-09' }),
      makeState({ wrongCount: 2, correctCount: 1 }),
    );
    // w-2：只错一次（错次更少，应排在 w-1 之后）。
    learning.appendEventAndUpdateState(
      makeEvent({
        eventId: 'e4',
        userWordId: 'deck-1:w-2',
        isCorrect: false,
        answeredAt: '2025-01-08T01:00:00.000Z',
        localDate: '2025-01-08',
      }),
      makeState({ userWordId: 'deck-1:w-2', wordId: 'w-2', wrongCount: 1 }),
    );
    // w-3：只答对过，不该出现在错词本里。
    learning.appendEventAndUpdateState(
      makeEvent({ eventId: 'e5', userWordId: 'deck-1:w-3', localDate: '2025-01-08' }),
      makeState({ userWordId: 'deck-1:w-3', wordId: 'w-3', correctCount: 1 }),
    );

    const mistakes = learning.listMistakes('deck-1');

    expect(mistakes.map((mistake) => mistake.userWordId)).toEqual(['deck-1:w-1', 'deck-1:w-2']);
    expect(mistakes[0]).toEqual({
      userWordId: 'deck-1:w-1',
      wordId: 'w-1',
      wrongCount: 2,
      correctCount: 1,
      lastWrongAt: '2025-01-07T01:00:00.000Z',
    });
    expect(mistakes[1]?.lastWrongAt).toBe('2025-01-08T01:00:00.000Z');
  });

  it('listDailyStats 按 local_date 分组，activeMs 把 null 当 0', () => {
    const db = createDatabase();
    seedDeckAndWords(db);
    const learning = createLearningRepository(db);

    learning.appendEventAndUpdateState(
      makeEvent({ eventId: 'e1', durationMs: 3000 }),
      makeState(),
    );
    learning.appendEventAndUpdateState(
      makeEvent({ eventId: 'e2', isCorrect: false, durationMs: null, answeredAt: '2025-01-05T02:00:00.000Z' }),
      makeState({ wrongCount: 1 }),
    );
    learning.appendEventAndUpdateState(
      makeEvent({
        eventId: 'e3',
        userWordId: 'deck-1:w-2',
        durationMs: 1000,
        answeredAt: '2025-01-06T01:00:00.000Z',
        localDate: '2025-01-06',
      }),
      makeState({ userWordId: 'deck-1:w-2', wordId: 'w-2' }),
    );

    expect(learning.listDailyStats('2025-01-01', '2025-01-31')).toEqual([
      { localDate: '2025-01-05', total: 2, correct: 1, wrong: 1, activeMs: 3000 },
      { localDate: '2025-01-06', total: 1, correct: 1, wrong: 0, activeMs: 1000 },
    ]);
    expect(learning.listDailyStats('2025-01-06', '2025-01-06')).toHaveLength(1);
  });

  it('upsertSession 可更新同一会话（revision 自增），listSessions 按时间窗过滤', () => {
    const db = createDatabase();
    seedDeckAndWords(db);
    const learning = createLearningRepository(db);
    const session = {
      sessionId: 'sess-1',
      deckId: 'deck-1',
      startedAt: '2025-01-05T01:00:00.000Z',
      endedAt: null,
      localDate: '2025-01-05',
      timeZone: 'Asia/Shanghai',
      newCount: 0,
      reviewCount: 0,
      activeDurationMs: 0,
      planSnapshotJson: null,
      deviceId: 'dev-1',
      revision: 0,
    };

    learning.upsertSession(session);
    learning.upsertSession({
      ...session,
      endedAt: '2025-01-05T01:30:00.000Z',
      newCount: 10,
      reviewCount: 20,
      activeDurationMs: 1_800_000,
      planSnapshotJson: '{"dailyNewLimit":10}',
      revision: 1,
    });

    const sessions = learning.listSessions('2025-01-01T00:00:00.000Z', '2025-01-10T00:00:00.000Z');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.newCount).toBe(10);
    expect(sessions[0]?.reviewCount).toBe(20);
    expect(sessions[0]?.endedAt).toBe('2025-01-05T01:30:00.000Z');
    expect(sessions[0]?.revision).toBe(1);
    expect(learning.listSessions('2025-02-01T00:00:00.000Z', '2025-02-10T00:00:00.000Z')).toEqual([]);
  });
});

describe('设置与学习时段', () => {
  it('set/get/getAll 往返字符串，不替调用方解析 JSON', () => {
    const db = createDatabase();
    const settings = createSettingsRepository(db);

    settings.set('dailyNewLimit', '{"value":20}', 'dev-1', NOW);
    settings.set('timeZone', '"Asia/Shanghai"', 'dev-1', NOW);

    expect(settings.get('dailyNewLimit')).toBe('{"value":20}');
    expect(settings.getAll()).toEqual({
      dailyNewLimit: '{"value":20}',
      timeZone: '"Asia/Shanghai"',
    });
    expect(settings.get('missing')).toBeNull();
  });

  it('remove 是软删除：读不到但行还在（删除要能同步），再次 set 复活', () => {
    const db = createDatabase();
    const settings = createSettingsRepository(db);
    settings.set('dailyNewLimit', '20', 'dev-1', NOW);

    settings.remove('dailyNewLimit', 'dev-1', LATER);

    expect(settings.get('dailyNewLimit')).toBeNull();
    expect(settings.getAll()).toEqual({});
    expect(countRows(db, 'settings')).toBe(1);
    const row = db.prepare('SELECT deleted_at FROM settings WHERE key = ?').get('dailyNewLimit') as {
      deleted_at: string | null;
    };
    expect(row.deleted_at).toBe(LATER.toISOString());

    settings.set('dailyNewLimit', '30', 'dev-1', LATER);
    expect(settings.get('dailyNewLimit')).toBe('30');
    expect(countRows(db, 'settings')).toBe(1);
  });

  it('replacePlanWindows 全量替换：旧时段软删、新时段写入、同 id 复活不重复', () => {
    const db = createDatabase();
    const settings = createSettingsRepository(db);
    const morning: PlanWindowRecord = {
      id: 'win-1',
      effectiveLocalDate: '2025-01-01',
      startMinute: 7 * 60,
      endMinute: 8 * 60,
      timeZone: 'Asia/Shanghai',
      updatedAt: NOW.toISOString(),
      deviceId: 'dev-1',
      revision: 0,
      deletedAt: null,
    };
    const evening: PlanWindowRecord = {
      ...morning,
      id: 'win-2',
      startMinute: 20 * 60,
      endMinute: 22 * 60,
    };

    settings.replacePlanWindows([evening, morning], 'dev-1', NOW);
    expect(settings.listPlanWindows().map((window) => window.id)).toEqual(['win-1', 'win-2']);

    // 只保留 evening：morning 被软删，不出现在列表里，但行仍在。
    settings.replacePlanWindows([evening], 'dev-1', LATER);
    expect(settings.listPlanWindows().map((window) => window.id)).toEqual(['win-2']);
    // revision 走两次：软删旧行 +1、复活新行 +1——每次写都是一次可同步的变更。
    expect(settings.listPlanWindows()[0]?.revision).toBe(2);
    expect(countRows(db, 'plan_windows')).toBe(2);

    // 再次传回 morning：同 id 复活，不会插出第二行。
    settings.replacePlanWindows([morning], 'dev-1', new Date('2025-01-03T00:00:00.000Z'));
    expect(settings.listPlanWindows().map((window) => window.id)).toEqual(['win-1']);
    expect(countRows(db, 'plan_windows')).toBe(2);
  });

  it('非法时段（结束早于开始 / 分钟越界）抛 InvalidRepositoryInputError 且不写入', () => {
    const db = createDatabase();
    const settings = createSettingsRepository(db);
    const base: PlanWindowRecord = {
      id: 'win-1',
      effectiveLocalDate: '2025-01-01',
      startMinute: 7 * 60,
      endMinute: 8 * 60,
      timeZone: 'Asia/Shanghai',
      updatedAt: NOW.toISOString(),
      deviceId: 'dev-1',
      revision: 0,
      deletedAt: null,
    };

    expect(() =>
      settings.replacePlanWindows([{ ...base, startMinute: 600, endMinute: 600 }], 'dev-1', NOW),
    ).toThrow(InvalidRepositoryInputError);
    expect(() =>
      settings.replacePlanWindows([{ ...base, startMinute: -1 }], 'dev-1', NOW),
    ).toThrow(InvalidRepositoryInputError);
    expect(() =>
      settings.replacePlanWindows([{ ...base, endMinute: 1441 }], 'dev-1', NOW),
    ).toThrow(InvalidRepositoryInputError);
    expect(settings.listPlanWindows()).toEqual([]);
  });
});

describe('D-04：会话/词库事件查询、状态更新、来源与语料元信息', () => {
  /** 造词库 + 三个词。 */
  function seedDeckAndWords(db: SqliteDatabase): void {
    const repo = createWordRepository(db);
    repo.upsertDeck(makeDeckInput({ id: 'deck-1' }));
    for (const wordId of ['w-1', 'w-2', 'w-3']) {
      repo.createWord(makeWordInput({ id: wordId, lemma: `word-${wordId}` }));
    }
  }

  it('listEventsBySession 只返回该会话的事件，按 answeredAt 升序', () => {
    const db = createDatabase();
    seedDeckAndWords(db);
    const learning = createLearningRepository(db);

    learning.appendEventAndUpdateState(
      makeEvent({ eventId: 'e1', answeredAt: '2025-01-05T01:00:00.000Z' }),
      makeState(),
    );
    learning.appendEventAndUpdateState(
      makeEvent({ eventId: 'e2', answeredAt: '2025-01-05T01:05:00.000Z' }),
      makeState({ correctCount: 1 }),
    );
    learning.appendEventAndUpdateState(
      makeEvent({ eventId: 'e3', sessionId: 'sess-2', userWordId: 'deck-1:w-2' }),
      makeState({ userWordId: 'deck-1:w-2', wordId: 'w-2' }),
    );

    const events = learning.listEventsBySession('sess-1');
    expect(events.map((event) => event.eventId)).toEqual(['e1', 'e2']);
    // 事件记录必须是完整投影（`is_correct` 要还原成布尔，否则 `if (event.isCorrect)` 恒真）。
    expect(events[0]?.isCorrect).toBe(true);
    expect(events[0]?.durationMs).toBe(3200);
    expect(events[0]?.syncedAt).toBeNull();
    expect(learning.listEventsBySession('sess-none')).toEqual([]);
  });

  it('listEventsByDeck 是闭区间，且两端都过 ISO 严格校验', () => {
    const db = createDatabase();
    seedDeckAndWords(db);
    const learning = createLearningRepository(db);
    for (const [eventId, answeredAt] of [
      ['e1', '2025-01-05T01:00:00.000Z'],
      ['e2', '2025-01-06T01:00:00.000Z'],
      ['e3', '2025-01-07T01:00:00.000Z'],
    ] as const) {
      learning.appendEventAndUpdateState(makeEvent({ eventId, answeredAt }), makeState());
    }

    // 端点都要包含（评估窗口 `now - 90 天 ~ now` 会把“恰好 90 天前”算进来）。
    const inRange = learning.listEventsByDeck(
      'deck-1',
      '2025-01-05T01:00:00.000Z',
      '2025-01-06T01:00:00.000Z',
    );
    expect(inRange.map((event) => event.eventId)).toEqual(['e1', 'e2']);

    // 乱格式必须在**进 SQL 之前**被拒：字典序比较对 `+08:00`、无毫秒、空格写法都会静默出错。
    for (const bad of ['2025-01-05T09:00:00+08:00', '2025-01-05T01:00:00Z', '2025-01-05 01:00:00']) {
      expect(() => learning.listEventsByDeck('deck-1', bad, '2025-01-06T01:00:00.000Z')).toThrow(
        InvalidRepositoryInputError,
      );
      expect(() => learning.listEventsByDeck('deck-1', '2025-01-05T01:00:00.000Z', bad)).toThrow(
        InvalidRepositoryInputError,
      );
    }
  });

  it('updateState 只动状态：不发事件、发件箱 +1、保留 last_result', () => {
    const db = createDatabase();
    seedDeckAndWords(db);
    const learning = createLearningRepository(db);
    const sync = createSyncRepository(db);
    learning.appendEventAndUpdateState(makeEvent({ isCorrect: false }), makeState({ wrongCount: 1 }));

    const before = {
      events: countRows(db, 'learning_events'),
      outbox: sync.listOutbox().length,
      revision: (db
        .prepare('SELECT revision FROM learning_state WHERE user_word_id = ?')
        .get('deck-1:w-1') as { revision: number }).revision,
    };

    const suppressed = { ...makeState({ wrongCount: 1 }), suppressedAt: LATER.toISOString() };
    learning.updateState(suppressed, 'dev-1', LATER);

    expect(countRows(db, 'learning_events')).toBe(before.events);
    expect(learning.getState('deck-1:w-1')).toEqual(suppressed);
    const outbox = sync.listOutbox();
    expect(outbox).toHaveLength(before.outbox + 1);
    expect(outbox[outbox.length - 1]?.entityType).toBe('LEARNING_STATE');
    expect(outbox[outbox.length - 1]?.createdAt).toBe(LATER.toISOString());
    const after = db
      .prepare('SELECT revision, last_result FROM learning_state WHERE user_word_id = ?')
      .get('deck-1:w-1') as { revision: number; last_result: string | null };
    expect(after.revision).toBe(before.revision + 1);
    // 抑制不是一次作答：不能把上一次的真实结果覆盖成空。
    expect(after.last_result).toBe('WRONG');

    // 恢复（suppressedAt -> null）同样只动状态。
    learning.updateState({ ...suppressed, suppressedAt: null }, 'dev-1', LATER);
    expect(learning.getState('deck-1:w-1')?.suppressedAt).toBeNull();
    expect(countRows(db, 'learning_events')).toBe(before.events);
  });

  it('updateState 对没有状态的词也能建行（用户还没学过就想屏蔽）', () => {
    const db = createDatabase();
    seedDeckAndWords(db);
    const learning = createLearningRepository(db);

    learning.updateState(
      { ...makeState({ userWordId: 'deck-1:w-3', wordId: 'w-3' }), suppressedAt: NOW.toISOString() },
      'dev-1',
      NOW,
    );

    const state = learning.getState('deck-1:w-3');
    expect(state?.suppressedAt).toBe(NOW.toISOString());
    expect(state?.wrongCount).toBe(0);
  });

  it('getSession 按 id 读会话，缺失返回 null', () => {
    const db = createDatabase();
    seedDeckAndWords(db);
    const learning = createLearningRepository(db);
    learning.upsertSession({
      sessionId: 'sess-1',
      deckId: 'deck-1',
      startedAt: '2025-01-05T01:00:00.000Z',
      endedAt: null,
      localDate: '2025-01-05',
      timeZone: 'Asia/Shanghai',
      newCount: 2,
      reviewCount: 1,
      activeDurationMs: 0,
      planSnapshotJson: '{"timeZone":"Asia/Shanghai"}',
      deviceId: 'dev-1',
      revision: 0,
    });

    const session = learning.getSession('sess-1');
    expect(session?.deckId).toBe('deck-1');
    expect(session?.endedAt).toBeNull();
    expect(session?.newCount).toBe(2);
    expect(learning.getSession('sess-none')).toBeNull();
  });

  it('upsertSource 幂等：同内容两次只一行且 revision 不变；改内容才 +1', () => {
    const db = createDatabase();
    const repo = createWordRepository(db);

    const first = repo.upsertSource({
      id: 'local-user',
      ownerScope: LOCAL_OWNER_SCOPE,
      type: 'USER',
      name: '本地自建',
      redistributionAllowed: false,
      deviceId: 'dev-1',
      now: NOW,
    });
    expect(first.id).toBe('local-user');
    expect(first.type).toBe('USER');
    expect(first.redistributionAllowed).toBe(false);
    expect(first.revision).toBe(0);
    expect(first.importedAt).toBe(NOW.toISOString());

    const second = repo.upsertSource({
      id: 'local-user',
      ownerScope: LOCAL_OWNER_SCOPE,
      type: 'USER',
      name: '本地自建',
      redistributionAllowed: false,
      deviceId: 'dev-1',
      now: LATER,
    });
    // 内容一致 → 不写。否则服务层每次建自建词都会推一次 revision，同步永远有变更。
    expect(second.revision).toBe(0);
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(countRows(db, 'sources')).toBe(1);

    const renamed = repo.upsertSource({
      id: 'local-user',
      ownerScope: LOCAL_OWNER_SCOPE,
      type: 'USER',
      name: '我的自建词',
      redistributionAllowed: false,
      deviceId: 'dev-1',
      now: LATER,
    });
    expect(renamed.revision).toBe(1);
    expect(renamed.name).toBe('我的自建词');
    expect(countRows(db, 'sources')).toBe(1);
  });

  it('upsertSource 拒绝非法类型与非布尔许可标记', () => {
    const db = createDatabase();
    const repo = createWordRepository(db);

    expect(() =>
      repo.upsertSource({
        ownerScope: LOCAL_OWNER_SCOPE,
        // 故意绕过类型，验证运行时也拦得住（JS 调用方/IPC 反序列化都可能送进来）。
        type: 'DICTIONARY' as unknown as 'USER',
        name: '词典',
        redistributionAllowed: true,
        deviceId: 'dev-1',
        now: NOW,
      }),
    ).toThrow(InvalidRepositoryInputError);
    expect(() =>
      repo.upsertSource({
        ownerScope: LOCAL_OWNER_SCOPE,
        type: 'USER',
        name: '本地自建',
        redistributionAllowed: 'yes' as unknown as boolean,
        deviceId: 'dev-1',
        now: NOW,
      }),
    ).toThrow(InvalidRepositoryInputError);
    expect(countRows(db, 'sources')).toBe(0);
  });

  it('getFrequencyCorpusMeta 无记录返回 null，导入后给出 totalTokens 与来源', () => {
    const db = createDatabase();
    seedSource(db, 'src-ngsl');
    const repo = createWordRepository(db);
    repo.createWord(makeWordInput({ id: 'w-1', lemma: 'abandon' }));

    expect(repo.getFrequencyCorpusMeta('CET4', 'ngsl-1.2')).toBeNull();

    repo.writeFrequencyCorpus({
      exam: 'CET4',
      corpusVersion: 'ngsl-1.2',
      sourceId: 'src-ngsl',
      totalTokens: 12345,
      knownWordCount: 1,
      entries: [{ wordId: 'w-1', frequency: 100, rank: 1, equalCount: 1 }],
    });

    expect(repo.getFrequencyCorpusMeta('CET4', 'ngsl-1.2')).toMatchObject({
      totalTokens: 12345,
      sourceId: 'src-ngsl',
    });
    // totalTokens 为 null 时也如实返回 null（不编造成 0）。
    repo.writeFrequencyCorpus({
      exam: 'CET4',
      corpusVersion: 'ngsl-1.3',
      sourceId: 'src-ngsl',
      totalTokens: null,
      knownWordCount: 1,
      entries: [{ wordId: 'w-1', frequency: 5, rank: 1, equalCount: 1 }],
    });
    expect(repo.getFrequencyCorpusMeta('CET4', 'ngsl-1.3')?.totalTokens).toBeNull();
  });
});
