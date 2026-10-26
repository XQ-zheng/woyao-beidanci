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

  it('恰好落在 85 分线上时判 STABLE（浮点容差）', () => {
    // A=1（全对）、R=50/60、M=0.5（无到期复习样本，中性值）、E=1（无错误）
    // → 100 * (0.5*1 + 0.15*(5/6) + 0.25*0.5 + 0.1*1) = 85
    const events: AssessmentEvent[] = [];
    for (let wordIndex = 0; wordIndex < 30; wordIndex += 1) {
      const recognition: Recognition = wordIndex < 25 ? 'KNOWN' : 'UNKNOWN';
      events.push(makeEvent(`w-${wordIndex}`, { recognition, isCorrect: true }));
      events.push(makeEvent(`w-${wordIndex}`, { recognition, isCorrect: true }));
    }

    const result = evaluateAssessment(events, 100, NOW);

    expect(result.validAnswers).toBe(60);
    expect(result.score).toBeCloseTo(85, 6);
    expect(result.level).toBe('STABLE');
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

  it('只有一个子窗口有样本时按该窗口归一，不把 0 掺进权重', () => {
    const recentOnly: AssessmentEvent[] = [
      makeEvent('w-1', { ageDays: 5, isCorrect: true }),
      makeEvent('w-2', { ageDays: 5, isCorrect: false, recognition: 'UNKNOWN' }),
    ];
    const earlierOnly: AssessmentEvent[] = [
      makeEvent('w-3', { ageDays: 45, isCorrect: true }),
      makeEvent('w-4', { ageDays: 45, isCorrect: true }),
      makeEvent('w-5', { ageDays: 45, isCorrect: false, recognition: 'UNKNOWN' }),
    ];

    const recentComponents = computeAssessmentComponents(recentOnly, NOW);
    const earlierComponents = computeAssessmentComponents(earlierOnly, NOW);

    // 近 30 天独有样本：0.6*0.5/0.6 = 0.5（若按 0.6*0.5 + 0.4*0 会错成 0.3）
    expect(recentComponents.accuracy).toBeCloseTo(0.5, 10);
    expect(recentComponents.recentAnswers).toBe(2);
    // 只有较早窗口样本：0.4*(2/3)/0.4 = 2/3（若掺 0 会错成 0.2667）
    expect(earlierComponents.accuracy).toBeCloseTo(2 / 3, 10);
    expect(earlierComponents.recentAnswers).toBe(0);
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

  it('提前作答（answeredAt < dueAt）不算到期复习样本', () => {
    // dueOffsetHours 取负值 → dueAt 晚于 answeredAt，属于“提前作答”。
    const early = [makeEvent('w-1', { dueOffsetHours: -5, isCorrect: true })];

    const components = computeAssessmentComponents(early, NOW);

    expect(components.dueReviewSamples).toBe(0);
    expect(components.hasDueReviewSamples).toBe(false);
    expect(components.dueReviewScore).toBe(NEUTRAL_DUE_REVIEW_SCORE);
  });

  it('提前作答与按时作答混在一起时只统计按时的那条', () => {
    const events: AssessmentEvent[] = [
      makeEvent('w-1', { dueOffsetHours: -5, isCorrect: true }),
      makeEvent('w-2', { dueOffsetHours: 1, isCorrect: false, recognition: 'UNKNOWN' }),
    ];

    const components = computeAssessmentComponents(events, NOW);

    expect(components.dueReviewSamples).toBe(1);
    expect(components.dueReviewCorrect).toBe(0);
    expect(components.dueReviewScore).toBe(0);
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

  it.each([
    { score: 85 - 1e-12, expected: 'STABLE' },
    { score: 70 - 1e-12, expected: 'SOLID' },
    { score: 50 - 1e-12, expected: 'BUILDING' },
  ])('浮点误差内的 $score 仍判 $expected（容差不吞掉真实降级）', ({ score, expected }) => {
    expect(levelFromScore(score)).toBe(expected);
  });

  it.each([
    { score: 85 - 1e-6, expected: 'SOLID' },
    { score: 70 - 1e-6, expected: 'BUILDING' },
    { score: 50 - 1e-6, expected: 'NEEDS_WORK' },
  ])('超出容差的 $score 正常降级为 $expected', ({ score, expected }) => {
    expect(levelFromScore(score)).toBe(expected);
  });
});

describe('评估：建议按最大短板排序', () => {
  it('正确率缺口最大时它排第一并标“首要短板”', () => {
    // 10 个词 × 6 次 = 60 次作答；正确 12 次（6 个词各 2 次，A=0.2）、认识 30 次（R=0.5），
    // 至少答对一次的词 6 个 / 词库 25 词 = 覆盖 0.24。
    // 缺口：正确率 0.8 > 覆盖 0.76 > 自评差异 0.3。
    const events: AssessmentEvent[] = [];
    for (let wordIndex = 0; wordIndex < 10; wordIndex += 1) {
      for (let answerIndex = 0; answerIndex < 6; answerIndex += 1) {
        const isCorrect = wordIndex < 6 && answerIndex < 2;
        const recognition: Recognition = wordIndex < 5 ? 'KNOWN' : 'UNKNOWN';
        events.push(makeEvent(`w-${wordIndex}`, { isCorrect, recognition }));
      }
    }

    const result = evaluateAssessment(events, 25, NOW);
    const shortfallSuggestions = result.suggestions.filter((suggestion) =>
      suggestion.startsWith('首要短板：') || suggestion.startsWith('次要短板：'),
    );

    expect(shortfallSuggestions[0]).toBe(
      '首要短板：正确率偏低：建议优先复习错词，并在错词本集中练习。',
    );
    expect(shortfallSuggestions.some((suggestion) => suggestion.includes('词库覆盖偏低'))).toBe(true);
    expect(shortfallSuggestions.some((suggestion) => suggestion.includes('差异较大'))).toBe(true);
    // 缺口小的排后面
    expect(shortfallSuggestions[shortfallSuggestions.length - 1]).toContain('差异较大');
  });

  it('“复习样本不足”是说明而非短板，永远排在任何短板之前', () => {
    const events = buildSamples(MIN_DISTINCT_WORDS, 2, { isCorrect: false, recognition: 'KNOWN' });

    const result = evaluateAssessment(events, 100, NOW);

    expect(result.level).not.toBe('INSUFFICIENT_SAMPLE');
    expect(result.suggestions[0]).toContain('复习样本不足');
    expect(result.suggestions[1]).toMatch(/^首要短板：/u);
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
