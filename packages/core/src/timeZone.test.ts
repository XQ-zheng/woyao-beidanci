import { describe, expect, it } from 'vitest';

import { isValidTimeZone, localWallTimeToInstant, zonedDateTimeParts, zonedDayNumber } from './clock';
import type { AnswerInput, LearningState, ReviewPlan } from './models';
import { createDefaultReviewPlan, createInitialLearningState } from './models';
import { buildDailyQueue } from './queue';
import { nextLearningState, validateReviewPlan } from './scheduler';

/**
 * 时区确定性测试。
 *
 * 断言全部使用**绝对 UTC 时刻**，并且不读取宿主机本地时区，
 * 因此同一份用例在 UTC / Asia/Shanghai / America/New_York 的机器上结果完全一致。
 */

/** 构造某个 UTC 时刻。 */
function utc(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
}

/** 构造一个“新词”学习状态。 */
function makeNewState(): LearningState {
  return createInitialLearningState({
    userWordId: 'uw-1',
    deckId: 'deck-1',
    wordId: 'w-1',
    dueAt: utc(2025, 1, 1).toISOString(),
  });
}

/** 构造一次“答对且认识”的作答。 */
function makeAnswer(answeredAt: Date): AnswerInput {
  return { isCorrect: true, recognition: 'KNOWN', mode: 'EN_TO_ZH', answeredAt: answeredAt.toISOString() };
}

/** 构造指定时区的计划。 */
function makePlan(timeZone: string): ReviewPlan {
  return createDefaultReviewPlan(timeZone, { dailyNewLimit: 10, dailyReviewLimit: 10 });
}

describe('createDefaultReviewPlan 要求显式时区', () => {
  it('使用传入的时区，并允许覆盖', () => {
    expect(createDefaultReviewPlan('Asia/Shanghai').timeZone).toBe('Asia/Shanghai');
    expect(createDefaultReviewPlan('UTC', { timeZone: 'America/New_York' }).timeZone).toBe(
      'America/New_York',
    );
  });
});

describe('isValidTimeZone', () => {
  it('识别合法 IANA 时区', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Australia/Lord_Howe')).toBe(true);
    expect(isValidTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
    expect(isValidTimeZone('Etc/GMT+5')).toBe(true);
  });

  it('拒绝空值与未知时区', () => {
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('   ')).toBe(false);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('Asia/Shanghai/Extra')).toBe(false);
  });

  it('拒绝纯 UTC 偏移写法（R1：运行时 Intl 会接受，但它没有 DST 规则、会漂移）', () => {
    expect(isValidTimeZone('+08:00')).toBe(false);
    expect(isValidTimeZone('-05:00')).toBe(false);
    expect(isValidTimeZone('+0800')).toBe(false);
    expect(isValidTimeZone('+08')).toBe(false);
    expect(isValidTimeZone('-0530')).toBe(false);
  });

  it('拒绝 UTC/GMT 前缀的偏移写法（同一类“没有 DST 规则”的伪时区）', () => {
    expect(isValidTimeZone('UTC+8')).toBe(false);
    expect(isValidTimeZone('UTC+08:00')).toBe(false);
    expect(isValidTimeZone('GMT-0500')).toBe(false);
    // 真正的 IANA 名称必须继续合法，别把 Etc/GMT+5 这类带符号的合法名一起拒掉。
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('GMT')).toBe(true);
    expect(isValidTimeZone('Etc/UTC')).toBe(true);
    expect(isValidTimeZone('Etc/GMT+5')).toBe(true);
  });

  it('计划时区为纯偏移写法时校验失败并指出字段', () => {
    const result = validateReviewPlan(createDefaultReviewPlan('+08:00'));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.field)).toContain('timeZone');
    }
  });
});

describe('到期时间按计划时区换算（同一输入跨时区确定性）', () => {
  // 同一作答时刻：2025-06-10T22:30:00Z，新词答对且“认识”→ 次日 09:00（计划时区本地）。
  const answeredAt = utc(2025, 6, 10, 22, 30);

  it.each([
    {
      timeZone: 'UTC',
      // 本地 06-10 22:30 → 次日 06-11 09:00Z
      expected: '2025-06-11T09:00:00.000Z',
    },
    {
      timeZone: 'Asia/Shanghai',
      // 本地 06-11 06:30 (+08) → 次日 06-12 09:00+08 = 06-12T01:00Z
      expected: '2025-06-12T01:00:00.000Z',
    },
    {
      timeZone: 'America/New_York',
      // 本地 06-10 18:30 (EDT -04) → 次日 06-11 09:00-04 = 13:00Z
      expected: '2025-06-11T13:00:00.000Z',
    },
    {
      timeZone: 'Australia/Lord_Howe',
      // 本地 06-11 09:00 (+10:30) → 次日 06-12 09:00+10:30 = 06-11T22:30Z
      expected: '2025-06-11T22:30:00.000Z',
    },
  ])('$timeZone → $expected', ({ timeZone, expected }) => {
    const plan = makePlan(timeZone);

    const next = nextLearningState(makeNewState(), makeAnswer(answeredAt), plan, answeredAt);

    expect(next.stage).toBe(0);
    expect(next.dueAt).toBe(expected);
  });

  it('宿主机时区无关：同一计划在任意宿主时区下得到同一 dueAt', () => {
    const plan = makePlan('Asia/Shanghai');
    const next = nextLearningState(makeNewState(), makeAnswer(answeredAt), plan, answeredAt);

    // 断言绝对时刻与其在计划时区内的墙上时间（09:00），而不是宿主机本地时间。
    expect(new Date(next.dueAt).getTime()).toBe(Date.parse('2025-06-12T01:00:00.000Z'));
    const parts = zonedDateTimeParts(new Date(next.dueAt), 'Asia/Shanghai');
    expect(parts.hour).toBe(9);
    expect(parts.minute).toBe(0);
    expect(parts.day).toBe(12);
  });
});

describe('localWallTimeToInstant：DST 确定性处理', () => {
  it('普通时间只有唯一解', () => {
    expect(
      localWallTimeToInstant(
        { year: 2025, month: 6, day: 12, hour: 9, minute: 0, second: 0 },
        'Asia/Shanghai',
      ).toISOString(),
    ).toBe('2025-06-12T01:00:00.000Z');
  });

  it('不存在的时间（春季前拨空洞）顺延到下一个有效时刻', () => {
    // America/New_York 2025-03-09 02:00 → 03:00，02:30 不存在 → 03:30 EDT = 07:30Z
    expect(
      localWallTimeToInstant(
        { year: 2025, month: 3, day: 9, hour: 2, minute: 30, second: 0 },
        'America/New_York',
      ).toISOString(),
    ).toBe('2025-03-09T07:30:00.000Z');

    // Australia/Lord_Howe 2025-10-05 02:00 → 02:30（半小时前拨），02:15 不存在 → 02:45 = 15:45Z
    expect(
      localWallTimeToInstant(
        { year: 2025, month: 10, day: 5, hour: 2, minute: 15, second: 0 },
        'Australia/Lord_Howe',
      ).toISOString(),
    ).toBe('2025-10-04T15:45:00.000Z');
  });

  it('重复的时间（秋季回拨）取第一次出现', () => {
    // America/New_York 2025-11-02 01:30 出现两次：05:30Z(EDT) 与 06:30Z(EST)
    const first = localWallTimeToInstant(
      { year: 2025, month: 11, day: 2, hour: 1, minute: 30, second: 0 },
      'America/New_York',
    );

    expect(first.toISOString()).toBe('2025-11-02T05:30:00.000Z');
    expect(zonedDateTimeParts(first, 'America/New_York').hour).toBe(1);
  });
});

describe('zonedDayNumber：按计划时区折算日历日', () => {
  it('同一时刻在不同时区属于不同的日历日', () => {
    const instant = utc(2025, 6, 10, 23, 30);

    const utcDay = zonedDayNumber(instant, 'UTC');
    const shanghaiDay = zonedDayNumber(instant, 'Asia/Shanghai');

    expect(shanghaiDay - utcDay).toBe(1);
  });

  it('同一时区内相邻日历日相差 1', () => {
    const first = zonedDayNumber(utc(2025, 6, 10, 1), 'Asia/Shanghai');
    const second = zonedDayNumber(utc(2025, 6, 11, 1), 'Asia/Shanghai');

    expect(second - first).toBe(1);
  });
});

describe('buildDailyQueue：逾期天数按计划时区计算', () => {
  const now = utc(2025, 6, 10, 1);

  function makeState(wordId: string, dueAt: Date, weight: number): LearningState {
    const base = createInitialLearningState({
      userWordId: `uw-${wordId}`,
      deckId: 'deck-1',
      wordId,
      dueAt: dueAt.toISOString(),
    });
    return { ...base, lastReviewedAt: utc(2025, 6, 8).toISOString(), weight };
  }

  // UTC 下两者都逾期 1 天 → 权重高的在前；Asia/Shanghai 下前者逾期 0 天、后者 1 天 → 顺序翻转。
  const states = [
    makeState('w-heavy', utc(2025, 6, 9, 23), 4),
    makeState('w-light', utc(2025, 6, 9, 0, 30), 0.5),
  ];

  it('UTC 计划：同逾期天数时按权重降序', () => {
    const queue = buildDailyQueue(states, [], makePlan('UTC'), now, 'seed');

    expect(queue.reviewWordIds).toEqual(['w-heavy', 'w-light']);
  });

  it('Asia/Shanghai 计划：本地日历日差值改变优先级', () => {
    const queue = buildDailyQueue(states, [], makePlan('Asia/Shanghai'), now, 'seed');

    expect(queue.reviewWordIds).toEqual(['w-light', 'w-heavy']);
  });
});

describe('核心不依赖宿主机本地时区', () => {
  /** 一旦被调用就说明核心偷偷用了宿主机本地时区。 */
  const FORBIDDEN_LOCAL_GETTERS = [
    'getFullYear',
    'getMonth',
    'getDate',
    'getDay',
    'getHours',
    'getMinutes',
    'getSeconds',
    'getMilliseconds',
    'getTimezoneOffset',
  ] as const;

  /**
   * 临时把 `Date.prototype` 的本地取值方法替换为抛错版本，执行完再恢复。
   *
   * @param run 待执行的计算。
   * @returns 计算返回值。
   */
  function withLocalDateGettersDisabled<T>(run: () => T): T {
    const datePrototype = Date.prototype as unknown as Record<string, unknown>;
    const originals = new Map<string, unknown>();

    for (const getter of FORBIDDEN_LOCAL_GETTERS) {
      originals.set(getter, datePrototype[getter]);
      datePrototype[getter] = (): never => {
        throw new Error(`领域核心不应调用 Date.prototype.${getter}（宿主机时区依赖）`);
      };
    }

    try {
      return run();
    } finally {
      for (const [getter, original] of originals) {
        datePrototype[getter] = original;
      }
    }
  }

  it('禁用 Date 的全部本地取值方法后，到期时间与队列结果仍然正确', () => {
    const result = withLocalDateGettersDisabled(() => {
      const answeredAt = utc(2025, 6, 10, 22, 30);
      const next = nextLearningState(
        makeNewState(),
        makeAnswer(answeredAt),
        makePlan('Asia/Shanghai'),
        answeredAt,
      );
      const queue = buildDailyQueue(
        [
          {
            ...makeNewState(),
            wordId: 'w-due',
            dueAt: utc(2025, 6, 9, 0, 0).toISOString(),
            lastReviewedAt: utc(2025, 6, 8, 0, 0).toISOString(),
          },
        ],
        ['w-1', 'w-2'],
        makePlan('America/New_York'),
        utc(2025, 6, 10, 12),
        'seed',
      );
      return { dueAt: next.dueAt, newWordIds: queue.newWordIds, reviewWordIds: queue.reviewWordIds };
    });

    expect(result.dueAt).toBe('2025-06-12T01:00:00.000Z');
    expect(result.newWordIds).toEqual(['w-1', 'w-2']);
    expect(result.reviewWordIds).toEqual(['w-due']);
  });
});
