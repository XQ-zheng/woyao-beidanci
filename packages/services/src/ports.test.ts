import type { LearningState } from '@woyao/core';
import { RepositoryInvariantError, type LearningEventRecord } from '@woyao/data';
import { afterEach, describe, expect, it } from 'vitest';

import { asyncifyRepositories } from './ports';
import { createServiceTestHarness, type ServiceTestHarness } from './testSupport';

/** 四个仓储名字，遍历时用（顺序固定，失败信息才可读）。 */
const REPOSITORY_NAMES = ['words', 'learning', 'sync', 'settings'] as const;

/** 一份自洽的作答事件。 */
function makeEvent(overrides: Partial<LearningEventRecord> = {}): LearningEventRecord {
  return {
    eventId: 'evt-1',
    userWordId: 'deck-1:w-1',
    sessionId: null,
    mode: 'EN_TO_ZH',
    prompt: 'abandon（v. 放弃）',
    answer: '放弃',
    isCorrect: true,
    recognition: 'KNOWN',
    stageBefore: -1,
    stageAfter: 0,
    dueAt: null,
    answeredAt: '2025-03-01T08:00:00.000Z',
    localDate: '2025-03-01',
    timeZone: 'Asia/Shanghai',
    durationMs: null,
    deviceId: 'test-device',
    syncedAt: null,
    ...overrides,
  };
}

/** 一份合法的学习状态。 */
function makeState(overrides: Partial<LearningState> = {}): LearningState {
  return {
    userWordId: 'deck-1:w-1',
    deckId: 'deck-1',
    wordId: 'w-1',
    stage: -1,
    dueAt: '2025-03-01T01:00:00.000Z',
    lastReviewedAt: null,
    correctCount: 0,
    wrongCount: 0,
    streakCorrect: 0,
    weight: 1,
    suppressedAt: null,
    ...overrides,
  };
}

const harnesses: ServiceTestHarness[] = [];

afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.close();
  }
});

describe('asyncifyRepositories：包装是透明的', () => {
  it('四个仓储的方法一个不丢，且全部变成返回 Promise 的异步方法', async () => {
    const harness = createServiceTestHarness();
    harnesses.push(harness);

    for (const name of REPOSITORY_NAMES) {
      const syncRepo = harness.sync[name] as unknown as Record<string, unknown>;
      const asyncRepo = harness.context.repos[name] as unknown as Record<string, unknown>;

      // 方法名集合必须完全一致：少一个方法说明包装时漏了键，
      // 多一个方法说明 package 的接口已经漂移，两种都该在这里炸。
      expect(Object.keys(asyncRepo).sort()).toEqual(Object.keys(syncRepo).sort());

      for (const [methodName, method] of Object.entries(asyncRepo)) {
        expect(typeof method, `${name}.${methodName} 应该是函数`).toBe('function');
        const invocation = (method as (...args: unknown[]) => unknown)();
        // 关键断言：**同步方法被包成 async 后，异常不能再同步抛出**。
        // 否则 IPC 层的 try/catch 抓不到，只会变成 unhandled rejection。
        expect(invocation, `${name}.${methodName} 应返回 Promise`).toBeInstanceOf(Promise);
        // settle 掉，避免未处理的 rejection 影响其它用例。
        await Promise.resolve(invocation).then(
          () => undefined,
          () => undefined,
        );
      }
    }
  });

  it('包装后异常原样冒泡：仍是同一个 RepositoryInvariantError（instanceof + code）', async () => {
    const harness = createServiceTestHarness();
    harnesses.push(harness);

    // 事件记在 w-1 上、状态却是 w-2：数据层会抛 RepositoryInvariantError。
    const event = makeEvent({ eventId: 'evt-mismatch' });
    const state = makeState({ userWordId: 'deck-1:w-2', wordId: 'w-2' });

    const promise = harness.context.repos.learning.appendEventAndUpdateState(event, state);

    // 先确认“同步不抛、异步才抛”。
    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).rejects.toBeInstanceOf(RepositoryInvariantError);
    await expect(promise).rejects.toMatchObject({
      code: 'REPOSITORY_INVARIANT_VIOLATION',
      invariant: 'event.userWordId === state.userWordId',
    });
    // 一行都不该落地：异常路径不写事件、不写状态。
    const eventRows = harness.db.prepare('SELECT COUNT(*) AS total FROM learning_events').get() as {
      total: number;
    };
    expect(eventRows.total).toBe(0);
  });

  it('asyncifyRepositories 只转发：包装层不吞值、不改类型', async () => {
    const harness = createServiceTestHarness();
    harnesses.push(harness);

    const original = harness.sync.settings;
    const asyncSettings = asyncifyRepositories(harness.sync).settings;

    await asyncSettings.set('ui.fontScale', JSON.stringify(1.25), 'test-device', new Date('2025-03-01T08:00:00.000Z'));
    const readBack = await asyncSettings.get('ui.fontScale');

    expect(readBack).toBe('1.25');
    // 包装不复制底层状态：写进去的值用**原始同步仓储**也能读到。
    expect(original.get('ui.fontScale')).toBe('1.25');
  });
});
