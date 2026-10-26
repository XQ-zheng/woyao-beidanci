import { describe, expect, it } from 'vitest';

import type { AssessmentEvent } from './assessment';
import {
  computeAssessmentComponents,
  evaluateAssessment,
  InvalidAssessmentInputError,
  levelFromScore,
  MIN_DISTINCT_WORDS,
  MIN_VALID_ANSWERS,
  NEUTRAL_DUE_REVIEW_SCORE,
} from './assessment';
import type { Recognition } from './models';

/** 固定评估时刻：2025-06-30T12:00:00Z。 */
const NOW = new Date(Date.UTC(2025, 5, 30, 12, 0, 0));

/**
 * 构造若干天前的时刻。
 *
 * @param days 天数。
 * @returns 时刻。
 */
function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

/** 构造一条作答事件。 */
function makeEvent(
  wordId: string,
  options: {
    isCorrect?: boolean;
    recognition?: Recognition;
    ageDays?: number;
    dueOffsetHours?: number;
    answeredAt?: string;
  } = {},
): AssessmentEvent {
  const { isCorrect = true, recognition = 'KNOWN', ageDays = 5, dueOffsetHours, answeredAt } = options;
  const answeredAtIso = answeredAt ?? daysAgo(ageDays).toISOString();
  const event: AssessmentEvent = { wordId, isCorrect, recognition, answeredAt: answeredAtIso };
  if (dueOffsetHours !== undefined) {
    event.dueAt = new Date(Date.parse(answeredAtIso) - dueOffsetHours * 60 * 60 * 1000).toISOString();
  }
  return event;
}

/** 构造 `wordCount` 个不同词、每词 `answersPerWord` 条作答。 */
function buildSamples(
  wordCount: number,
  answersPerWord: number,
  options: { isCorrect?: boolean; recognition?: Recognition; dueOffsetHours?: number } = {},
): AssessmentEvent[] {
  const events: AssessmentEvent[] = [];
  for (let wordIndex = 0; wordIndex < wordCount; wordIndex += 1) {
    for (let answerIndex = 0; answerIndex < answersPerWord; answerIndex += 1) {
      events.push(makeEvent(`w-${wordIndex}`, options));
    }
  }
  return events;
}

describe('evaluateAssessment：样本门槛', () => {
  it('没有事件时返回 INSUFFICIENT_SAMPLE，分数与置信度为 0', () => {
    const result = evaluateAssessment([], 100, NOW);

    expect(result.level).toBe('INSUFFICIENT_SAMPLE');
    expect(result.score).toBe(0);
    expect(result.coverage).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.distinctWords).toBe(0);
    expect(result.validAnswers).toBe(0);
    expect(result.suggestions.join(' ')).toContain('样本不足');
    expect(result.suggestions.join(' ')).toContain('复习样本不足');
  });

  it('不同词数不足 30 时不评等级', () => {
    const events = buildSamples(MIN_DISTINCT_WORDS - 1, 3);

    const result = evaluateAssessment(events, 100, NOW);

    expect(result.distinctWords).toBe(MIN_DISTINCT_WORDS - 1);
    expect(result.validAnswers).toBeGreaterThanOrEqual(MIN_VALID_ANSWERS);
    expect(result.level).toBe('INSUFFICIENT_SAMPLE');
  });

  it('有效作答不足 60 时不评等级', () => {
    const events = buildSamples(MIN_DISTINCT_WORDS + 10, 1);

    const result = evaluateAssessment(events, 100, NOW);

    expect(result.validAnswers).toBeLessThan(MIN_VALID_ANSWERS);
    expect(result.distinctWords).toBeGreaterThanOrEqual(MIN_DISTINCT_WORDS);
    expect(result.level).toBe('INSUFFICIENT_SAMPLE');
  });

  it('恰好 30 个不同词与 60 次作答即达标', () => {
    const events = buildSamples(MIN_DISTINCT_WORDS, 2);

    const result = evaluateAssessment(events, 100, NOW);

    expect(result.distinctWords).toBe(30);
    expect(result.validAnswers).toBe(60);
    expect(result.level).not.toBe('INSUFFICIENT_SAMPLE');
  });
});

describe('evaluateAssessment：得分公式', () => {
  it('全对且无到期复习样本：A=1, R=1, M=0.5, E=1 → 87.5 分', () => {
    const events = buildSamples(30, 2);

    const result = evaluateAssessment(events, 100, NOW);

    // 100 * (0.50*1 + 0.15*1 + 0.25*0.5 + 0.10*1) = 87.5
    expect(result.score).toBeCloseTo(87.5, 10);
    expect(result.level).toBe('STABLE');
    expect(result.coverage).toBeCloseTo(0.3, 10);
    expect(result.confidence).toBeCloseTo(0.09, 10);
    expect(result.suggestions.join(' ')).toContain('复习样本不足');
  });

  it('全部为到期复习且全部按时答对：M=1 → 100 分', () => {
    const events = buildSamples(30, 2, { dueOffsetHours: 10 });

    const result = evaluateAssessment(events, 100, NOW);

    expect(result.score).toBeCloseTo(100, 10);
    expect(result.level).toBe('STABLE');
    expect(result.suggestions.join(' ')).not.toContain('复习样本不足');
  });

  it('A 按 30 天 0.6 / 其余 0.4 加权', () => {
    const events: AssessmentEvent[] = [
      makeEvent('w-1', { ageDays: 5, isCorrect: true }),
      makeEvent('w-2', { ageDays: 5, isCorrect: false, recognition: 'UNKNOWN' }),
      makeEvent('w-3', { ageDays: 45, isCorrect: true }),
      makeEvent('w-4', { ageDays: 45, isCorrect: true }),
    ];

    const components = computeAssessmentComponents(events, NOW);

    // (0.6*0.5 + 0.4*1.0) / (0.6 + 0.4) = 0.7
    expect(components.accuracy).toBeCloseTo(0.7, 10);
    expect(components.recognitionRate).toBeCloseTo(0.75, 10);
    expect(components.errorPenalty).toBeCloseTo(Math.exp(-1 / 4), 10);
    expect(components.distinctWords).toBe(4);
    expect(components.wrongAnswers).toBe(1);
  });

  it('错误惩罚 E 随“错次数 / 不同词数”指数衰减', () => {
    const events = Array.from({ length: 10 }, (_unused, index) =>
      makeEvent(`w-${index}`, { isCorrect: false, recognition: 'UNKNOWN' }),
    );

    const components = computeAssessmentComponents(events, NOW);

    expect(components.errorPenalty).toBeCloseTo(Math.exp(-1), 10);
  });

  it('覆盖率为 0 时给出增加新词的建议', () => {
    const events = buildSamples(5, 12);

    const result = evaluateAssessment(events, 1000, NOW);

    expect(result.coverage).toBeCloseTo(0.005, 10);
    expect(result.suggestions.join(' ')).toContain('词库覆盖偏低');
  });

  it('词库为空时覆盖率为 0 且不抛错', () => {
    const result = evaluateAssessment(buildSamples(5, 12), 0, NOW);

    expect(result.coverage).toBe(0);
  });
});

describe('评估：M（到期复习 48 小时内答对率）', () => {
  it('48 小时以外的作答不计入 M 样本', () => {
    const events = [makeEvent('w-1', { dueOffsetHours: 72 })];

    const components = computeAssessmentComponents(events, NOW);

    expect(components.dueReviewSamples).toBe(0);
    expect(components.hasDueReviewSamples).toBe(false);
    expect(components.dueReviewScore).toBe(NEUTRAL_DUE_REVIEW_SCORE);
  });

  it('48 小时以内（含边界）计入 M 样本', () => {
    const atBoundary = [makeEvent('w-1', { dueOffsetHours: 48 })];

    const components = computeAssessmentComponents(atBoundary, NOW);

    expect(components.dueReviewSamples).toBe(1);
    expect(components.dueReviewScore).toBe(1);
  });

  it('有样本但完成度低时给出减少新词的建议', () => {
    const events: AssessmentEvent[] = [
      makeEvent('w-1', { dueOffsetHours: 5, isCorrect: true }),
      makeEvent('w-2', { dueOffsetHours: 5, isCorrect: false, recognition: 'UNKNOWN' }),
      makeEvent('w-3', { dueOffsetHours: 5, isCorrect: false, recognition: 'UNKNOWN' }),
    ];

    const result = evaluateAssessment(events, 100, NOW);

    expect(result.suggestions.join(' ')).toContain('到期复习完成度偏低');
  });
});

describe('评估：窗口过滤与自评差异', () => {
  it('90 天以前与未来事件都不计入', () => {
    const events: AssessmentEvent[] = [
      makeEvent('w-1', { ageDays: 5 }),
      makeEvent('w-2', { ageDays: 120 }),
      makeEvent('w-3', { answeredAt: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString() }),
    ];

    const components = computeAssessmentComponents(events, NOW);

    expect(components.validAnswers).toBe(1);
    expect(components.distinctWords).toBe(1);
  });

  it('“认识”与实际正确率差异大时给出减少猜测的建议', () => {
    const events = Array.from({ length: 5 }, (_unused, index) =>
      makeEvent(`w-${index}`, { isCorrect: false, recognition: 'KNOWN' }),
    );

    const components = computeAssessmentComponents(events, NOW);
    const result = evaluateAssessment(events, 100, NOW);

    expect(components.recognitionRate).toBe(1);
    expect(components.accuracy).toBe(0);
    expect(result.suggestions.join(' ')).toContain('差异较大');
  });
});

describe('levelFromScore', () => {
  it.each([
    { score: 100, expected: 'STABLE' },
    { score: 85, expected: 'STABLE' },
    { score: 84.999, expected: 'SOLID' },
    { score: 70, expected: 'SOLID' },
    { score: 69.999, expected: 'BUILDING' },
    { score: 50, expected: 'BUILDING' },
    { score: 49.999, expected: 'NEEDS_WORK' },
    { score: 0, expected: 'NEEDS_WORK' },
  ])('$score → $expected', ({ score, expected }) => {
    expect(levelFromScore(score)).toBe(expected);
  });
});

describe('评估输入校验', () => {
  it('无法解析的作答时间抛类型化错误', () => {
    expect(() => evaluateAssessment([makeEvent('w-1', { answeredAt: 'oops' })], 10, NOW)).toThrow(
      InvalidAssessmentInputError,
    );
  });

  it('非法 recognition 抛类型化错误', () => {
    const events = [makeEvent('w-1')];
    const broken = { ...events[0], recognition: 'MAYBE' as unknown as Recognition };

    expect(() => evaluateAssessment([broken], 10, NOW)).toThrow(InvalidAssessmentInputError);
  });

  it('非法词库词数抛类型化错误', () => {
    expect(() => evaluateAssessment([], -1, NOW)).toThrow(InvalidAssessmentInputError);
    expect(() => evaluateAssessment([], 1.5, NOW)).toThrow(InvalidAssessmentInputError);
  });

  it('无效当前时刻抛类型化错误', () => {
    expect(() => evaluateAssessment([], 10, new Date(Number.NaN))).toThrow(InvalidAssessmentInputError);
  });

  it('空 event 列表被视为 0 样本而不是抛错', () => {
    expect(() => evaluateAssessment([], 10, NOW)).not.toThrow();
  });
});
