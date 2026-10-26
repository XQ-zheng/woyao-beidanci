import { ClockSkewError, STAGE_NEVER_REVIEWED } from '@woyao/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ServiceNotFoundError,
  ServiceValidationError,
  createReportService,
  createSettingsService,
  createStudyService,
  type ReportService,
  type SettingsService,
  type StudyService,
} from './index';
import { createServiceTestHarness, type ServiceTestHarness } from './testSupport';

const harnesses: ServiceTestHarness[] = [];

afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.close();
  }
});

/** 固定时钟：所有用例都围绕这个时刻构造，绝不读系统时间。 */
const NOW_ISO = '2025-03-01T08:00:00.000Z';

/** 服务装配结果。 */
interface Env {
  readonly harness: ServiceTestHarness;
  readonly settings: SettingsService;
  readonly study: StudyService;
  readonly report: ReportService;
}

/**
 * 建一套跑在真实内存库上的服务。
 *
 * @param options 时钟与缺省时区。
 * @returns 装配结果。
 */
function makeEnv(options: { now?: string; timeZone?: string } = {}): Env {
  const harness = createServiceTestHarness({ now: options.now ?? NOW_ISO });
  harnesses.push(harness);
  const settings = createSettingsService({
    context: harness.context,
    defaultTimeZone: options.timeZone ?? 'Asia/Shanghai',
  });
  return {
    harness,
    settings,
    study: createStudyService({ context: harness.context, settings }),
    report: createReportService({ context: harness.context }),
  };
}

/**
 * 播种 `count` 个带义项的词并塞进一个词库。
 *
 * @param harness 装配器。
 * @param count 词数。
 * @returns 词库 id 与词 id 列表（顺序即加入顺序）。
 */
function seedDeck(
  harness: ServiceTestHarness,
  count: number,
): { deckId: string; wordIds: string[] } {
  const wordIds: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const wordId = `w-${String(index)}`;
    harness.seedWord({
      id: wordId,
      lemma: `word${String(index)}`,
      senses: [
        { pos: 'v.', simpleZh: `释义${String(index)}甲` },
        { pos: 'n.', simpleZh: `释义${String(index)}乙` },
      ],
    });
    wordIds.push(wordId);
  }
  const deckId = harness.seedDeck({ id: 'deck-1', name: '四级核心', wordIds });
  return { deckId, wordIds };
}

/** 数一张表的行数（断言“零残留”时用）。 */
function countRows(harness: ServiceTestHarness, table: string): number {
  const row = harness.db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as {
    total: number;
  };
  return row.total;
}

/** 提交一次作答的简写。 */
async function answer(
  study: StudyService,
  input: {
    sessionId: string;
    deckId: string;
    wordId: string;
    isCorrect: boolean;
    answeredAt: string;
    mode?: 'EN_TO_ZH' | 'ZH_TO_EN';
    recognition?: 'KNOWN' | 'UNKNOWN';
    eventId?: string;
    durationMs?: number;
  },
): Promise<Awaited<ReturnType<StudyService['submitAnswer']>>> {
  const mode = input.mode ?? 'EN_TO_ZH';
  return study.submitAnswer({
    sessionId: input.sessionId,
    deckId: input.deckId,
    wordId: input.wordId,
    mode,
    prompt: mode === 'EN_TO_ZH' ? 'word' : '释义',
    answer: input.isCorrect ? '释义1甲' : '错的',
    isCorrect: input.isCorrect,
    recognition: input.recognition ?? 'KNOWN',
    answeredAt: new Date(input.answeredAt),
    ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
  });
}

describe('studyService：开始会话', () => {
  it('今日队列来自 core：新词按词库顺序取到上限，卡片带题干/答案/选项', async () => {
    const { harness, settings, study } = makeEnv();
    const { deckId } = seedDeck(harness, 5);
    await settings.update({ dailyNewLimit: 3 });

    const session = await study.startSession({ deckId, now: new Date(NOW_ISO) });

    expect(session.newCount).toBe(3);
    expect(session.reviewCount).toBe(0);
    expect(session.totalCards).toBe(3);
    expect(session.localDate).toBe('2025-03-01');
    expect(session.timeZone).toBe('Asia/Shanghai');
    // 新词池保持词库顺序（core 的规则），所以前 3 个就是 w-1..w-3。
    expect(session.cards.map((card) => card.wordId)).toEqual(['w-1', 'w-2', 'w-3']);
    const card = session.cards[0];
    expect(card?.lemma).toBe('word1');
    expect(card?.mode).toBe('EN_TO_ZH');
    expect(card?.style).toBe('CHOICE');
    expect(card?.prompt).toBe('word1');
    expect(card?.answer).toBe('释义1甲');
    // 选项含正确答案；候选不足时会少于 4 个，但绝不能没有答案。
    expect(card?.options).toContain('释义1甲');
    expect(card?.isNew).toBe(true);
    expect(card?.isFavorite).toBe(false);
    expect(card?.senses.map((sense) => sense.senseNo)).toEqual([1, 2]);
  });

  it('种子确定性：同一天两次 startSession 的卡片顺序与选项顺序完全一致（不依赖 Math.random）', async () => {
    const { harness, study } = makeEnv();
    const { deckId } = seedDeck(harness, 6);

    const first = await study.startSession({ deckId, now: new Date(NOW_ISO) });
    const second = await study.startSession({ deckId, now: new Date(NOW_ISO) });

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.cards.map((card) => card.wordId)).toEqual(
      first.cards.map((card) => card.wordId),
    );
    expect(second.cards.map((card) => card.options)).toEqual(
      first.cards.map((card) => card.options),
    );
  });

  it('词库不存在时抛 NOT_FOUND；时间不是 Date 时抛校验错误', async () => {
    const { study } = makeEnv();

    await expect(study.startSession({ deckId: 'missing', now: new Date(NOW_ISO) })).rejects.toBeInstanceOf(
      ServiceNotFoundError,
    );
    await expect(
      // 故意绕过类型：模拟 IPC 传了个字符串过来。
      study.startSession({ deckId: 'deck-1', now: '2025-03-01' } as unknown as { deckId: string; now: Date }),
    ).rejects.toBeInstanceOf(ServiceValidationError);
  });

  it('会话行落库：存计划快照与队列长度，endedAt 为 null', async () => {
    const { harness, settings, study } = makeEnv();
    const { deckId } = seedDeck(harness, 4);
    await settings.update({ dailyNewLimit: 2, dailyReviewLimit: 1 });

    const session = await study.startSession({ deckId, now: new Date(NOW_ISO) });

    const row = harness.db
      .prepare(
        'SELECT deck_id, ended_at, new_count, review_count, plan_snapshot_json, device_id FROM study_sessions WHERE session_id = ?',
      )
      .get(session.sessionId) as {
      deck_id: string;
      ended_at: string | null;
      new_count: number;
      review_count: number;
      plan_snapshot_json: string;
      device_id: string;
    };
    expect(row.deck_id).toBe(deckId);
    expect(row.ended_at).toBeNull();
    expect(row.new_count).toBe(2);
    expect(row.review_count).toBe(0);
    expect(row.device_id).toBe(harness.deviceId);
    expect(JSON.parse(row.plan_snapshot_json)).toMatchObject({ dailyNewLimit: 2, dailyReviewLimit: 1 });
  });
});

describe('studyService：作答', () => {
  it('累计错次提示：跨两个会话各错一次后提示出现且累计为 2；第三次答对后计数不清零但提示消失', async () => {
    const { harness, study } = makeEnv();
    const { deckId } = seedDeck(harness, 3);
    const firstSession = await study.startSession({ deckId, now: new Date(NOW_ISO) });

    const first = await answer(study, {
      sessionId: firstSession.sessionId,
      deckId,
      wordId: 'w-1',
      isCorrect: false,
      answeredAt: '2025-03-01T03:00:00.000Z',
    });
    expect(first.applied).toBe(true);
    expect(first.cumulativeWrongCount).toBe(1);
    // 只错了一次不该念叨。
    expect(first.showCumulativeWrongPrompt).toBe(false);

    // 第二个会话（同一天再开一次，词不同也没关系——作答不要求词在队列里）。
    const secondSession = await study.startSession({ deckId, now: new Date(NOW_ISO) });
    const second = await answer(study, {
      sessionId: secondSession.sessionId,
      deckId,
      wordId: 'w-1',
      isCorrect: false,
      answeredAt: '2025-03-01T03:30:00.000Z',
    });
    expect(second.cumulativeWrongCount).toBe(2);
    expect(second.showCumulativeWrongPrompt).toBe(true);

    const third = await answer(study, {
      sessionId: secondSession.sessionId,
      deckId,
      wordId: 'w-1',
      isCorrect: true,
      answeredAt: '2025-03-01T04:00:00.000Z',
    });
    // 答对不会把历史错次清零（需求：累计错次要能一直看到）。
    expect(third.cumulativeWrongCount).toBe(2);
    expect(third.showCumulativeWrongPrompt).toBe(false);
    expect(third.isCorrect).toBe(true);
    // 答对后阶段上升、权重下降，到期时间落在未来。
    expect(third.stage).toBeGreaterThanOrEqual(0);
    expect(third.nextDueAt > '2025-03-01T04:00:00.000Z').toBe(true);
  });

  it('重复 eventId：applied 为 false，状态计数与发件箱都不再变化', async () => {
    const { harness, study } = makeEnv();
    const { deckId } = seedDeck(harness, 3);
    const session = await study.startSession({ deckId, now: new Date(NOW_ISO) });

    const first = await answer(study, {
      sessionId: session.sessionId,
      deckId,
      wordId: 'w-1',
      isCorrect: false,
      answeredAt: '2025-03-01T03:00:00.000Z',
      eventId: 'evt-fixed',
      durationMs: 1200,
    });
    expect(first.applied).toBe(true);
    const outboxAfterFirst = countRows(harness, 'sync_outbox');
    const stateAfterFirst = harness.sync.learning.getState('deck-1:w-1');
    expect(stateAfterFirst?.wrongCount).toBe(1);

    const second = await answer(study, {
      sessionId: session.sessionId,
      deckId,
      wordId: 'w-1',
      isCorrect: false,
      answeredAt: '2025-03-01T03:00:00.000Z',
      eventId: 'evt-fixed',
      durationMs: 1200,
    });

    expect(second.applied).toBe(false);
    // 返回值必须是库里的事实，而不是“又算了一遍”的内存状态。
    expect(second.cumulativeWrongCount).toBe(1);
    expect(second.nextDueAt).toBe(first.nextDueAt);
    expect(second.stage).toBe(first.stage);
    expect(second.weight).toBe(first.weight);

    const stateAfterSecond = harness.sync.learning.getState('deck-1:w-1');
    expect(stateAfterSecond).toEqual(stateAfterFirst);
    expect(countRows(harness, 'sync_outbox')).toBe(outboxAfterFirst);
    expect(countRows(harness, 'learning_events')).toBe(1);
  });

  it('ClockSkewError 原样传播且零残留（作答时间超前 90 秒）', async () => {
    const { harness, study } = makeEnv();
    const { deckId } = seedDeck(harness, 3);
    const session = await study.startSession({ deckId, now: new Date(NOW_ISO) });
    const outboxBefore = countRows(harness, 'sync_outbox');

    try {
      await answer(study, {
        sessionId: session.sessionId,
        deckId,
        wordId: 'w-1',
        isCorrect: true,
        // 注入时钟是 08:00:00Z，这里 08:01:30Z —— 超前 90 秒，超过 60 秒容差。
        answeredAt: '2025-03-01T08:01:30.000Z',
      });
      throw new Error('期望抛出 ClockSkewError，但调用成功了');
    } catch (error: unknown) {
      // 必须是 core 的那个错误类型本身，不能被翻译成 ServiceError。
      expect(error).toBeInstanceOf(ClockSkewError);
      expect((error as ClockSkewError).skewMilliseconds).toBe(90_000);
    }

    // 零残留：事件、状态、发件箱一行都没多。
    expect(countRows(harness, 'learning_events')).toBe(0);
    expect(countRows(harness, 'learning_state')).toBe(0);
    expect(countRows(harness, 'sync_outbox')).toBe(outboxBefore);
    expect(harness.sync.learning.getState('deck-1:w-1')).toBeNull();
  });

  it('会话不存在 / 词库与会话不一致 / mode 传 MIXED 都被拒', async () => {
    const { harness, study } = makeEnv();
    const { deckId } = seedDeck(harness, 3);
    const session = await study.startSession({ deckId, now: new Date(NOW_ISO) });

    await expect(
      answer(study, {
        sessionId: 'missing-session',
        deckId,
        wordId: 'w-1',
        isCorrect: true,
        answeredAt: '2025-03-01T03:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(ServiceNotFoundError);

    await expect(
      answer(study, {
        sessionId: session.sessionId,
        deckId: 'deck-other',
        wordId: 'w-1',
        isCorrect: true,
        answeredAt: '2025-03-01T03:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(ServiceValidationError);

    await expect(
      study.submitAnswer({
        sessionId: session.sessionId,
        deckId,
        wordId: 'w-1',
        mode: 'MIXED',
        prompt: 'word1',
        answer: '释义1甲',
        isCorrect: true,
        recognition: 'KNOWN',
        answeredAt: new Date('2025-03-01T03:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(ServiceValidationError);
  });

  it('中译英方向：题干是义项拼接，正确答案是词形', async () => {
    const { harness, study } = makeEnv();
    const { deckId } = seedDeck(harness, 3);
    const session = await study.startSession({ deckId, now: new Date(NOW_ISO) });

    const result = await answer(study, {
      sessionId: session.sessionId,
      deckId,
      wordId: 'w-2',
      isCorrect: true,
      mode: 'ZH_TO_EN',
      answeredAt: '2025-03-01T03:00:00.000Z',
    });

    expect(result.correctAnswer).toBe('word2');
  });

  it('时区：同一 answeredAt 在 Asia/Shanghai 与 America/New_York 下落到不同本地日', async () => {
    const { harness, settings, study } = makeEnv({ now: '2025-03-02T00:00:00.000Z' });
    const { deckId } = seedDeck(harness, 3);
    // 20:30Z → 上海 03-02 04:30（次日），纽约 03-01 15:30（当日）。
    const answeredAt = '2025-03-01T20:30:00.000Z';

    const shanghaiSession = await study.startSession({
      deckId,
      now: new Date('2025-03-02T00:00:00.000Z'),
    });
    await answer(study, {
      sessionId: shanghaiSession.sessionId,
      deckId,
      wordId: 'w-1',
      isCorrect: true,
      answeredAt,
    });

    await settings.update({ timeZone: 'America/New_York' });
    const newYorkSession = await study.startSession({
      deckId,
      now: new Date('2025-03-02T00:00:00.000Z'),
    });
    await answer(study, {
      sessionId: newYorkSession.sessionId,
      deckId,
      wordId: 'w-2',
      isCorrect: true,
      answeredAt,
    });

    const rows = harness.db
      .prepare(
        'SELECT user_word_id, local_date, time_zone FROM learning_events ORDER BY user_word_id ASC',
      )
      .all() as { user_word_id: string; local_date: string; time_zone: string }[];

    expect(rows).toEqual([
      { user_word_id: 'deck-1:w-1', local_date: '2025-03-02', time_zone: 'Asia/Shanghai' },
      { user_word_id: 'deck-1:w-2', local_date: '2025-03-01', time_zone: 'America/New_York' },
    ]);
    // 会话行也各自记自己当时的时区。
    expect(shanghaiSession.timeZone).toBe('Asia/Shanghai');
    expect(newYorkSession.timeZone).toBe('America/New_York');
  });
});

describe('studyService：结束会话', () => {
  it('汇总口径来自事件事实：2 个新词 + 3 个复习词', async () => {
    const { harness, study } = makeEnv();
    const { deckId } = seedDeck(harness, 6);

    // 第一个会话先把 w-1..w-3 变成“已复习过”的词。
    const setupSession = await study.startSession({ deckId, now: new Date(NOW_ISO) });
    for (const [index, wordId] of ['w-1', 'w-2', 'w-3'].entries()) {
      await answer(study, {
        sessionId: setupSession.sessionId,
        deckId,
        wordId,
        isCorrect: true,
        answeredAt: `2025-03-01T02:0${String(index)}:00.000Z`,
      });
    }

    const session = await study.startSession({ deckId, now: new Date(NOW_ISO) });
    // 3 个复习（stageBefore 已是 0）+ 2 个新词（stageBefore = -1）。
    const plan = [
      { wordId: 'w-1', isCorrect: true },
      { wordId: 'w-2', isCorrect: false },
      { wordId: 'w-3', isCorrect: true },
      { wordId: 'w-4', isCorrect: true },
      { wordId: 'w-5', isCorrect: false },
    ];
    for (const [index, item] of plan.entries()) {
      await answer(study, {
        sessionId: session.sessionId,
        deckId,
        wordId: item.wordId,
        isCorrect: item.isCorrect,
        answeredAt: `2025-03-01T03:0${String(index)}:00.000Z`,
        durationMs: 1000,
      });
    }

    const summary = await study.finishSession({
      sessionId: session.sessionId,
      now: new Date('2025-03-01T04:00:00.000Z'),
    });

    expect(summary.newCount).toBe(2);
    expect(summary.reviewCount).toBe(3);
    expect(summary.totalAnswers).toBe(5);
    expect(summary.correctCount).toBe(3);
    expect(summary.activeDurationMs).toBe(5000);
    expect(summary.endedAt).toBe('2025-03-01T04:00:00.000Z');
    expect(summary.localDate).toBe('2025-03-01');

    // 事件里 stageBefore 的口径确实是 3 条 0 / 2 条 -1。
    const events = harness.db
      .prepare('SELECT stage_before FROM learning_events WHERE session_id = ?')
      .all(session.sessionId) as { stage_before: number }[];
    expect(events.filter((event) => event.stage_before === STAGE_NEVER_REVIEWED)).toHaveLength(2);
  });

  it('中断的会话（endedAt 为 null）也能结束，且不因缺字段抛错', async () => {
    const { harness, study } = makeEnv();
    const { deckId } = seedDeck(harness, 2);
    const session = await study.startSession({ deckId, now: new Date(NOW_ISO) });

    const summary = await study.finishSession({
      sessionId: session.sessionId,
      now: new Date('2025-03-01T09:00:00.000Z'),
    });

    expect(summary.newCount).toBe(0);
    expect(summary.totalAnswers).toBe(0);
    expect(summary.endedAt).toBe('2025-03-01T09:00:00.000Z');
    const row = harness.db
      .prepare('SELECT ended_at, revision FROM study_sessions WHERE session_id = ?')
      .get(session.sessionId) as { ended_at: string | null; revision: number };
    expect(row.ended_at).toBe('2025-03-01T09:00:00.000Z');
    // 第二次写同一行要推 revision（同步侧才看得见这次“结束”）。
    expect(row.revision).toBe(1);
  });

  it('会话不存在时抛 NOT_FOUND', async () => {
    const { study } = makeEnv();

    await expect(
      study.finishSession({ sessionId: 'missing', now: new Date(NOW_ISO) }),
    ).rejects.toBeInstanceOf(ServiceNotFoundError);
  });
});

describe('studyService：计划中途变更不改写历史', () => {
  it('改大 dailyNewLimit 后，旧会话的 newCount 与评估结果完全不变，新会话按新上限', async () => {
    const { harness, settings, study, report } = makeEnv();
    const { deckId } = seedDeck(harness, 8);
    await settings.update({ dailyNewLimit: 2 });

    const oldSession = await study.startSession({ deckId, now: new Date(NOW_ISO) });
    expect(oldSession.newCount).toBe(2);
    await answer(study, {
      sessionId: oldSession.sessionId,
      deckId,
      wordId: 'w-1',
      isCorrect: true,
      answeredAt: '2025-03-01T03:00:00.000Z',
    });

    const assessmentBefore = await report.getAssessment({ deckId, now: new Date(NOW_ISO) });

    // 用户在同一个词库上把每日新词上限改成 5。
    await settings.update({ dailyNewLimit: 5 });

    const oldSummary = await study.finishSession({
      sessionId: oldSession.sessionId,
      now: new Date('2025-03-01T04:00:00.000Z'),
    });
    // 旧会话只有 1 条作答事件，`newCount` 必须是 1（不是开始时的 2，更不是新的 5）。
    expect(oldSummary.newCount).toBe(1);
    expect(oldSummary.reviewCount).toBe(0);

    const assessmentAfter = await report.getAssessment({ deckId, now: new Date(NOW_ISO) });
    expect(assessmentAfter).toEqual(assessmentBefore);

    const newSession = await study.startSession({ deckId, now: new Date(NOW_ISO) });
    // 8 个词里 w-1 已经有状态，剩 7 个新词 → 按新上限 5 截断。
    expect(newSession.newCount).toBe(5);
  });
});

describe('studyService：此单词不再出现', () => {
  it('抑制后当天的队列不含该词，恢复后又出现', async () => {
    const { harness, study } = makeEnv();
    const { deckId } = seedDeck(harness, 3);

    const before = await study.startSession({ deckId, now: new Date(NOW_ISO) });
    expect(before.cards.map((card) => card.wordId)).toEqual(['w-1', 'w-2', 'w-3']);

    await study.suppressWord({ deckId, wordId: 'w-2', now: new Date(NOW_ISO) });

    const suppressed = await study.startSession({ deckId, now: new Date(NOW_ISO) });
    expect(suppressed.cards.map((card) => card.wordId)).toEqual(['w-1', 'w-3']);
    expect(suppressed.newCount).toBe(2);

    await study.restoreWord({ deckId, wordId: 'w-2', now: new Date(NOW_ISO) });

    const restored = await study.startSession({ deckId, now: new Date(NOW_ISO) });
    // 注意顺序：抑制会先给 w-2 建一条状态行（`updateState` 的 upsert），
    // 于是它从“未学过的词（保持词库顺序）”掉到 core 的第二段池子
    // “已建状态但从未作答”，排在未学过的词之后。这是 core 的既定规则
    // （`buildDailyQueue` 的注释），不是 bug——但 UI 要知道恢复后这个词会排到队尾。
    expect([...restored.cards.map((card) => card.wordId)].sort()).toEqual(['w-1', 'w-2', 'w-3']);
    expect(restored.cards.map((card) => card.wordId)).toEqual(['w-1', 'w-3', 'w-2']);
    expect(restored.newCount).toBe(3);
  });

  it('抑制只写状态、不发事件（事件数不变、发件箱 +1）', async () => {
    const { harness, study } = makeEnv();
    const { deckId } = seedDeck(harness, 3);
    const eventsBefore = countRows(harness, 'learning_events');
    const outboxBefore = countRows(harness, 'sync_outbox');

    await study.suppressWord({ deckId, wordId: 'w-1', now: new Date(NOW_ISO) });

    expect(countRows(harness, 'learning_events')).toBe(eventsBefore);
    expect(countRows(harness, 'sync_outbox')).toBe(outboxBefore + 1);
    const state = harness.sync.learning.getState('deck-1:w-1');
    expect(state?.suppressedAt).toBe(NOW_ISO);
  });

  it('词库不存在 / 词条不在该词库时抛 NOT_FOUND；重复恢复是幂等的', async () => {
    const { harness, study } = makeEnv();
    const { deckId } = seedDeck(harness, 2);
    harness.seedWord({ id: 'w-outside', lemma: 'outside' });

    await expect(
      study.suppressWord({ deckId: 'missing', wordId: 'w-1', now: new Date(NOW_ISO) }),
    ).rejects.toBeInstanceOf(ServiceNotFoundError);
    await expect(
      study.suppressWord({ deckId, wordId: 'w-outside', now: new Date(NOW_ISO) }),
    ).rejects.toBeInstanceOf(ServiceNotFoundError);
    await expect(
      study.suppressWord({ deckId, wordId: 'ghost', now: new Date(NOW_ISO) }),
    ).rejects.toBeInstanceOf(ServiceNotFoundError);

    // 没被抑制过的词恢复：什么都不做也不报错。
    await expect(
      study.restoreWord({ deckId, wordId: 'w-1', now: new Date(NOW_ISO) }),
    ).resolves.toBeUndefined();
    expect(harness.sync.learning.getState('deck-1:w-1')).toBeNull();
  });
});
