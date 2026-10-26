import { describe, expect, it } from 'vitest';

import type { AnswerInput, LearningState, ReviewPlan } from './models';
import {
  createDefaultReviewPlan,
  createInitialLearningState,
  DEFAULT_INTERVALS_DAYS,
  STAGE_NEVER_REVIEWED,
  STUDY_WINDOW_START_HOUR,
} from './models';
import {
  InvalidAnswerError,
  InvalidReviewPlanError,
  lastStageOf,
  nextDueInStudyWindow,
  nextLearningState,
  validateReviewPlan,
} from './scheduler';

/** 用本地日历分量构造时刻，保证测试与运行环境的时区无关。 */
function localTime(
  year: number,
  month: number,
  day: number,
  hour = STUDY_WINDOW_START_HOUR,
  minute = 0,
): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

/** 构造一个学习状态，默认是“从未学习过的新词”。 */
function makeState(overrides: Partial<LearningState> = {}): LearningState {
  const base = createInitialLearningState({
    userWordId: 'uw-1',
    deckId: 'deck-1',
    wordId: 'w-1',
    dueAt: localTime(2025, 1, 1).toISOString(),
  });
  return { ...base, ...overrides };
}

/** 构造一次作答，默认是 2025-01-14 20:00 答对且“认识”。 */
function makeAnswer(overrides: Partial<AnswerInput> = {}): AnswerInput {
  return {
    isCorrect: true,
    recognition: 'KNOWN',
    mode: 'EN_TO_ZH',
    answeredAt: localTime(2025, 1, 14, 20).toISOString(),
    ...overrides,
  };
}

/** 自定义计划。 */
function makePlan(overrides: Partial<ReviewPlan> = {}): ReviewPlan {
  return createDefaultReviewPlan(overrides);
}

describe('createInitialLearningState', () => {
  it('新词初始 stage=-1，权重 1，计数为 0，未屏蔽', () => {
    const state = makeState();

    expect(state.stage).toBe(-1);
    expect(state.stage).toBe(STAGE_NEVER_REVIEWED);
    expect(state.weight).toBe(1);
    expect(state.correctCount).toBe(0);
    expect(state.wrongCount).toBe(0);
    expect(state.streakCorrect).toBe(0);
    expect(state.lastReviewedAt).toBeNull();
    expect(state.suppressedAt).toBeNull();
  });
});

describe('nextLearningState：新词第一次作答', () => {
  it('答对且“认识”：stage -1→0，按 intervalsDays[0]=1 天在次日 09:00 到期', () => {
    const state = makeState();
    const answer = makeAnswer();
    const now = localTime(2025, 1, 14, 20);

    const next = nextLearningState(state, answer, makePlan(), now);

    expect(next.stage).toBe(0);
    expect(next.dueAt).toBe(localTime(2025, 1, 15).toISOString());
    expect(next.lastReviewedAt).toBe(answer.answeredAt);
    expect(next.correctCount).toBe(1);
    expect(next.wrongCount).toBe(0);
    expect(next.streakCorrect).toBe(1);
    expect(next.weight).toBeCloseTo(0.8, 10);
  });

  it('答错：stage 保持 -1，10 分钟后重练，权重 ×1.75', () => {
    const state = makeState();
    const answer = makeAnswer({ isCorrect: false, recognition: 'UNKNOWN' });
    const now = localTime(2025, 1, 14, 20);

    const next = nextLearningState(state, answer, makePlan(), now);

    expect(next.stage).toBe(-1);
    expect(next.dueAt).toBe(localTime(2025, 1, 14, 20, 10).toISOString());
    expect(next.correctCount).toBe(0);
    expect(next.wrongCount).toBe(1);
    expect(next.streakCorrect).toBe(0);
    expect(next.weight).toBeCloseTo(1.75, 10);
  });

  it('答对但“不认识”：stage 保持 -1，安排次日，权重不变', () => {
    const state = makeState();
    const answer = makeAnswer({ isCorrect: true, recognition: 'UNKNOWN' });
    const now = localTime(2025, 1, 14, 20);

    const next = nextLearningState(state, answer, makePlan(), now);

    expect(next.stage).toBe(-1);
    expect(next.dueAt).toBe(localTime(2025, 1, 15).toISOString());
    expect(next.correctCount).toBe(1);
    expect(next.streakCorrect).toBe(1);
    expect(next.weight).toBe(1);
  });

  it('答错不把 dueAt 推到明天', () => {
    const state = makeState();
    const now = localTime(2025, 1, 14, 20);

    const next = nextLearningState(
      state,
      makeAnswer({ isCorrect: false, recognition: 'UNKNOWN' }),
      makePlan(),
      now,
    );

    expect(new Date(next.dueAt).getTime()).toBeLessThan(localTime(2025, 1, 15).getTime());
  });
});

describe('nextLearningState：阶段推进', () => {
  it('答对且“认识”先升阶段，再用新阶段的间隔（stage 2 → 3，用 intervalsDays[3]=7 天）', () => {
    const state = makeState({ stage: 2, lastReviewedAt: localTime(2025, 1, 7).toISOString() });
    const now = localTime(2025, 1, 14, 8, 30);

    const next = nextLearningState(state, makeAnswer({ answeredAt: now.toISOString() }), makePlan(), now);

    expect(next.stage).toBe(3);
    expect(next.dueAt).toBe(localTime(2025, 1, 21).toISOString());
  });

  it('答错后重练答对仍执行 -1→0，使用 1 天间隔而不提前跳到 2 天', () => {
    const state = makeState({
      stage: -1,
      lastReviewedAt: localTime(2025, 1, 14, 20, 10).toISOString(),
      wrongCount: 1,
      weight: 1.75,
    });
    const now = localTime(2025, 1, 14, 20, 20);

    const next = nextLearningState(state, makeAnswer({ answeredAt: now.toISOString() }), makePlan(), now);

    expect(next.stage).toBe(0);
    expect(next.dueAt).toBe(localTime(2025, 1, 15).toISOString());
  });

  it('到达最高阶段后持续使用最后一个间隔', () => {
    const plan = makePlan({ intervalsDays: [1, 2] });
    const state = makeState({ stage: lastStageOf(plan), lastReviewedAt: localTime(2025, 1, 7).toISOString() });
    const now = localTime(2025, 1, 14, 8, 30);

    const next = nextLearningState(state, makeAnswer({ answeredAt: now.toISOString() }), plan, now);

    expect(next.stage).toBe(1);
    expect(next.dueAt).toBe(localTime(2025, 1, 16).toISOString());
  });

  it('答对但“不认识”：阶段不升，仍安排次日', () => {
    const state = makeState({ stage: 3, lastReviewedAt: localTime(2025, 1, 7).toISOString() });
    const now = localTime(2025, 1, 14, 8, 30);

    const next = nextLearningState(
      state,
      makeAnswer({ answeredAt: now.toISOString(), recognition: 'UNKNOWN' }),
      makePlan(),
      now,
    );

    expect(next.stage).toBe(3);
    expect(next.dueAt).toBe(localTime(2025, 1, 15).toISOString());
  });
});

describe('nextLearningState：答错退级', () => {
  it('stage 3 答错退到 2，连对清零，错次 +1', () => {
    const state = makeState({ stage: 3, streakCorrect: 4, correctCount: 4, wrongCount: 1 });
    const now = localTime(2025, 3, 3, 10);

    const next = nextLearningState(
      state,
      makeAnswer({ answeredAt: now.toISOString(), isCorrect: false, recognition: 'UNKNOWN' }),
      makePlan(),
      now,
    );

    expect(next.stage).toBe(2);
    expect(next.streakCorrect).toBe(0);
    expect(next.correctCount).toBe(4);
    expect(next.wrongCount).toBe(2);
  });

  it('stage 0 答错退到 -1', () => {
    const state = makeState({ stage: 0 });
    const now = localTime(2025, 3, 3, 10);

    const next = nextLearningState(
      state,
      makeAnswer({ answeredAt: now.toISOString(), isCorrect: false, recognition: 'UNKNOWN' }),
      makePlan(),
      now,
    );

    expect(next.stage).toBe(-1);
  });

  it('stage -1 答错仍为 -1，不会越界', () => {
    const state = makeState({ stage: -1 });
    const now = localTime(2025, 3, 3, 10);

    const next = nextLearningState(
      state,
      makeAnswer({ answeredAt: now.toISOString(), isCorrect: false, recognition: 'UNKNOWN' }),
      makePlan(),
      now,
    );

    expect(next.stage).toBe(-1);
  });
});

describe('nextLearningState：权重乘数与钳制', () => {
  it('答错乘 1.75', () => {
    const now = localTime(2025, 3, 3, 10);
    const next = nextLearningState(
      makeState({ weight: 1 }),
      makeAnswer({ answeredAt: now.toISOString(), isCorrect: false, recognition: 'UNKNOWN' }),
      makePlan(),
      now,
    );

    expect(next.weight).toBeCloseTo(1.75, 10);
  });

  it('答对且“认识”乘 0.8', () => {
    const now = localTime(2025, 3, 3, 10);
    const next = nextLearningState(
      makeState({ weight: 1.5 }),
      makeAnswer({ answeredAt: now.toISOString() }),
      makePlan(),
      now,
    );

    expect(next.weight).toBeCloseTo(1.2, 10);
  });

  it('答错后权重不超过上限 4.0', () => {
    const now = localTime(2025, 3, 3, 10);
    const next = nextLearningState(
      makeState({ weight: 3 }),
      makeAnswer({ answeredAt: now.toISOString(), isCorrect: false, recognition: 'UNKNOWN' }),
      makePlan(),
      now,
    );

    expect(next.weight).toBe(4);
  });

  it('答对且“认识”后权重不低于下限 0.25', () => {
    const now = localTime(2025, 3, 3, 10);
    const next = nextLearningState(
      makeState({ weight: 0.3 }),
      makeAnswer({ answeredAt: now.toISOString() }),
      makePlan(),
      now,
    );

    expect(next.weight).toBe(0.25);
  });

  it('连续答对不会把权重降到 0.25 以下', () => {
    const now = localTime(2025, 3, 3, 10);
    let state = makeState({ weight: 0.25 });

    for (let index = 0; index < 10; index += 1) {
      state = nextLearningState(state, makeAnswer({ answeredAt: now.toISOString() }), makePlan(), now);
    }

    expect(state.weight).toBe(0.25);
  });

  it('答对但“不认识”不改变权重', () => {
    const now = localTime(2025, 3, 3, 10);
    const next = nextLearningState(
      makeState({ weight: 1.4 }),
      makeAnswer({ answeredAt: now.toISOString(), recognition: 'UNKNOWN' }),
      makePlan(),
      now,
    );

    expect(next.weight).toBeCloseTo(1.4, 10);
  });
});

describe('nextLearningState：纯函数与时间注入', () => {
  it('不修改入参状态', () => {
    const state = makeState({ stage: 1, weight: 2, correctCount: 3 });
    const snapshot = { ...state };
    const now = localTime(2025, 3, 3, 10);

    const next = nextLearningState(state, makeAnswer({ answeredAt: now.toISOString() }), makePlan(), now);

    expect(state).toEqual(snapshot);
    expect(next).not.toBe(state);
    expect(next.stage).not.toBe(snapshot.stage);
  });

  it('lastReviewedAt 记录作答时间而不是注入的 now', () => {
    const answeredAt = localTime(2025, 3, 3, 9, 55).toISOString();
    const now = localTime(2025, 3, 3, 10);

    const next = nextLearningState(makeState(), makeAnswer({ answeredAt }), makePlan(), now);

    expect(next.lastReviewedAt).toBe(answeredAt);
  });

  it('作答时间晚于注入时钟时以 now 为基准，避免生成未来到期', () => {
    const now = localTime(2025, 3, 3, 10);
    const futureAnsweredAt = localTime(2025, 3, 4, 10).toISOString();

    const next = nextLearningState(makeState(), makeAnswer({ answeredAt: futureAnsweredAt }), makePlan(), now);

    expect(next.dueAt).toBe(localTime(2025, 3, 4).toISOString());
    expect(next.lastReviewedAt).toBe(now.toISOString());
  });

  it('无效作答时间抛出类型化错误而不是静默取当前时间', () => {
    const now = localTime(2025, 3, 3, 10);

    expect(() =>
      nextLearningState(makeState(), makeAnswer({ answeredAt: 'not-a-date' }), makePlan(), now),
    ).toThrow(InvalidAnswerError);
  });
});

describe('nextDueInStudyWindow', () => {
  it('目标本地日 09:00 到期', () => {
    const due = nextDueInStudyWindow(localTime(2025, 5, 1, 22, 30), 2);

    expect(due.getHours()).toBe(STUDY_WINDOW_START_HOUR);
    expect(due.getMinutes()).toBe(0);
    expect(due.toISOString()).toBe(localTime(2025, 5, 3).toISOString());
  });

  it('跨月加法按本地日历日计算', () => {
    const due = nextDueInStudyWindow(localTime(2025, 1, 31, 23, 0), 1);

    expect(due.toISOString()).toBe(localTime(2025, 2, 1).toISOString());
  });

  it('间隔天数非法时抛错', () => {
    expect(() => nextDueInStudyWindow(localTime(2025, 5, 1, 9), 0)).toThrow(RangeError);
    expect(() => nextDueInStudyWindow(localTime(2025, 5, 1, 9), 1.5)).toThrow(RangeError);
  });
});

describe('复习计划校验', () => {
  it('默认计划合法：1..365 的整数、严格递增、1..12 个节点', () => {
    const plan = createDefaultReviewPlan();

    expect(validateReviewPlan(plan)).toEqual({ ok: true });
    expect(plan.intervalsDays).toEqual([...DEFAULT_INTERVALS_DAYS]);
    expect(plan.intervalsDays.length).toBeGreaterThanOrEqual(1);
    expect(plan.intervalsDays.length).toBeLessThanOrEqual(12);
  });

  it('接受 1 个节点与 12 个节点的边界配置', () => {
    expect(validateReviewPlan(makePlan({ intervalsDays: [365] }))).toEqual({ ok: true });
    expect(
      validateReviewPlan(makePlan({ intervalsDays: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 365] })),
    ).toEqual({ ok: true });
  });

  it.each([
    { name: '空数组', intervalsDays: [], field: 'intervalsDays' },
    { name: '0 天', intervalsDays: [0, 1], field: 'intervalsDays[0]' },
    { name: '超过 365 天', intervalsDays: [1, 366], field: 'intervalsDays[1]' },
    { name: '小数', intervalsDays: [1, 2.5], field: 'intervalsDays[1]' },
    { name: '重复节点', intervalsDays: [1, 2, 2], field: 'intervalsDays[2]' },
    { name: '非严格递增', intervalsDays: [4, 2], field: 'intervalsDays[1]' },
    {
      name: '超过 12 个节点',
      intervalsDays: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      field: 'intervalsDays',
    },
  ])('拒绝非法间隔节点：$name', ({ intervalsDays, field }) => {
    const result = validateReviewPlan(makePlan({ intervalsDays }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.field)).toContain(field);
    }
  });

  it.each([
    { name: '负数新词数', override: { dailyNewLimit: -1 }, field: 'dailyNewLimit' },
    { name: '超过 500 的复习数', override: { dailyReviewLimit: 501 }, field: 'dailyReviewLimit' },
    { name: '小数复习数', override: { dailyReviewLimit: 1.5 }, field: 'dailyReviewLimit' },
    { name: '两项都为 0', override: { dailyNewLimit: 0, dailyReviewLimit: 0 }, field: 'dailyNewLimit' },
  ])('拒绝非法每日数量：$name', ({ override, field }) => {
    const result = validateReviewPlan(makePlan(override));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.field)).toContain(field);
    }
  });

  it('计划非法时抛 InvalidReviewPlanError，不静默回退默认间隔', () => {
    const now = localTime(2025, 3, 3, 10);
    const badPlan = makePlan({ intervalsDays: [0, 2] });

    expect(() => nextLearningState(makeState(), makeAnswer({ answeredAt: now.toISOString() }), badPlan, now)).toThrow(
      InvalidReviewPlanError,
    );
  });

  it('错误对象带出字段级问题列表', () => {
    const now = localTime(2025, 3, 3, 10);

    try {
      nextLearningState(makeState(), makeAnswer({ answeredAt: now.toISOString() }), makePlan({ intervalsDays: [3, 3] }), now);
      expect.unreachable('应当抛出 InvalidReviewPlanError');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidReviewPlanError);
      const planError = error as InvalidReviewPlanError;
      expect(planError.code).toBe('INVALID_REVIEW_PLAN');
      expect(planError.issues).toHaveLength(1);
      expect(planError.issues[0].field).toBe('intervalsDays[1]');
    }
  });
});

describe('自定义间隔生效', () => {
  it('使用自定义节点计算到期（[1,3] 的 stage 0 → 1 用 3 天）', () => {
    const plan = makePlan({ intervalsDays: [1, 3] });
    const now = localTime(2025, 4, 10, 8);
    const state = makeState({ stage: 0, lastReviewedAt: localTime(2025, 4, 9).toISOString() });

    const next = nextLearningState(state, makeAnswer({ answeredAt: now.toISOString() }), plan, now);

    expect(next.stage).toBe(1);
    expect(next.dueAt).toBe(localTime(2025, 4, 13).toISOString());
  });

  it('计划缩短后再次作答时阶段被限制在新 LAST_STAGE 内', () => {
    const shortPlan = makePlan({ intervalsDays: [1, 2] });
    const now = localTime(2025, 4, 10, 8);
    const longState = makeState({ stage: 4, lastReviewedAt: localTime(2025, 4, 1).toISOString() });

    const next = nextLearningState(longState, makeAnswer({ answeredAt: now.toISOString() }), shortPlan, now);

    expect(next.stage).toBe(1);
    expect(next.dueAt).toBe(localTime(2025, 4, 12).toISOString());
  });

  it('计划缩短后答错的退级也不越界', () => {
    const shortPlan = makePlan({ intervalsDays: [1, 2] });
    const now = localTime(2025, 4, 10, 8);
    const longState = makeState({ stage: 4 });

    const next = nextLearningState(
      longState,
      makeAnswer({ answeredAt: now.toISOString(), isCorrect: false, recognition: 'UNKNOWN' }),
      shortPlan,
      now,
    );

    expect(next.stage).toBe(0);
  });
});
