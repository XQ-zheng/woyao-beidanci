import { describe, expect, it } from 'vitest';

import type { LearningState } from './models';
import type { ReviewPlan } from './models';
import { createDefaultReviewPlan, createInitialLearningState, STUDY_WINDOW_START_HOUR } from './models';
import { buildDailyQueue, createSeededRandom, interleaveWordIds, seededShuffle } from './queue';
import { InvalidReviewPlanError } from './scheduler';

/** 测试统一使用 UTC 计划时区，并通过 `Date.UTC` 构造时刻，因此与宿主机时区无关。 */
const TEST_TIME_ZONE = 'UTC';

/** 构造某个 UTC 时刻。 */
function utc(year: number, month: number, day: number, hour = STUDY_WINDOW_START_HOUR, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
}

/** 构造一条学习状态；默认是“已复习过且已到期”的词。 */
function makeState(wordId: string, overrides: Partial<LearningState> = {}): LearningState {
  const base = createInitialLearningState({
    userWordId: `uw-${wordId}`,
    deckId: 'deck-1',
    wordId,
    dueAt: utc(2025, 6, 5).toISOString(),
  });
  return {
    ...base,
    lastReviewedAt: utc(2025, 6, 1).toISOString(),
    ...overrides,
  };
}

/** 构造计划（默认 UTC）。 */
function makePlan(overrides: Partial<ReviewPlan> = {}): ReviewPlan {
  return createDefaultReviewPlan(TEST_TIME_ZONE, {
    dailyNewLimit: 10,
    dailyReviewLimit: 10,
    ...overrides,
  });
}

/** 断言序列里没有相邻重复。 */
function expectNoAdjacentDuplicates(wordIds: readonly string[]): void {
  for (let index = 1; index < wordIds.length; index += 1) {
    expect(wordIds[index]).not.toBe(wordIds[index - 1]);
  }
}

describe('buildDailyQueue：基本过滤', () => {
  const now = utc(2025, 6, 10, 9);

  it('没有任何状态与生词时返回三个空队列', () => {
    const queue = buildDailyQueue([], [], makePlan(), now, 'seed');

    expect(queue).toEqual({ reviewWordIds: [], newWordIds: [], interleavedWordIds: [] });
  });

  it('复习池只保留“已作答且已到期且未屏蔽”的词', () => {
    const states = [
      makeState('w-due'),
      makeState('w-future', { dueAt: utc(2025, 6, 20).toISOString() }),
      makeState('w-never-reviewed', { lastReviewedAt: null }),
      makeState('w-suppressed', { suppressedAt: utc(2025, 6, 9).toISOString() }),
      makeState('w-broken-due', { dueAt: 'not-a-timestamp' }),
    ];

    const queue = buildDailyQueue(states, [], makePlan(), now, 'seed');

    expect(queue.reviewWordIds).toEqual(['w-due']);
  });

  it('已建状态但从未作答的词进入新词池，而不是在两个池里都消失', () => {
    const states = [makeState('w-pending', { lastReviewedAt: null })];

    const queue = buildDailyQueue(states, ['w-unseen'], makePlan(), now, 'seed');

    expect(queue.reviewWordIds).toEqual([]);
    expect(queue.newWordIds).toEqual(['w-unseen', 'w-pending']);
    expect(queue.interleavedWordIds).toEqual(['w-unseen', 'w-pending']);
  });

  it('到期时间等于 now 时算到期', () => {
    const states = [makeState('w-exact', { dueAt: now.toISOString() })];

    const queue = buildDailyQueue(states, [], makePlan(), now, 'seed');

    expect(queue.reviewWordIds).toEqual(['w-exact']);
  });

  it('“不再出现”的词同时从复习池与新词池移除', () => {
    const states = [
      makeState('w-suppressed', { suppressedAt: utc(2025, 6, 9).toISOString() }),
      makeState('w-ok'),
      makeState('w-suppressed-pending', { lastReviewedAt: null, suppressedAt: utc(2025, 6, 9).toISOString() }),
    ];

    const queue = buildDailyQueue(states, ['w-suppressed', 'w-new'], makePlan(), now, 'seed');

    expect(queue.reviewWordIds).toEqual(['w-ok']);
    expect(queue.newWordIds).toEqual(['w-new']);
  });
});

describe('buildDailyQueue：排序规则', () => {
  const now = utc(2025, 6, 10, 9);

  it('按 逾期天数 DESC → 权重 DESC → dueAt ASC → wordId ASC 排序', () => {
    const states = [
      makeState('w-c', { dueAt: utc(2025, 6, 9, 9).toISOString(), weight: 4 }),
      makeState('w-d', { dueAt: utc(2025, 6, 5, 18).toISOString(), weight: 1 }),
      makeState('w-a', { dueAt: utc(2025, 6, 5, 9).toISOString(), weight: 1 }),
      makeState('w-0', { dueAt: utc(2025, 6, 5, 9).toISOString(), weight: 1 }),
      makeState('w-b', { dueAt: utc(2025, 6, 5, 9).toISOString(), weight: 2 }),
    ];

    const queue = buildDailyQueue(states, [], makePlan(), now, 'seed');

    expect(queue.reviewWordIds).toEqual(['w-b', 'w-0', 'w-a', 'w-d', 'w-c']);
  });

  it('逾期天数优先于权重：高权重但逾期少的词排在后面', () => {
    const states = [
      makeState('w-heavy-recent', { dueAt: utc(2025, 6, 9, 9).toISOString(), weight: 4 }),
      makeState('w-light-overdue', { dueAt: utc(2025, 6, 1, 9).toISOString(), weight: 0.25 }),
    ];

    const queue = buildDailyQueue(states, [], makePlan(), now, 'seed');

    expect(queue.reviewWordIds).toEqual(['w-light-overdue', 'w-heavy-recent']);
  });

  it('非法权重按初始权重参与排序，与调度侧的归一化规则一致', () => {
    const states = [
      makeState('w-normal', { dueAt: utc(2025, 6, 5, 9).toISOString(), weight: 1.5 }),
      makeState('w-broken', { dueAt: utc(2025, 6, 5, 9).toISOString(), weight: Number.NaN }),
    ];

    const queue = buildDailyQueue(states, [], makePlan(), now, 'seed');

    // NaN 归一为初始权重 1，低于 1.5，因此排在后面。
    expect(queue.reviewWordIds).toEqual(['w-normal', 'w-broken']);
  });

  it('同一词的多条状态只出现一次（保留优先级最高的一条）', () => {
    const states = [
      makeState('w-x', { dueAt: utc(2025, 6, 9, 9).toISOString(), weight: 1, deckId: 'deck-a' }),
      makeState('w-x', { dueAt: utc(2025, 6, 1, 9).toISOString(), weight: 1, deckId: 'deck-b' }),
    ];

    const queue = buildDailyQueue(states, [], makePlan(), now, 'seed');

    expect(queue.reviewWordIds).toEqual(['w-x']);
  });
});

describe('buildDailyQueue：每日上限', () => {
  const now = utc(2025, 6, 10, 9);

  it('复习与新词分别受上限约束', () => {
    const states = [
      makeState('w-1', { dueAt: utc(2025, 6, 1).toISOString() }),
      makeState('w-2', { dueAt: utc(2025, 6, 2).toISOString() }),
      makeState('w-3', { dueAt: utc(2025, 6, 3).toISOString() }),
    ];
    const unseen = ['w-n1', 'w-n2', 'w-n3'];

    const queue = buildDailyQueue(states, unseen, makePlan({ dailyReviewLimit: 2, dailyNewLimit: 1 }), now, 'seed');

    expect(queue.reviewWordIds).toHaveLength(2);
    expect(queue.newWordIds).toEqual(['w-n1']);
    expect(queue.interleavedWordIds).toHaveLength(3);
  });

  it('复习上限为 0 时只发新词', () => {
    const states = [makeState('w-1', { dueAt: utc(2025, 6, 1).toISOString() })];

    const queue = buildDailyQueue(states, ['w-n1'], makePlan({ dailyReviewLimit: 0 }), now, 'seed');

    expect(queue.reviewWordIds).toEqual([]);
    expect(queue.newWordIds).toEqual(['w-n1']);
    expect(queue.interleavedWordIds).toEqual(['w-n1']);
  });

  it('新词上限为 0 时只发复习', () => {
    const states = [makeState('w-1', { dueAt: utc(2025, 6, 1).toISOString() })];

    const queue = buildDailyQueue(states, ['w-n1'], makePlan({ dailyNewLimit: 0 }), now, 'seed');

    expect(queue.reviewWordIds).toEqual(['w-1']);
    expect(queue.newWordIds).toEqual([]);
  });

  it('积压超过上限时只取优先级最高的一部分，其余留到明天', () => {
    const states = [
      makeState('w-old', { dueAt: utc(2025, 5, 1).toISOString() }),
      makeState('w-newer', { dueAt: utc(2025, 6, 9).toISOString() }),
    ];

    const queue = buildDailyQueue(states, [], makePlan({ dailyReviewLimit: 1 }), now, 'seed');

    expect(queue.reviewWordIds).toEqual(['w-old']);
  });
});

describe('buildDailyQueue：新词池', () => {
  const now = utc(2025, 6, 10, 9);

  it('已有学习状态且已作答的词不算新词', () => {
    const states = [
      makeState('w-learned-due', { dueAt: utc(2025, 6, 9).toISOString() }),
      makeState('w-learned-future', { dueAt: utc(2025, 6, 30).toISOString() }),
    ];

    const queue = buildDailyQueue(states, ['w-learned-due', 'w-learned-future', 'w-unseen'], makePlan(), now, 'seed');

    expect(queue.newWordIds).toEqual(['w-unseen']);
  });

  it('保持传入的词库顺序并去重', () => {
    const unseen = ['w-n3', 'w-n1', 'w-n3', 'w-n2'];

    const queue = buildDailyQueue([], unseen, makePlan(), now, 'seed');

    expect(queue.newWordIds).toEqual(['w-n3', 'w-n1', 'w-n2']);
  });

  it('新词数量同样受每日上限约束（含从未作答的已建状态词）', () => {
    const states = [
      makeState('w-pending-1', { lastReviewedAt: null }),
      makeState('w-pending-2', { lastReviewedAt: null }),
    ];

    const queue = buildDailyQueue(states, ['w-n1', 'w-n2'], makePlan({ dailyNewLimit: 3 }), now, 'seed');

    expect(queue.newWordIds).toEqual(['w-n1', 'w-n2', 'w-pending-1']);
  });
});

describe('buildDailyQueue：交错', () => {
  const now = utc(2025, 6, 10, 9);

  function buildMixed(): { reviewWordIds: string[]; newWordIds: string[]; interleavedWordIds: string[] } {
    const states = Array.from({ length: 8 }, (_unused, index) =>
      makeState(`w-r${String(index + 1)}`, {
        dueAt: utc(2025, 6, 10 - index, 9).toISOString(),
      }),
    );
    const unseen = ['w-n1', 'w-n2'];

    return buildDailyQueue(states, unseen, makePlan(), now, 'seed-1');
  }

  it('交错结果包含全部元素且不重复', () => {
    const queue = buildMixed();
    const expected = [...queue.reviewWordIds, ...queue.newWordIds];

    expect(queue.interleavedWordIds).toHaveLength(expected.length);
    expect([...queue.interleavedWordIds].sort()).toEqual([...expected].sort());
  });

  it('交错结果保留复习池内部顺序与新词池内部顺序', () => {
    const queue = buildMixed();

    const reviewSubsequence = queue.interleavedWordIds.filter((wordId) => wordId.startsWith('w-r'));
    const newSubsequence = queue.interleavedWordIds.filter((wordId) => wordId.startsWith('w-n'));

    expect(reviewSubsequence).toEqual(queue.reviewWordIds);
    expect(newSubsequence).toEqual(queue.newWordIds);
  });

  it('交错结果没有相邻重复', () => {
    const queue = buildMixed();

    expectNoAdjacentDuplicates(queue.interleavedWordIds);
  });

  it('同一 seed 结果完全可重放', () => {
    const first = buildMixed();
    const second = buildMixed();

    expect(second.interleavedWordIds).toEqual(first.interleavedWordIds);
  });

  it('不同 seed 会改变交错顺序', () => {
    const states = Array.from({ length: 8 }, (_unused, index) =>
      makeState(`w-r${String(index + 1)}`, { dueAt: utc(2025, 6, 10 - index, 9).toISOString() }),
    );
    const unseen = ['w-n1', 'w-n2'];
    const orders = new Set<string>();

    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      orders.add(buildDailyQueue(states, unseen, makePlan(), now, seed).interleavedWordIds.join(','));
    }

    expect(orders.size).toBeGreaterThan(1);
  });

  it('新词不会被整体堆到末尾（至少某些种子下会提前插入）', () => {
    const states = Array.from({ length: 8 }, (_unused, index) =>
      makeState(`w-r${String(index + 1)}`, { dueAt: utc(2025, 6, 10 - index, 9).toISOString() }),
    );
    const unseen = ['w-n1', 'w-n2'];
    const concatenated = ['w-r1', 'w-r2', 'w-r3', 'w-r4', 'w-r5', 'w-r6', 'w-r7', 'w-r8', 'w-n1', 'w-n2'];

    const outputs = ['a', 'b', 'c', 'd', 'e'].map((seed) =>
      buildDailyQueue(states, unseen, makePlan(), now, seed).interleavedWordIds,
    );

    expect(outputs.some((output) => output.join(',') !== concatenated.join(','))).toBe(true);
  });

  it('只有复习或只有新词时不做交错', () => {
    const onlyReviews = buildDailyQueue(
      [makeState('w-1', { dueAt: utc(2025, 6, 1).toISOString() })],
      [],
      makePlan(),
      now,
      'seed',
    );
    const onlyNews = buildDailyQueue([], ['w-n1', 'w-n2'], makePlan(), now, 'seed');

    expect(onlyReviews.interleavedWordIds).toEqual(onlyReviews.reviewWordIds);
    expect(onlyNews.interleavedWordIds).toEqual(onlyNews.newWordIds);
  });
});

describe('buildDailyQueue：输入校验', () => {
  const now = utc(2025, 6, 10, 9);

  it('非法计划抛 InvalidReviewPlanError', () => {
    expect(() => buildDailyQueue([], [], makePlan({ intervalsDays: [2, 2] }), now, 'seed')).toThrow(
      InvalidReviewPlanError,
    );
    expect(() => buildDailyQueue([], [], makePlan({ timeZone: 'Mars/Olympus' }), now, 'seed')).toThrow(
      InvalidReviewPlanError,
    );
  });

  it('无效 now 抛错', () => {
    expect(() => buildDailyQueue([], [], makePlan(), new Date(Number.NaN), 'seed')).toThrow(RangeError);
  });

  it('不修改传入的状态数组顺序', () => {
    const states = [
      makeState('w-b', { dueAt: utc(2025, 6, 1).toISOString() }),
      makeState('w-a', { dueAt: utc(2025, 6, 2).toISOString() }),
    ];

    buildDailyQueue(states, [], makePlan(), now, 'seed');

    expect(states.map((state) => state.wordId)).toEqual(['w-b', 'w-a']);
  });
});

describe('interleaveWordIds', () => {
  it('空池时返回另一池', () => {
    expect(interleaveWordIds([], ['n1'], 'seed')).toEqual(['n1']);
    expect(interleaveWordIds(['r1'], [], 'seed')).toEqual(['r1']);
    expect(interleaveWordIds([], [], 'seed')).toEqual([]);
  });

  it('不修改入参数组', () => {
    const reviews = ['r1', 'r2'];
    const news = ['n1', 'n2'];

    interleaveWordIds(reviews, news, 'seed');

    expect(reviews).toEqual(['r1', 'r2']);
    expect(news).toEqual(['n1', 'n2']);
  });

  it('两池不相交时任何种子都不产生相邻重复', () => {
    const reviews = ['r1', 'r2', 'r3', 'r4', 'r5'];
    const news = ['n1', 'n2', 'n3'];

    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const result = interleaveWordIds(reviews, news, seed);
      expectNoAdjacentDuplicates(result);
      expect(result).toHaveLength(reviews.length + news.length);
    }
  });

  it('两池完全重叠时不产生相邻重复（必要时去重重复副本）', () => {
    expect(interleaveWordIds(['x'], ['x'], 'seed')).toEqual(['x']);
    // 词跨池重复出现但不相邻时保留两个条目，只保证“不相邻”。
    const overlapped = interleaveWordIds(['x', 'y'], ['x'], 'seed');
    expectNoAdjacentDuplicates(overlapped);
    expect([...overlapped].sort()).toEqual(['x', 'x', 'y']);
    expectNoAdjacentDuplicates(interleaveWordIds(['x', 'y', 'z'], ['y', 'z'], 'seed'));
  });

  it('单侧池内部有重复时也不产生相邻重复', () => {
    const result = interleaveWordIds(['a', 'a', 'b'], ['c'], 'seed');

    expectNoAdjacentDuplicates(result);
    expect(result).toContain('b');
    expect(result).toContain('c');
  });

  it('不会凭空造出新元素', () => {
    const result = interleaveWordIds(['x', 'y'], ['y', 'x'], 'seed');

    result.forEach((wordId) => {
      expect(['x', 'y']).toContain(wordId);
    });
  });
});

describe('确定性随机工具', () => {
  it('相同 seed 的随机序列一致，不同 seed 不一致', () => {
    const first = createSeededRandom('seed-a');
    const second = createSeededRandom('seed-a');
    const other = createSeededRandom('seed-b');

    const firstValues = [first(), first(), first()];
    const secondValues = [second(), second(), second()];
    const otherValues = [other(), other(), other()];

    expect(secondValues).toEqual(firstValues);
    expect(otherValues).not.toEqual(firstValues);
    firstValues.forEach((value) => {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    });
  });

  it('seededShuffle 是排列、可重放，且不修改入参', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];

    const shuffled = seededShuffle(items, 'seed-x');

    expect([...shuffled].sort()).toEqual([...items]);
    expect(seededShuffle(items, 'seed-x')).toEqual(shuffled);
    expect(items).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
