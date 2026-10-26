import { describe, expect, it } from 'vitest';

import type { LearningState } from '@woyao/core';

import type { SqliteDatabase } from './connection';
import { migrate, openDatabase } from './connection';
import {
  FrequencyCorpusMismatchError,
  InvalidRepositoryInputError,
} from './errors';
import type { FrequencyCorpusInput, LearningEventRecord } from './index';
import {
  createLearningRepository,
  createSettingsRepository,
  createWordRepository,
} from './index';

/** 迁移过的内存库。 */
function createDatabase(): SqliteDatabase {
  const db = openDatabase(':memory:');
  migrate(db, { now: new Date('2025-01-01T00:00:00.000Z') });
  return db;
}

/** 造一个词库（`learning_state` 有外键，必须先有 deck）。 */
function seedDeck(db: SqliteDatabase, deckId = 'deck-1'): void {
  db.prepare(
    `INSERT INTO decks (id, owner_scope, name, kind, created_at, updated_at)
     VALUES (?, 'LOCAL', ?, 'BUILTIN', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
  ).run(deckId, `词库-${deckId}`);
}

/** 造一条学习状态。 */
function makeState(overrides: Partial<LearningState> = {}): LearningState {
  return {
    userWordId: 'deck-1:w-1',
    deckId: 'deck-1',
    wordId: 'w-1',
    stage: -1,
    dueAt: '2025-02-01T01:00:00.000Z',
    lastReviewedAt: null,
    correctCount: 0,
    wrongCount: 0,
    streakCorrect: 0,
    weight: 1,
    suppressedAt: null,
    ...overrides,
  };
}

/** 造一条作答事件。 */
function makeEvent(overrides: Partial<LearningEventRecord> = {}): LearningEventRecord {
  return {
    eventId: 'evt-1',
    userWordId: 'deck-1:w-1',
    deckId: 'deck-1',
    wordId: 'w-1',
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
    ...overrides,
  };
}

/** 造一份自洽的词频语料（2 个词并列在 rank 1）。 */
function makeCorpus(
  overrides: Partial<FrequencyCorpusInput> = {},
): FrequencyCorpusInput {
  return {
    corpusVersion: 'ngsl-1.2',
    sourceId: 'src-ngsl',
    exam: 'CET4',
    knownWordCount: 2,
    entries: [
      { wordId: 'w-1', frequency: 100, totalTokens: 1000, rank: 1, equalCount: 2 },
      { wordId: 'w-2', frequency: 100, totalTokens: 1000, rank: 1, equalCount: 2 },
    ],
    now: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** 建库 + 词库 + 两个词 + 语料来源，供词频测试使用。 */
function seedForFrequency(): {
  db: SqliteDatabase;
  words: ReturnType<typeof createWordRepository>;
} {
  const db = createDatabase();
  seedDeck(db);
  const words = createWordRepository(db);
  words.createWord({ id: 'w-1', lemma: 'abandon', now: '2025-01-01T00:00:00.000Z' });
  words.createWord({ id: 'w-2', lemma: 'ability', now: '2025-01-01T00:00:00.000Z' });
  db.prepare(
    `INSERT INTO sources (id, owner_scope, type, name, created_at, updated_at)
     VALUES ('src-ngsl', 'LOCAL', 'FREQUENCY', 'NGSL', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
  ).run();
  return { db, words };
}

describe('createWord：幂等与标准化', () => {
  it('同一词形重复导入返回同一条记录，不撞唯一键', () => {
    const db = createDatabase();
    const repo = createWordRepository(db);

    const first = repo.createWord({ lemma: 'abandon', now: '2025-01-01T00:00:00.000Z' });
    const second = repo.createWord({ lemma: 'abandon', now: '2025-01-02T00:00:00.000Z' });

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe('2025-01-01T00:00:00.000Z');
    expect(second.updatedAt).toBe('2025-01-02T00:00:00.000Z');
    const count = db.prepare('SELECT COUNT(*) AS n FROM words').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('大小写与首尾/连续空白都归一到同一个词条', () => {
    const db = createDatabase();
    const repo = createWordRepository(db);

    const created = repo.createWord({ lemma: 'Abandon', now: '2025-01-01T00:00:00.000Z' });

    expect(created.normalizedLemma).toBe('abandon');
    expect(created.lemma).toBe('Abandon');
    expect(repo.getWordByLemma('  abandon ')?.id).toBe(created.id);
    expect(repo.getWordByLemma('ice  cream')).toBeNull();
  });

  it('getWordByLemma 按 ownerScope 隔离：不同账号互不可见', () => {
    const db = createDatabase();
    const repo = createWordRepository(db);

    repo.createWord({ lemma: 'abandon', ownerScope: 'account-a', now: '2025-01-01T00:00:00.000Z' });

    expect(repo.getWordByLemma('abandon', 'account-a')).not.toBeNull();
    expect(repo.getWordByLemma('abandon', 'account-b')).toBeNull();
    expect(repo.getWordByLemma('abandon')).toBeNull();
  });

  it('义项按 senseNo 排序，且重复导入不会重复插入', () => {
    const db = createDatabase();
    const repo = createWordRepository(db);

    const word = repo.createWord({
      lemma: 'abandon',
      now: '2025-01-01T00:00:00.000Z',
      senses: [
        { senseNo: 2, pos: 'v.', simpleZh: '抛弃' },
        { senseNo: 1, pos: 'v.', simpleZh: '放弃' },
      ],
    });
    repo.createWord({
      lemma: 'abandon',
      now: '2025-01-02T00:00:00.000Z',
      senses: [{ senseNo: 1, pos: 'v.', simpleZh: '放弃' }],
    });

    const senses = repo.listSenses(word.id);
    expect(senses.map((sense) => sense.senseNo)).toEqual([1, 2]);
    expect(senses.map((sense) => sense.simpleZh)).toEqual(['放弃', '抛弃']);
  });

  it('空词形与空释义抛类型化错误', () => {
    const db = createDatabase();
    const repo = createWordRepository(db);

    expect(() => repo.createWord({ lemma: '   ' })).toThrow(InvalidRepositoryInputError);
    expect(() => repo.createWord({ lemma: 'ok', senses: [{ simpleZh: ' ' }] })).toThrow(
      InvalidRepositoryInputError,
    );
  });
});

describe('appendEventAndUpdateState：事务性与幂等', () => {
  it('首次作答同时写入事件与状态', () => {
    const db = createDatabase();
    seedDeck(db);
    const repo = createLearningRepository(db);
    createWordRepository(db).createWord({ id: 'w-1', lemma: 'abandon', now: '2025-01-01T00:00:00.000Z' });

    const result = repo.appendEventAndUpdateState(makeEvent(), makeState({ stage: 0 }));

    expect(result.applied).toBe(true);
    expect(repo.getState('deck-1:w-1')).toMatchObject({ stage: 0, correctCount: 0 });
    const rows = db.prepare('SELECT COUNT(*) AS n FROM learning_events').get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('重复 eventId 返回 applied:false，且不动状态/计数/发件箱', () => {
    const db = createDatabase();
    seedDeck(db);
    const repo = createLearningRepository(db);
    createWordRepository(db).createWord({ id: 'w-1', lemma: 'abandon', now: '2025-01-01T00:00:00.000Z' });

    repo.appendEventAndUpdateState(
      makeEvent(),
      makeState({ stage: 0, correctCount: 1, streakCorrect: 1, lastReviewedAt: '2025-01-05T01:00:00.000Z' }),
      {
        outbox: [
          { entityType: 'LEARNING_STATE', entityId: 'deck-1:w-1', operation: 'UPSERT', payload: { stage: 0 } },
        ],
      },
    );
    const before = repo.getState('deck-1:w-1');

    // 同一 eventId 再提交一次，但带一个“更靠后”的状态，验证它被完全忽略。
    const replay = repo.appendEventAndUpdateState(
      makeEvent(),
      makeState({ stage: 3, correctCount: 99, streakCorrect: 99 }),
      {
        outbox: [
          { entityType: 'LEARNING_STATE', entityId: 'deck-1:w-1', operation: 'UPSERT', payload: { stage: 3 } },
        ],
      },
    );

    expect(replay.applied).toBe(false);
    expect(repo.getState('deck-1:w-1')).toEqual(before);
    const events = db.prepare('SELECT COUNT(*) AS n FROM learning_events').get() as { n: number };
    const outbox = db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get() as { n: number };
    expect(events.n).toBe(1);
    expect(outbox.n).toBe(1);
  });

  it('事件、状态与发件箱在同一事务：发件箱写入失败时全部回滚', () => {
    const db = createDatabase();
    seedDeck(db);
    const repo = createLearningRepository(db);
    createWordRepository(db).createWord({ id: 'w-1', lemma: 'abandon', now: '2025-01-01T00:00:00.000Z' });

    expect(() =>
      repo.appendEventAndUpdateState(makeEvent(), makeState({ stage: 0 }), {
        // entityId 为空 → enqueueOutboxWithin 抛错 → 整个事务回滚
        outbox: [{ entityType: 'LEARNING_STATE', entityId: '  ', operation: 'UPSERT', payload: {} }],
      }),
    ).toThrow(InvalidRepositoryInputError);

    const events = db.prepare('SELECT COUNT(*) AS n FROM learning_events').get() as { n: number };
    const states = db.prepare('SELECT COUNT(*) AS n FROM learning_state').get() as { n: number };
    const outbox = db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get() as { n: number };
    expect(events.n).toBe(0);
    expect(states.n).toBe(0);
    expect(outbox.n).toBe(0);
  });

  it('事件与状态主键不一致时拒绝写入（避免把状态写到别的词上）', () => {
    const db = createDatabase();
    seedDeck(db);
    const repo = createLearningRepository(db);

    expect(() =>
      repo.appendEventAndUpdateState(makeEvent(), makeState({ userWordId: 'deck-1:w-2' })),
    ).toThrow(InvalidRepositoryInputError);
  });

  it('非法事件字段抛类型化错误（不把脏数据写进事实表）', () => {
    const db = createDatabase();
    seedDeck(db);
    const repo = createLearningRepository(db);

    expect(() =>
      repo.appendEventAndUpdateState(
        makeEvent({ mode: 'AUDIO' as unknown as LearningEventRecord['mode'] }),
        makeState(),
      ),
    ).toThrow(InvalidRepositoryInputError);
    expect(() =>
      repo.appendEventAndUpdateState(makeEvent({ localDate: '2025/01/05' }), makeState()),
    ).toThrow(InvalidRepositoryInputError);
  });
});

describe('listDue / listMistakes', () => {
  /** 造 3 条到期的状态 + 1 条已屏蔽 + 1 条未到期。 */
  function seedStates(db: SqliteDatabase): void {
    seedDeck(db);
    const words = createWordRepository(db);
    for (const [index, lemma] of ['abandon', 'ability', 'borrow', 'collect', 'desert'].entries()) {
      words.createWord({ id: `w-${index + 1}`, lemma, now: '2025-01-01T00:00:00.000Z' });
    }
    const insert = db.prepare(
      `INSERT INTO learning_state
         (user_word_id, deck_id, word_id, stage, due_at, correct_count, wrong_count, streak_correct,
          weight, suppressed_at, state_updated_at)
       VALUES (?, 'deck-1', ?, 0, ?, 0, 0, 0, 1, ?, '2025-01-01T00:00:00.000Z')`,
    );
    insert.run('deck-1:w-2', 'w-2', '2025-01-10T01:00:00.000Z', null);
    insert.run('deck-1:w-1', 'w-1', '2025-01-05T01:00:00.000Z', null);
    insert.run('deck-1:w-3', 'w-3', '2025-01-08T01:00:00.000Z', '2025-01-02T00:00:00.000Z');
    insert.run('deck-1:w-4', 'w-4', '2025-06-01T01:00:00.000Z', null);
  }

  it('listDue 只返回未屏蔽且已到期的，按到期时间升序', () => {
    const db = createDatabase();
    seedStates(db);
    const repo = createLearningRepository(db);

    const due = repo.listDue('deck-1', new Date('2025-01-20T00:00:00.000Z'));

    expect(due.map((state) => state.userWordId)).toEqual(['deck-1:w-1', 'deck-1:w-2']);
  });

  it('listDue 与 due_at 边界一致（恰好到期算到期）', () => {
    const db = createDatabase();
    seedStates(db);
    const repo = createLearningRepository(db);

    const due = repo.listDue('deck-1', new Date('2025-01-10T01:00:00.000Z'));

    expect(due.map((state) => state.userWordId)).toEqual(['deck-1:w-1', 'deck-1:w-2']);
  });

  it('listMistakes 的 lastWrongAt 由事件派生，并按最近答错排序', () => {
    const db = createDatabase();
    seedStates(db);
    const repo = createLearningRepository(db);
    const words = createWordRepository(db);

    // w-1 错两次（最近 01-07），w-2 错一次（01-09）
    repo.appendEventAndUpdateState(
      makeEvent({ eventId: 'e1', userWordId: 'deck-1:w-1', wordId: 'w-1', isCorrect: false, recognition: 'UNKNOWN', answeredAt: '2025-01-05T01:00:00.000Z', localDate: '2025-01-05' }),
      makeState({ userWordId: 'deck-1:w-1', wordId: 'w-1', wrongCount: 1 }),
    );
    repo.appendEventAndUpdateState(
      makeEvent({ eventId: 'e2', userWordId: 'deck-1:w-1', wordId: 'w-1', isCorrect: false, recognition: 'UNKNOWN', answeredAt: '2025-01-07T01:00:00.000Z', localDate: '2025-01-07' }),
      makeState({ userWordId: 'deck-1:w-1', wordId: 'w-1', wrongCount: 2 }),
    );
    repo.appendEventAndUpdateState(
      makeEvent({ eventId: 'e3', userWordId: 'deck-1:w-2', wordId: 'w-2', isCorrect: false, recognition: 'UNKNOWN', answeredAt: '2025-01-09T01:00:00.000Z', localDate: '2025-01-09' }),
      makeState({ userWordId: 'deck-1:w-2', wordId: 'w-2', wrongCount: 1 }),
    );
    // 答对不应进入错词本，也不应影响 lastWrongAt
    repo.appendEventAndUpdateState(
      makeEvent({ eventId: 'e4', userWordId: 'deck-1:w-1', wordId: 'w-1', isCorrect: true, answeredAt: '2025-01-12T01:00:00.000Z', localDate: '2025-01-12' }),
      makeState({ userWordId: 'deck-1:w-1', wordId: 'w-1', wrongCount: 2, correctCount: 1 }),
    );
    expect(words.listSenses('w-1')).toHaveLength(0);

    const mistakes = repo.listMistakes('deck-1');

    expect(mistakes.map((record) => record.state.userWordId)).toEqual(['deck-1:w-2', 'deck-1:w-1']);
    expect(mistakes[0]?.lastWrongAt).toBe('2025-01-09T01:00:00.000Z');
    expect(mistakes[1]?.lastWrongAt).toBe('2025-01-07T01:00:00.000Z');
  });

  it('listMistakes 支持 limit，且忽略没有错词的词', () => {
    const db = createDatabase();
    seedStates(db);
    const repo = createLearningRepository(db);
    repo.appendEventAndUpdateState(
      makeEvent({ eventId: 'e1', isCorrect: false, recognition: 'UNKNOWN' }),
      makeState({ wrongCount: 1 }),
    );

    expect(repo.listMistakes('deck-1', 1)).toHaveLength(1);
    expect(repo.listMistakes('deck-1', 10)).toHaveLength(1);
    expect(() => repo.listMistakes('deck-1', 0)).toThrow(InvalidRepositoryInputError);
  });

  it('getState 不存在时返回 null', () => {
    const db = createDatabase();
    seedDeck(db);

    expect(createLearningRepository(db).getState('nope')).toBeNull();
  });
});

describe('writeFrequencyCorpus', () => {
  it('写入自洽语料，rank 与 equal_count 落库', () => {
    const { db, words } = seedForFrequency();

    const result = words.writeFrequencyCorpus(makeCorpus());

    expect(result).toEqual({ written: 2, corpusVersion: 'ngsl-1.2', knownWordCount: 2 });
    const rows = db
      .prepare('SELECT word_id, rank, equal_count, frequency FROM frequency_entries ORDER BY word_id')
      .all() as { word_id: string; rank: number; equal_count: number; frequency: number }[];
    expect(rows).toEqual([
      { word_id: 'w-1', rank: 1, equal_count: 2, frequency: 100 },
      { word_id: 'w-2', rank: 1, equal_count: 2, frequency: 100 },
    ]);
  });

  it('同一语料重复导入是 upsert，不产生重复行', () => {
    const { db, words } = seedForFrequency();

    words.writeFrequencyCorpus(makeCorpus());
    words.writeFrequencyCorpus(makeCorpus({ now: '2025-02-01T00:00:00.000Z' }));

    const count = db.prepare('SELECT COUNT(*) AS n FROM frequency_entries').get() as { n: number };
    expect(count.n).toBe(2);
  });

  it('单条 rank 却声称并列（equalCount=2 但组内只有 1 条）→ RANK_INCONSISTENT', () => {
    const { words } = seedForFrequency();
    const corpus = makeCorpus({
      knownWordCount: 2,
      entries: [
        { wordId: 'w-1', frequency: 100, totalTokens: 1000, rank: 1, equalCount: 2 },
        // 漏写真实并列数，让它走默认 1
        { wordId: 'w-2', frequency: 101, totalTokens: 1000, rank: 2, equalCount: 1 },
      ],
    });

    // 这里 rank 不同、SUM 也刚好等于 2，但 w-1 声称自己与另一个词并列——
    // 单条 rank=1 的组大小为 1，与 equalCount=2 矛盾。
    expect(() => words.writeFrequencyCorpus(corpus)).toThrow(FrequencyCorpusMismatchError);
    try {
      words.writeFrequencyCorpus(corpus);
    } catch (error) {
      expect((error as FrequencyCorpusMismatchError).kind).toBe('RANK_INCONSISTENT');
    }
  });

  it('真正的“并列组里混入默认 1”被识别为 TIE_GROUP_DEFAULT', () => {
    const { words } = seedForFrequency();
    const corpus = makeCorpus({
      knownWordCount: 2,
      entries: [
        { wordId: 'w-1', frequency: 100, totalTokens: 1000, rank: 1, equalCount: 2 },
        { wordId: 'w-2', frequency: 100, totalTokens: 1000, rank: 1, equalCount: 1 },
      ],
    });

    try {
      words.writeFrequencyCorpus(corpus);
      throw new Error('expected FrequencyCorpusMismatchError');
    } catch (error) {
      expect(error).toBeInstanceOf(FrequencyCorpusMismatchError);
      const mismatch = error as FrequencyCorpusMismatchError;
      expect(mismatch.kind).toBe('TIE_GROUP_DEFAULT');
      // 错误信息必须能指出是哪一条、哪个并列组，而不是一句“数据不一致”。
      expect(mismatch.message).toContain('w-2');
      expect(mismatch.message).toContain('rank=1');
      expect(mismatch.message).toContain('默认值 1');
    }
  });

  it('SUM(equal_count) 与 knownWordCount 不符 → TOTAL_MISMATCH 且整份语料不落库', () => {
    const { db, words } = seedForFrequency();
    const corpus = makeCorpus({ knownWordCount: 5 });

    try {
      words.writeFrequencyCorpus(corpus);
      throw new Error('expected FrequencyCorpusMismatchError');
    } catch (error) {
      expect(error).toBeInstanceOf(FrequencyCorpusMismatchError);
      expect((error as FrequencyCorpusMismatchError).kind).toBe('TOTAL_MISMATCH');
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM frequency_entries').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('knownWordCount 非正整数 → KNOWN_WORD_COUNT_INVALID', () => {
    const { words } = seedForFrequency();

    expect(() => words.writeFrequencyCorpus(makeCorpus({ knownWordCount: 0 }))).toThrow(
      FrequencyCorpusMismatchError,
    );
  });

  it('同一个词在同一份语料里出现多次 → DUPLICATE_WORD', () => {
    const { words } = seedForFrequency();
    const corpus = makeCorpus({
      knownWordCount: 2,
      entries: [
        { wordId: 'w-1', frequency: 100, totalTokens: 1000, rank: 1, equalCount: 1 },
        { wordId: 'w-1', frequency: 100, totalTokens: 1000, rank: 1, equalCount: 1 },
      ],
    });

    try {
      words.writeFrequencyCorpus(corpus);
      throw new Error('expected FrequencyCorpusMismatchError');
    } catch (error) {
      expect(error).toBeInstanceOf(FrequencyCorpusMismatchError);
      expect((error as FrequencyCorpusMismatchError).kind).toBe('DUPLICATE_WORD');
    }
  });

  it('并列语料按“每词一行 + 行内 equal_count=组大小”通过校验（而非按行 SUM）', () => {
    // 口径说明：两个词并列时，每行 equal_count 都是 2，按行求和得 4，
    // 而词数是 2——所以“SUM(equal_count) == knownWordCount”按字面执行会禁止一切并列。
    // 这里锁定实际采用的等价判据：每词一行 + 每行 equal_count == 本组大小。
    const { db, words } = seedForFrequency();

    expect(() => words.writeFrequencyCorpus(makeCorpus({ knownWordCount: 2 }))).not.toThrow();
    const rowSum = db
      .prepare('SELECT SUM(equal_count) AS s, COUNT(*) AS n FROM frequency_entries')
      .get() as { s: number; n: number };
    expect(rowSum).toEqual({ s: 4, n: 2 });
  });

  it('写入过程中任一失败则整体回滚（不留半份语料）', () => {
    const { db, words } = seedForFrequency();
    const corpus = makeCorpus({
      knownWordCount: 2,
      entries: [
        { wordId: 'w-1', frequency: 100, totalTokens: 1000, rank: 1, equalCount: 2 },
        { wordId: 'w-2', frequency: 100, totalTokens: 1000, rank: 1, equalCount: 2 },
      ],
    });
    // 删掉 w-2，让第二条撞外键
    db.prepare("DELETE FROM words WHERE id = 'w-2'").run();

    expect(() => words.writeFrequencyCorpus(corpus)).toThrow();
    const count = db.prepare('SELECT COUNT(*) AS n FROM frequency_entries').get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe('createSettingsRepository', () => {
  it('读取不存在的键返回 null；写入后可读回最新值', () => {
    const db = createDatabase();
    const settings = createSettingsRepository(db);

    expect(settings.get('reviewPlan')).toBeNull();
    settings.set('reviewPlan', '{"dailyNewLimit":20}');
    expect(settings.get('reviewPlan')).toBe('{"dailyNewLimit":20}');
    settings.set('reviewPlan', '{"dailyNewLimit":30}');
    expect(settings.get('reviewPlan')).toBe('{"dailyNewLimit":30}');
  });

  it('空键或非字符串值抛类型化错误', () => {
    const db = createDatabase();
    const settings = createSettingsRepository(db);

    expect(() => settings.get(' ')).toThrow(InvalidRepositoryInputError);
    expect(() => settings.set('k', 1 as unknown as string)).toThrow(InvalidRepositoryInputError);
  });
});
