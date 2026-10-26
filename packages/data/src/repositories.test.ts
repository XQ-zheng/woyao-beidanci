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

    expect(() => repo.writeFrequencyCorpus(broken)).toThrow(
      /rank gap at frequency=90 expected=2 actual=3/u,
    );
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

    expect(() => repo.writeFrequencyCorpus(broken)).toThrow(
      /equal_count mismatch at frequency=90 expected=2 actual=1/u,
    );
    // 「并列组写了默认值 1」必须与「equalCount 写错成别的数」区分开：
    // 前者是导入脚本漏算并列，后者是数据本身有误，处置方式不同。
    try {
      repo.writeFrequencyCorpus(broken);
      expect.unreachable('应当抛出 FrequencyCorpusMismatchError');
    } catch (error) {
      expect(error).toBeInstanceOf(FrequencyCorpusMismatchError);
      if (error instanceof FrequencyCorpusMismatchError) {
        expect(error.kind).toBe('TIE_GROUP_DEFAULT');
      }
    }
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

    try {
      repo.writeFrequencyCorpus(broken);
      expect.unreachable('应当抛出 FrequencyCorpusMismatchError');
    } catch (error) {
      expect(error).toBeInstanceOf(FrequencyCorpusMismatchError);
      if (error instanceof FrequencyCorpusMismatchError) {
        expect(error.kind).toBe('EQUAL_COUNT_MISMATCH');
      }
    }
  });

  it('覆盖词数与 knownWordCount 不符抛 TOTAL_MISMATCH，旧语料保持不变', () => {
    const db = createDatabase();
    seedWords(db);
    const repo = createWordRepository(db);
    repo.writeFrequencyCorpus(makeCorpus());

    const broken = makeCorpus({ knownWordCount: 5 });

    expect(() => repo.writeFrequencyCorpus(broken)).toThrow(
      /knownWordCount mismatch expected=5 actual=3/u,
    );
    expect(repo.listFrequencyEntries('CET4', 'ngsl-1.2').map((entry) => entry.wordId)).toEqual([
      'w-abandon',
      'w-ability',
      'w-absent',
    ]);
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

    expect(() => repo.writeFrequencyCorpus(broken)).toThrow(FrequencyCorpusMismatchError);
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

    expect(() =>
      learning.appendEventAndUpdateState(
        makeEvent({ userWordId: 'deck-1:w-2' }),
        makeState({ userWordId: 'deck-1:w-1' }),
      ),
    ).toThrow(RepositoryInvariantError);

    expect(countRows(db, 'learning_events')).toBe(0);
    expect(countRows(db, 'learning_state')).toBe(0);
    expect(countRows(db, 'sync_outbox')).toBe(0);
  });

  it('syncedAt 非 null 时拒绝写入（本地新事件必须由同步流程回填）', () => {
    const db = createDatabase();
    seedDeckAndWords(db);
    const learning = createLearningRepository(db);

    expect(() =>
      learning.appendEventAndUpdateState(
        makeEvent({ syncedAt: '2025-01-05T02:00:00.000Z' }),
        makeState(),
      ),
    ).toThrow(InvalidRepositoryInputError);
  });

  it('makeUserWordId 拼出稳定的 ${deckId}:${wordId}', () => {
    expect(makeUserWordId('deck-1', 'w-1')).toBe('deck-1:w-1');
    expect(() => makeUserWordId('', 'w-1')).toThrow(InvalidRepositoryInputError);
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
