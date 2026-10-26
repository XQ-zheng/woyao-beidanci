import { ASSESSMENT_ALGORITHM_VERSION, ASSESSMENT_WINDOW_DAYS, MS_PER_DAY } from '@woyao/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ServiceValidationError,
  createReportService,
  createSettingsService,
  createStudyService,
  type ReportService,
  type StudyService,
} from './index';
import { createServiceTestHarness, type ServiceTestHarness } from './testSupport';

const harnesses: ServiceTestHarness[] = [];

afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.close();
  }
});

/** 固定时钟。 */
const NOW_ISO = '2025-03-01T08:00:00.000Z';

/** 服务装配结果。 */
interface Env {
  readonly harness: ServiceTestHarness;
  readonly study: StudyService;
  readonly report: ReportService;
}

/**
 * 建一套跑在真实内存库上的服务。
 *
 * @returns 装配结果。
 */
function makeEnv(): Env {
  const harness = createServiceTestHarness({ now: NOW_ISO });
  harnesses.push(harness);
  const settings = createSettingsService({ context: harness.context, defaultTimeZone: 'Asia/Shanghai' });
  return {
    harness,
    study: createStudyService({ context: harness.context, settings }),
    report: createReportService({ context: harness.context }),
  };
}

/**
 * 播种 `count` 个带义项的词并塞进 `deck-1`。
 *
 * @param harness 装配器。
 * @param count 词数。
 * @returns 词 id 列表。
 */
function seedDeck(harness: ServiceTestHarness, count: number): string[] {
  const wordIds: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const wordId = `w-${String(index)}`;
    harness.seedWord({
      id: wordId,
      lemma: `word${String(index)}`,
      senses: [{ pos: 'v.', simpleZh: `释义${String(index)}` }],
    });
    wordIds.push(wordId);
  }
  harness.seedDeck({ id: 'deck-1', name: '四级核心', wordIds });
  return wordIds;
}

describe('reportService：水平评估', () => {
  it('空数据返回 INSUFFICIENT_SAMPLE 与 0 分，不编造等级（建议全部来自 core）', async () => {
    const { harness, report } = makeEnv();
    seedDeck(harness, 3);

    const view = await report.getAssessment({ deckId: 'deck-1', now: new Date(NOW_ISO) });

    expect(view.level).toBe('INSUFFICIENT_SAMPLE');
    expect(view.score).toBe(0);
    expect(view.validAnswers).toBe(0);
    expect(view.distinctWords).toBe(0);
    expect(view.coverage).toBe(0);
    expect(view.deckId).toBe('deck-1');
    // 建议必须说明“样本不足”，而不是给一句鼓励或编一个等级。
    expect(view.suggestions.join('')).toContain('样本不足');
  });

  it('透传可追溯字段：算法版本、生成时刻与 90 天窗口（窗口口径来自 core 常量）', async () => {
    const { harness, report } = makeEnv();
    seedDeck(harness, 3);
    const now = new Date(NOW_ISO);

    const view = await report.getAssessment({ deckId: 'deck-1', now });

    expect(view.algorithmVersion).toBe(ASSESSMENT_ALGORITHM_VERSION);
    expect(view.generatedAt).toBe(NOW_ISO);
    expect(view.windowEnd).toBe(NOW_ISO);
    expect(view.windowStart).toBe(
      new Date(now.getTime() - ASSESSMENT_WINDOW_DAYS * MS_PER_DAY).toISOString(),
    );
  });

  it('有作答后计入覆盖率与有效作答次数（不重算分数口径）', async () => {
    const { harness, study, report } = makeEnv();
    seedDeck(harness, 4);
    const session = await study.startSession({ deckId: 'deck-1', now: new Date(NOW_ISO) });
    await study.submitAnswer({
      sessionId: session.sessionId,
      deckId: 'deck-1',
      wordId: 'w-1',
      mode: 'EN_TO_ZH',
      prompt: 'word1',
      answer: '释义1',
      isCorrect: true,
      recognition: 'KNOWN',
      answeredAt: new Date('2025-03-01T03:00:00.000Z'),
    });

    const view = await report.getAssessment({ deckId: 'deck-1', now: new Date(NOW_ISO) });

    expect(view.validAnswers).toBe(1);
    expect(view.distinctWords).toBe(1);
    // 1 个词答对 / 4 个词 = 0.25。
    expect(view.coverage).toBeCloseTo(0.25, 10);
    // 样本仍不足（< 30 词 / < 60 次），所以等级不评定。
    expect(view.level).toBe('INSUFFICIENT_SAMPLE');
  });

  it('时间或词库 id 非法时抛校验错误', async () => {
    const { report } = makeEnv();

    await expect(
      report.getAssessment({ deckId: '', now: new Date(NOW_ISO) }),
    ).rejects.toBeInstanceOf(ServiceValidationError);
    await expect(
      report.getAssessment({ deckId: 'deck-1', now: 'not-a-date' } as unknown as {
        deckId: string;
        now: Date;
      }),
    ).rejects.toBeInstanceOf(ServiceValidationError);
  });
});

describe('reportService：日统计', () => {
  it('按本地日聚合作答数与正确率，区间含两端', async () => {
    const { harness, study, report } = makeEnv();
    seedDeck(harness, 4);
    const session = await study.startSession({ deckId: 'deck-1', now: new Date(NOW_ISO) });
    const plan = [
      { wordId: 'w-1', isCorrect: true, at: '2025-03-01T03:00:00.000Z' },
      { wordId: 'w-2', isCorrect: false, at: '2025-03-01T03:01:00.000Z' },
      { wordId: 'w-3', isCorrect: true, at: '2025-02-28T03:00:00.000Z' },
    ];
    for (const item of plan) {
      await study.submitAnswer({
        sessionId: session.sessionId,
        deckId: 'deck-1',
        wordId: item.wordId,
        mode: 'EN_TO_ZH',
        prompt: 'x',
        answer: 'y',
        isCorrect: item.isCorrect,
        recognition: 'KNOWN',
        answeredAt: new Date(item.at),
        durationMs: 1000,
      });
    }

    const rows = await report.getDailyHistory({
      fromLocalDate: '2025-02-28',
      toLocalDate: '2025-03-01',
    });

    expect(rows.map((row) => row.localDate)).toEqual(['2025-02-28', '2025-03-01']);
    expect(rows[0]).toMatchObject({ total: 1, correct: 1, wrong: 0, accuracy: 1, activeMs: 1000 });
    expect(rows[1]).toMatchObject({ total: 2, correct: 1, wrong: 1, accuracy: 0.5, activeMs: 2000 });
  });

  it('没有作答的日期不出现在结果里；反向区间被拒；日期格式非法被拒', async () => {
    const { harness, report } = makeEnv();
    seedDeck(harness, 1);

    expect(await report.getDailyHistory({ fromLocalDate: '2025-01-01', toLocalDate: '2025-01-31' })).toEqual(
      [],
    );
    await expect(
      report.getDailyHistory({ fromLocalDate: '2025-03-02', toLocalDate: '2025-03-01' }),
    ).rejects.toBeInstanceOf(ServiceValidationError);
    await expect(
      report.getDailyHistory({ fromLocalDate: '2025/03/01', toLocalDate: '2025-03-02' }),
    ).rejects.toBeInstanceOf(ServiceValidationError);
  });
});

describe('reportService：会话列表', () => {
  it('返回区间内的会话，计数取事件事实；未结束的会话 endedAt 为 null', async () => {
    const { harness, study, report } = makeEnv();
    seedDeck(harness, 4);

    const finished = await study.startSession({ deckId: 'deck-1', now: new Date(NOW_ISO) });
    await study.submitAnswer({
      sessionId: finished.sessionId,
      deckId: 'deck-1',
      wordId: 'w-1',
      mode: 'EN_TO_ZH',
      prompt: 'x',
      answer: 'y',
      isCorrect: true,
      recognition: 'KNOWN',
      answeredAt: new Date('2025-03-01T03:00:00.000Z'),
      durationMs: 700,
    });
    await study.finishSession({
      sessionId: finished.sessionId,
      now: new Date('2025-03-01T03:10:00.000Z'),
    });
    const pending = await study.startSession({ deckId: 'deck-1', now: new Date(NOW_ISO) });

    const sessions = await report.listSessions({
      fromIso: '2025-02-01T00:00:00.000Z',
      toIso: NOW_ISO,
    });

    expect(sessions.map((session) => session.sessionId)).toEqual([
      finished.sessionId,
      pending.sessionId,
    ]);
    expect(sessions[0]).toMatchObject({
      newCount: 1,
      reviewCount: 0,
      totalAnswers: 1,
      correctCount: 1,
      activeDurationMs: 700,
      endedAt: '2025-03-01T03:10:00.000Z',
    });
    // 未结束的会话：endedAt 为 null，计数为 0（没有事件）。
    expect(sessions[1]?.endedAt).toBeNull();
    expect(sessions[1]?.newCount).toBe(0);
    expect(sessions[1]?.totalAnswers).toBe(0);
  });

  it('计数器不取会话行上的预估数：跳过卡片后 newCount 与事实一致', async () => {
    const { harness, study, report } = makeEnv();
    seedDeck(harness, 5);

    // 队列里有 5 个新词（会话行 new_count = 5），但只答了 1 个。
    const session = await study.startSession({ deckId: 'deck-1', now: new Date(NOW_ISO) });
    expect(session.newCount).toBe(5);
    await study.submitAnswer({
      sessionId: session.sessionId,
      deckId: 'deck-1',
      wordId: 'w-1',
      mode: 'EN_TO_ZH',
      prompt: 'x',
      answer: 'y',
      isCorrect: true,
      recognition: 'KNOWN',
      answeredAt: new Date('2025-03-01T03:00:00.000Z'),
    });

    const [row] = await report.listSessions({
      fromIso: '2025-02-01T00:00:00.000Z',
      toIso: NOW_ISO,
    });

    expect(row?.newCount).toBe(1);
    expect(row?.totalAnswers).toBe(1);
  });

  it('ISO 格式非法或反向区间被拒', async () => {
    const { report } = makeEnv();

    await expect(
      report.listSessions({ fromIso: '2025-02-01', toIso: NOW_ISO }),
    ).rejects.toBeInstanceOf(ServiceValidationError);
    await expect(
      report.listSessions({ fromIso: '2025-03-02T00:00:00.000Z', toIso: NOW_ISO }),
    ).rejects.toBeInstanceOf(ServiceValidationError);
  });
});

describe('reportService：错词本', () => {
  it('只答对过的词不出现；lastWrongAt 等于最近一次答错事件时间', async () => {
    const { harness, study, report } = makeEnv();
    seedDeck(harness, 3);
    const session = await study.startSession({ deckId: 'deck-1', now: new Date(NOW_ISO) });

    const submit = async (wordId: string, isCorrect: boolean, at: string): Promise<void> => {
      await study.submitAnswer({
        sessionId: session.sessionId,
        deckId: 'deck-1',
        wordId,
        mode: 'EN_TO_ZH',
        prompt: 'x',
        answer: 'y',
        isCorrect,
        recognition: 'KNOWN',
        answeredAt: new Date(at),
      });
    };
    // w-1 错两次（最近一次 03:20），w-2 只答对过一次，w-3 错一次后答对。
    await submit('w-1', false, '2025-03-01T03:00:00.000Z');
    await submit('w-1', false, '2025-03-01T03:20:00.000Z');
    await submit('w-2', true, '2025-03-01T03:05:00.000Z');
    await submit('w-3', false, '2025-03-01T03:10:00.000Z');
    await submit('w-3', true, '2025-03-01T03:15:00.000Z');

    const mistakes = await report.getMistakes({ deckId: 'deck-1' });

    expect(mistakes.map((mistake) => mistake.wordId)).toEqual(['w-1', 'w-3']);
    expect(mistakes[0]).toMatchObject({
      wordId: 'w-1',
      lemma: 'word1',
      wrongCount: 2,
      correctCount: 0,
      lastWrongAt: '2025-03-01T03:20:00.000Z',
      // 固定时钟是 03-01T08:00Z，03:20 在同一天内 → 属于“最近 7 天又错”。
      recentWrong: true,
    });
    expect(mistakes[1]).toMatchObject({
      wordId: 'w-3',
      wrongCount: 1,
      correctCount: 1,
      lastWrongAt: '2025-03-01T03:10:00.000Z',
    });
    // 义项要一起带出来（错词本列表要直接显示词义）。
    expect(mistakes[0]?.senses[0]?.simpleZh).toBe('释义1');
  });

  it('超过 7 天没再错的词 recentWrong 为 false', async () => {
    const { harness, study, report } = makeEnv();
    seedDeck(harness, 2);
    const session = await study.startSession({ deckId: 'deck-1', now: new Date(NOW_ISO) });
    await study.submitAnswer({
      sessionId: session.sessionId,
      deckId: 'deck-1',
      wordId: 'w-1',
      mode: 'EN_TO_ZH',
      prompt: 'x',
      answer: 'y',
      isCorrect: false,
      recognition: 'KNOWN',
      // 30 天前答错：仍是错词，但不算“最近又错”。
      answeredAt: new Date('2025-01-30T03:00:00.000Z'),
    });

    const [mistake] = await report.getMistakes({ deckId: 'deck-1' });

    expect(mistake?.wordId).toBe('w-1');
    expect(mistake?.recentWrong).toBe(false);
  });

  it('没有错词时返回空数组；limit 生效且降序按累计错次', async () => {
    const { harness, study, report } = makeEnv();
    seedDeck(harness, 4);

    expect(await report.getMistakes({ deckId: 'deck-1' })).toEqual([]);

    const session = await study.startSession({ deckId: 'deck-1', now: new Date(NOW_ISO) });
    const wrong = async (wordId: string, times: number, startMinute: number): Promise<void> => {
      for (let index = 0; index < times; index += 1) {
        await study.submitAnswer({
          sessionId: session.sessionId,
          deckId: 'deck-1',
          wordId,
          mode: 'EN_TO_ZH',
          prompt: 'x',
          answer: 'y',
          isCorrect: false,
          recognition: 'KNOWN',
          answeredAt: new Date(`2025-03-01T03:${String(startMinute + index).padStart(2, '0')}:00.000Z`),
        });
      }
    };
    await wrong('w-1', 1, 0);
    await wrong('w-2', 3, 10);
    await wrong('w-3', 2, 20);

    const all = await report.getMistakes({ deckId: 'deck-1' });
    expect(all.map((mistake) => mistake.wordId)).toEqual(['w-2', 'w-3', 'w-1']);

    const limited = await report.getMistakes({ deckId: 'deck-1', limit: 2 });
    expect(limited.map((mistake) => mistake.wordId)).toEqual(['w-2', 'w-3']);
  });

  it('limit 非法时抛校验错误', async () => {
    const { report } = makeEnv();

    await expect(report.getMistakes({ deckId: 'deck-1', limit: 0 })).rejects.toBeInstanceOf(
      ServiceValidationError,
    );
    await expect(report.getMistakes({ deckId: 'deck-1', limit: 501 })).rejects.toBeInstanceOf(
      ServiceValidationError,
    );
  });
});
