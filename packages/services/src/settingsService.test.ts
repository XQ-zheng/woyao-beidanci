import {
  DEFAULT_DAILY_NEW_LIMIT,
  DEFAULT_DAILY_REVIEW_LIMIT,
  DEFAULT_INTERVALS_DAYS,
} from '@woyao/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ServiceValidationError,
  type SettingsPatch,
  type SettingsSnapshot,
  createSettingsService,
  type SettingsService,
} from './index';
import { createServiceTestHarness, type ServiceTestHarness } from './testSupport';

/** 注入的缺省时区（服务层不探测系统时区）。 */
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

const harnesses: ServiceTestHarness[] = [];

afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.close();
  }
});

/** 建一个跑在真实内存库上的设置服务。 */
function makeService(timeZone = DEFAULT_TIME_ZONE): {
  harness: ServiceTestHarness;
  service: SettingsService;
} {
  const harness = createServiceTestHarness();
  harnesses.push(harness);
  const service = createSettingsService({ context: harness.context, defaultTimeZone: timeZone });
  return { harness, service };
}

/** 断言抛的是服务层校验错误，并返回它（便于继续断言 issues）。 */
async function expectValidationError(run: () => Promise<unknown>): Promise<ServiceValidationError> {
  try {
    await run();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ServiceValidationError);
    const validation = error as ServiceValidationError;
    expect(validation.code).toBe('VALIDATION_FAILED');
    expect(validation.issues.length).toBeGreaterThan(0);
    return validation;
  }
  throw new Error('期望抛出 ServiceValidationError，但调用成功了');
}

/** 合法计划（缺省值就是合法的，单独抽出来便于复用）。 */
function makePlan(overrides: Partial<SettingsSnapshot> = {}): {
  timeZone: string;
  intervalsDays: number[];
  dailyNewLimit: number;
  dailyReviewLimit: number;
} {
  return {
    timeZone: overrides.timeZone ?? DEFAULT_TIME_ZONE,
    intervalsDays: overrides.intervalsDays ?? [...DEFAULT_INTERVALS_DAYS],
    dailyNewLimit: overrides.dailyNewLimit ?? DEFAULT_DAILY_NEW_LIMIT,
    dailyReviewLimit: overrides.dailyReviewLimit ?? DEFAULT_DAILY_REVIEW_LIMIT,
  };
}

describe('settingsService：缺省快照', () => {
  it('空库返回需求规定的默认值（自启与最小化到托盘必须默认不勾选）', async () => {
    const { service } = makeService();

    const snapshot = await service.getSnapshot();

    expect(snapshot).toEqual({
      dailyNewLimit: 20,
      dailyReviewLimit: 100,
      intervalsDays: [...DEFAULT_INTERVALS_DAYS],
      timeZone: DEFAULT_TIME_ZONE,
      trainingMode: 'EN_TO_ZH',
      questionStyle: 'CHOICE',
        rotationOrder: 'SEQUENTIAL',
        wallpaper: '',
        fontFamily: 'system',
      accent: 'uk',
      volume: 1,
      fontScale: 1,
      autoStart: false,
      minimizeToTray: false,
    });
    // 这两条是需求点名的：默认勾选会替用户做决定（开机自启尤其敏感）。
    expect(snapshot.autoStart).toBe(false);
    expect(snapshot.minimizeToTray).toBe(false);
  });

  it('缺省时区由外壳注入，服务层不自己探测系统时区', async () => {
    const { service } = makeService('America/New_York');

    const snapshot = await service.getSnapshot();

    expect(snapshot.timeZone).toBe('America/New_York');
  });

  it('外壳传了非法缺省时区时，构造即失败（不留到第一次排期才炸）', () => {
    const harness = createServiceTestHarness();
    harnesses.push(harness);

    expect(() => createSettingsService({ context: harness.context, defaultTimeZone: 'UTC+8' })).toThrow(
      ServiceValidationError,
    );
  });
});

describe('settingsService：局部更新', () => {
  it('只写 patch 里出现的键，其余键保持缺省', async () => {
    const { harness, service } = makeService();

    const snapshot = await service.update({ dailyNewLimit: 30 });

    expect(snapshot.dailyNewLimit).toBe(30);
    expect(snapshot.dailyReviewLimit).toBe(DEFAULT_DAILY_REVIEW_LIMIT);
    // 存储层是按 key 存的 JSON：只应有这一个键被写。
    expect(harness.sync.settings.get('plan.dailyNewLimit')).toBe('30');
    expect(harness.sync.settings.get('plan.dailyReviewLimit')).toBeNull();
  });

  it('未知键必须报错（静默忽略会让用户以为设置保存成功）', async () => {
    const { service } = makeService();

    const error = await expectValidationError(() =>
      service.update({ nope: 1 } as unknown as SettingsPatch),
    );

    expect(error.issues[0]?.message).toContain('nope');
  });

  it('音量越界（> 1）被拒', async () => {
    const { service } = makeService();

    const error = await expectValidationError(() => service.update({ volume: 1.5 }));

    expect(error.issues.map((issue) => issue.path)).toContain('volume');
  });

  it('壁纸空串是合法值：设置后能读回，不会让启动失败', async () => {
    const { harness, service } = makeService();

    // 设一个壁纸再清空（空串 = 无壁纸），两次 update + getSnapshot 都必须成功。
    await service.update({ wallpaper: 'file:///E:/wp.png' });
    expect((await service.getSnapshot()).wallpaper).toBe('file:///E:/wp.png');

    await service.update({ wallpaper: '' });
    expect((await service.getSnapshot()).wallpaper).toBe('');
    expect(harness.sync.settings.get('ui.wallpaper')).toBe('""');
  });
});

describe('settingsService：复习计划的范围校验（唯一真相在 core）', () => {
  it('intervalsDays 的节点数量边界：1 个可以，12 个可以，13 个报错', async () => {
    const { service } = makeService();

    await expect(service.update({ intervalsDays: [7] })).resolves.toMatchObject({ intervalsDays: [7] });
    const twelve = Array.from({ length: 12 }, (_, index) => index + 1);
    await expect(service.update({ intervalsDays: twelve })).resolves.toMatchObject({ intervalsDays: twelve });

    const thirteen = Array.from({ length: 13 }, (_, index) => index + 1);
    const error = await expectValidationError(() => service.update({ intervalsDays: thirteen }));
    expect(error.issues.map((issue) => issue.path)).toContain('intervalsDays');
  });

  it('intervalsDays 的天数边界：1 与 365 可以，0 与 366 报错', async () => {
    const { service } = makeService();

    await expect(service.update({ intervalsDays: [1, 365] })).resolves.toMatchObject({
      intervalsDays: [1, 365],
    });
    await expectValidationError(() => service.update({ intervalsDays: [0] }));
    await expectValidationError(() => service.update({ intervalsDays: [366] }));
  });

  it('非法 patch 不落库：同一次 patch 里的合法字段也不能被写进去', async () => {
    const { harness, service } = makeService();
    await service.saveReviewPlan(makePlan());

    const before = {
      intervals: harness.sync.settings.get('plan.intervalsDays'),
      dailyNew: harness.sync.settings.get('plan.dailyNewLimit'),
      dailyReview: harness.sync.settings.get('plan.dailyReviewLimit'),
      timeZone: harness.sync.settings.get('plan.timeZone'),
    };

    // dailyNewLimit 本身合法，intervalsDays 越界 → 整条 patch 必须被拒，且一个键都不写。
    await expectValidationError(() =>
      service.update({ dailyNewLimit: 99, intervalsDays: Array.from({ length: 13 }, (_, i) => i + 1) }),
    );

    expect(harness.sync.settings.get('plan.intervalsDays')).toBe(before.intervals);
    expect(harness.sync.settings.get('plan.dailyNewLimit')).toBe(before.dailyNew);
    expect(harness.sync.settings.get('plan.dailyReviewLimit')).toBe(before.dailyReview);
    expect(harness.sync.settings.get('plan.timeZone')).toBe(before.timeZone);
    // 快照仍然是旧值。
    const snapshot = await service.getSnapshot();
    expect(snapshot.dailyNewLimit).toBe(DEFAULT_DAILY_NEW_LIMIT);
  });

  it('每日新词与复习数不能同时为 0（交叉约束，只有合并后的整体才判得出来）', async () => {
    const { service } = makeService();

    const error = await expectValidationError(() =>
      service.update({ dailyNewLimit: 0, dailyReviewLimit: 0 }),
    );

    expect(error.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['dailyNewLimit']),
    );
  });

  it('时区不是运行时认识的 IANA 标识时被拒（UTC+8 这类偏移写法）', async () => {
    const { service } = makeService();

    const error = await expectValidationError(() => service.update({ timeZone: 'UTC+8' }));

    expect(error.issues.map((issue) => issue.path)).toContain('timeZone');
  });
});

describe('settingsService：坏数据必须报错，不能静默回退默认值', () => {
  it('非法 JSON 抛错并指出是哪个键', async () => {
    const { harness, service } = makeService();
    harness.sync.settings.set(
      'plan.dailyNewLimit',
      '{not json',
      harness.deviceId,
      new Date(harness.nowIso),
    );

    const error = await expectValidationError(() => service.getSnapshot());

    expect(error.issues[0]?.path).toBe('plan.dailyNewLimit');
    expect(error.issues[0]?.message).toContain('JSON');
  });

  it('类型不符抛错（音量被写成字符串）', async () => {
    const { harness, service } = makeService();
    harness.sync.settings.set('ui.fontScale', '"big"', harness.deviceId, new Date(harness.nowIso));

    const error = await expectValidationError(() => service.getSnapshot());

    expect(error.issues.map((issue) => issue.path)).toContain('ui.fontScale');
  });
});

describe('settingsService：复习计划往返', () => {
  it('saveReviewPlan 后 loadReviewPlan 读回同一份计划', async () => {
    const { service } = makeService();

    const saved = await service.saveReviewPlan({
      timeZone: 'Europe/Berlin',
      intervalsDays: [2, 5, 10],
      dailyNewLimit: 15,
      dailyReviewLimit: 80,
    });
    const loaded = await service.loadReviewPlan();

    expect(saved).toEqual({
      timeZone: 'Europe/Berlin',
      intervalsDays: [2, 5, 10],
      dailyNewLimit: 15,
      dailyReviewLimit: 80,
    });
    expect(loaded).toEqual(saved);
    // 数组必须是副本：调用方改返回值不能污染已保存的计划。
    loaded.intervalsDays.push(30);
    expect((await service.loadReviewPlan()).intervalsDays).toEqual([2, 5, 10]);
  });

  it('saveReviewPlan 校验失败时一个键都不写', async () => {
    const { harness, service } = makeService();

    await expectValidationError(() =>
      service.saveReviewPlan({
        timeZone: DEFAULT_TIME_ZONE,
        intervalsDays: [],
        dailyNewLimit: 10,
        dailyReviewLimit: 10,
      }),
    );

    expect(harness.sync.settings.getAll()).toEqual({});
  });
});

describe('settingsService：学习时段', () => {
  it('跨午夜的时段被拒（必须由调用方拆成两条）', async () => {
    const { harness, service } = makeService();

    const error = await expectValidationError(() =>
      service.replaceStudyWindows([
        { effectiveLocalDate: '2025-03-01', startMinute: 22 * 60, endMinute: 2 * 60, timeZone: DEFAULT_TIME_ZONE },
      ]),
    );

    expect(error.issues[0]?.path).toBe('studyWindows[0].endMinute');
    // 一条都不该写进库。
    expect(harness.sync.settings.listPlanWindows()).toHaveLength(0);
  });

  it('保存后按生效日与起始分钟升序返回；全量替换后只剩新时段', async () => {
    const { service } = makeService();

    await service.replaceStudyWindows([
      { windowId: 'w-b', effectiveLocalDate: '2025-03-02', startMinute: 9 * 60, endMinute: 10 * 60, timeZone: DEFAULT_TIME_ZONE },
      { windowId: 'w-a', effectiveLocalDate: '2025-03-01', startMinute: 20 * 60, endMinute: 21 * 60, timeZone: DEFAULT_TIME_ZONE },
    ]);

    const first = await service.listStudyWindows();
    expect(first.map((window) => window.windowId)).toEqual(['w-a', 'w-b']);

    // 第二次只给一条：旧的两条必须被软删，而不是累加。
    await service.replaceStudyWindows([
      { effectiveLocalDate: '2025-03-05', startMinute: 7 * 60, endMinute: 8 * 60, timeZone: DEFAULT_TIME_ZONE },
    ]);

    const second = await service.listStudyWindows();
    expect(second).toHaveLength(1);
    expect(second[0]?.effectiveLocalDate).toBe('2025-03-05');
    // 没给 windowId 时由注入的 id 生成器补上，保证 id 可复现。
    expect(second[0]?.windowId).toBe('test-id-1');
  });

  it('重复的时段 id 被拒（否则“全量替换”会静默丢一条）', async () => {
    const { service } = makeService();

    const error = await expectValidationError(() =>
      service.replaceStudyWindows([
        { windowId: 'dup', effectiveLocalDate: '2025-03-01', startMinute: 60, endMinute: 120, timeZone: DEFAULT_TIME_ZONE },
        { windowId: 'dup', effectiveLocalDate: '2025-03-02', startMinute: 60, endMinute: 120, timeZone: DEFAULT_TIME_ZONE },
      ]),
    );

    expect(error.issues[0]?.path).toBe('studyWindows[1].windowId');
  });
});
