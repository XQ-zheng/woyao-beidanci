import { describe, expect, it, vi } from 'vitest';

import { ServiceNotFoundError, ServiceValidationError, type Services } from '@woyao/services';

import { createIpcRouter } from './ipc';

/** 固定时钟：`now` 的断言不依赖真实时间。 */
const clock = { now: (): Date => new Date('2026-10-27T10:00:00.000Z') };

/**
 * 只实现 6B/6C 会用到的服务方法；其余服务整体抛错。
 *
 * @param overrides 用例自定义的方法。
 * @returns 假服务。
 */
function createFakeServices(overrides: Partial<Record<keyof Services, unknown>> = {}): Services {
  const unused = new Proxy(
    {},
    {
      get: (_target, property) => () => {
        throw new Error(`不应调用未实现的 ${String(property)}`);
      },
    },
  );

  return {
    settings: { getSnapshot: vi.fn(async () => ({ dailyNewLimit: 20 })) },
    library: { listDecks: vi.fn(async () => []) },
    study: {
      startSession: vi.fn(async () => ({ sessionId: 's-1', cards: [] })),
      submitAnswer: vi.fn(async () => ({ applied: true })),
      finishSession: vi.fn(async () => ({ sessionId: 's-1' })),
      suppressWord: vi.fn(async () => undefined),
      restoreWord: vi.fn(async () => undefined),
    },
    report: { getAssessment: vi.fn(async () => ({ score: 0 })) },
    content: { getPronunciation: vi.fn(async () => ({ url: null })) },
    auth: {
      requestOtp: vi.fn(async () => ({ challengeId: 'ch-1', isExistingUser: true })),
      verifyOtp: vi.fn(async () => ({
        userId: 'u-1',
        token: 'tok',
        refreshToken: 'refresh',
        expiresAt: null,
      })),
      getSession: vi.fn(async () => null),
      refresh: vi.fn(async () => ({
        userId: 'u-1',
        token: 'tok',
        refreshToken: 'refresh',
        expiresAt: null,
      })),
      signOut: vi.fn(async () => undefined),
    },
    sync: { synchronize: vi.fn(async () => ({ status: 'NOT_CONFIGURED' })) },
    online: unused,
    association: unused,
    export: unused,
    ...overrides,
  } as unknown as Services;
}

describe('IPC 路由：白名单与校验', () => {
  it('未知频道返回 UNKNOWN_CHANNEL，且不触碰任何服务', async () => {
    const services = createFakeServices();
    const router = createIpcRouter({ services, clock });

    const result = await router('library.deleteEverything', {});

    expect(result).toStrictEqual({
      ok: false,
      error: { code: 'UNKNOWN_CHANNEL', message: '未知的 IPC 频道：library.deleteEverything' },
    });
  });

  it('payload 不合法时返回 VALIDATION_FAILED，服务不被调用', async () => {
    const submitAnswer = vi.fn();
    const services = createFakeServices({ study: { submitAnswer } });
    const router = createIpcRouter({ services, clock });

    const result = await router('study.submitAnswer', {
      sessionId: 's-1',
      deckId: 'd-1',
      wordId: 'w-1',
      mode: 'MIXED', // 契约要求解析后的具体方向
      prompt: 'abandon',
      answer: '放弃',
      isCorrect: true,
      recognition: 'KNOWN',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_FAILED');
      expect(result.error.message).toContain('mode');
    }
    expect(submitAnswer).not.toHaveBeenCalled();
  });
});

describe('IPC 路由：时间由主进程给', () => {
  it('startSession 使用注入时钟，而不是渲染进程传来的时间', async () => {
    const startSession = vi.fn(async () => ({ sessionId: 's-1', cards: [] }));
    const router = createIpcRouter({ services: createFakeServices({ study: { startSession } }), clock });

    const result = await router('study.startSession', {
      deckId: 'deck-cet4',
      seed: 'seed-1',
      now: '1999-01-01T00:00:00.000Z',
    });

    expect(result.ok).toBe(true);
    expect(startSession).toHaveBeenCalledWith({
      deckId: 'deck-cet4',
      seed: 'seed-1',
      now: new Date('2026-10-27T10:00:00.000Z'),
    });
  });

  it('submitAnswer 用主进程时刻填 answeredAt', async () => {
    const submitAnswer = vi.fn(async () => ({ applied: true }));
    const router = createIpcRouter({ services: createFakeServices({ study: { submitAnswer } }), clock });

    const result = await router('study.submitAnswer', {
      sessionId: 's-1',
      deckId: 'deck-cet4',
      wordId: 'w-abandon',
      mode: 'EN_TO_ZH',
      prompt: 'abandon',
      answer: '放弃',
      isCorrect: true,
      recognition: 'UNKNOWN',
      durationMs: 1200,
    });

    expect(result.ok).toBe(true);
    expect(submitAnswer).toHaveBeenCalledWith(
      expect.objectContaining({
        answeredAt: new Date('2026-10-27T10:00:00.000Z'),
        recognition: 'UNKNOWN',
        isCorrect: true,
        durationMs: 1200,
      }),
    );
  });
});

describe('IPC 路由：两段式登录', () => {
  it('auth.requestOtp 走服务层，QQ 渠道被 schema 拒绝', async () => {
    const requestOtp = vi.fn(async () => ({ challengeId: 'ch-1', isExistingUser: true }));
    const services = createFakeServices({ auth: { requestOtp } });
    const router = createIpcRouter({ services, clock });

    const ok = await router('auth.requestOtp', { channel: 'phone', target: '13800138000' });
    expect(ok).toStrictEqual({ ok: true, data: { challengeId: 'ch-1', isExistingUser: true } });
    expect(requestOtp).toHaveBeenCalledWith({ channel: 'phone', target: '13800138000' });

    const rejected = await router('auth.requestOtp', { channel: 'qq', target: '12345' });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('VALIDATION_FAILED');
    }
    expect(requestOtp).toHaveBeenCalledTimes(1);
  });
});

describe('IPC 路由：错误折成结构体', () => {
  it('服务层 ServiceError 保留错误码（NOT_FOUND）', async () => {
    const services = createFakeServices({
      library: {
        listDecks: vi.fn(async () => {
          throw new ServiceNotFoundError('deck', 'deck-x');
        }),
      },
    });
    const router = createIpcRouter({ services, clock });

    const result = await router('library.listDecks', undefined);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NOT_FOUND');
    }
  });

  it('校验错误的错误码也是 VALIDATION_FAILED', async () => {
    const services = createFakeServices({
      settings: {
        saveReviewPlan: vi.fn(async () => {
          throw new ServiceValidationError([{ path: 'intervalsDays', message: '必须递增' }]);
        }),
      },
    });
    const router = createIpcRouter({ services, clock });

    const result = await router('settings.saveReviewPlan', {
      dailyNewLimit: 20,
      dailyReviewLimit: 100,
      intervalsDays: [4, 2],
      timeZone: 'Asia/Shanghai',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('非 ServiceError 归一成 INTERNAL，不泄露堆栈', async () => {
    const services = createFakeServices({
      sync: {
        synchronize: vi.fn(async () => {
          throw new Error('磁盘满');
        }),
      },
    });
    const router = createIpcRouter({ services, clock });

    const result = await router('sync.synchronize', undefined);

    expect(result).toStrictEqual({ ok: false, error: { code: 'INTERNAL', message: '磁盘满' } });
  });
});
