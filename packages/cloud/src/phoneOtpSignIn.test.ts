import { describe, expect, it, vi } from 'vitest';

import {
  parsePhoneSession,
  persistPhoneSession,
  signInWithPhoneOtp,
  toBarePhone,
  type PhoneOtpSignInOptions,
} from './phoneOtpSignIn';

/** 构造一次 JSON 响应。 */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 记录调用并按顺序返回预设响应的假 fetch。 */
function sequenceFetch(responses: Response[]): {
  fetch: typeof globalThis.fetch;
  calls: { url: string; body: unknown }[];
} {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    const next = responses.shift();
    if (next === undefined) {
      throw new Error('假 fetch 没有更多响应');
    }
    return next;
  });
  return { fetch: fetchImpl as unknown as typeof globalThis.fetch, calls };
}

const SESSION_BODY = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_in: 3600,
  sub: 'user-1',
  name: '测试用户',
};

/** 基础配置。 */
function options(fetchImpl: typeof globalThis.fetch): PhoneOtpSignInOptions {
  return {
    endpoint: 'https://example.test',
    publishableKey: 'wbpk_test',
    fetch: fetchImpl,
  };
}

describe('toBarePhone', () => {
  it('把 +86 / 0086 / 分隔符都归一成裸 11 位', () => {
    expect(toBarePhone('13790758356')).toBe('13790758356');
    expect(toBarePhone('+86 13790758356')).toBe('13790758356');
    expect(toBarePhone('0086-137-9075-8356')).toBe('13790758356');
    expect(toBarePhone('+8613790758356')).toBe('13790758356');
  });
});

describe('parsePhoneSession', () => {
  it('缺少 access_token 时返回 null', () => {
    expect(parsePhoneSession({ refresh_token: 'r' }, Date.now())).toBeNull();
  });

  it('按 expires_in 换算过期时间并带出用户信息', () => {
    const session = parsePhoneSession(SESSION_BODY, 1000);
    expect(session).not.toBeNull();
    expect(session?.accessToken).toBe('access-token');
    expect(session?.expiresAt).toBe(1000 + 3600 * 1000);
    expect(session?.user.id).toBe('user-1');
  });
});

describe('signInWithPhoneOtp：已注册手机号登录', () => {
  it('用 phone_number 字段登录成功，并先完成验码换 token', async () => {
    const { fetch, calls } = sequenceFetch([
      json(200, { verification_token: 'vt-1', expires_in: 600 }),
      json(200, SESSION_BODY),
    ]);

    const result = await signInWithPhoneOtp(options(fetch), {
      phone: '+86 13790758356',
      verificationId: 'ch-1',
      code: '123456',
    });

    expect(result.variant).toBe('phone_number');
    expect(result.session.accessToken).toBe('access-token');
    expect(calls[0]?.url).toBe('https://example.test/.cloud/auth/v1/verification/verify');
    expect(calls[0]?.body).toEqual({ verification_id: 'ch-1', verification_code: '123456' });
    expect(calls[1]?.url).toBe('https://example.test/.cloud/auth/v1/signin');
    expect(calls[1]?.body).toEqual({ phone_number: '+86 13790758356', verification_token: 'vt-1' });
  });

  it('phone_number 被拒时按序换下一个字段写法', async () => {
    const { fetch, calls } = sequenceFetch([
      json(200, { verification_token: 'vt-1' }),
      json(401, { error: 'invalid_grant', error_description: 'the session is invalid' }),
      json(200, SESSION_BODY),
    ]);

    const result = await signInWithPhoneOtp(options(fetch), {
      phone: '13790758356',
      verificationId: 'ch-1',
      code: '123456',
    });

    expect(result.variant).toBe('phone');
    expect(calls).toHaveLength(3);
    expect(calls[2]?.body).toEqual({ phone: '+86 13790758356', verification_token: 'vt-1' });
  });

  it('所有登录写法都被拒时用注册补完整并返回 signup', async () => {
    const { fetch, calls } = sequenceFetch([
      json(200, { verification_token: 'vt-1' }),
      json(401, { error: 'invalid_grant' }),
      json(404, { error: 'not_found' }),
      json(400, { error: 'invalid_argument' }),
      json(200, SESSION_BODY),
    ]);

    const result = await signInWithPhoneOtp(options(fetch), {
      phone: '13790758356',
      verificationId: 'ch-1',
      code: '123456',
    });

    expect(result.variant).toBe('signup');
    expect(calls.at(-1)?.url).toBe('https://example.test/.cloud/auth/v1/signup');
    expect(calls.at(-1)?.body).toEqual({ verification_token: 'vt-1', phone_number: '+86 13790758356' });
  });

  it('验码被拒时抛出服务端原因，不再尝试登录', async () => {
    const { fetch, calls } = sequenceFetch([
      json(400, { error: 'invalid_argument', error_description: 'verification code does not match the id' }),
    ]);

    await expect(
      signInWithPhoneOtp(options(fetch), {
        phone: '13790758356',
        verificationId: 'ch-1',
        code: '000000',
      }),
    ).rejects.toThrow(/verification code does not match the id/u);
    expect(calls).toHaveLength(1);
  });

  it('全部失败时抛出的错误带上最后一次服务端原因', async () => {
    const { fetch } = sequenceFetch([
      json(200, { verification_token: 'vt-1' }),
      json(401, { error: 'invalid_grant', error_description: 'the session is invalid' }),
      json(401, { error: 'invalid_grant', error_description: 'the session is invalid' }),
      json(401, { error: 'invalid_grant', error_description: 'the session is invalid' }),
      json(403, { error: 'forbidden', error_description: 'signup disabled' }),
    ]);

    await expect(
      signInWithPhoneOtp(options(fetch), {
        phone: '13790758356',
        verificationId: 'ch-1',
        code: '123456',
      }),
    ).rejects.toThrow(/signup disabled/u);
  });
});

describe('persistPhoneSession', () => {
  it('写进 SDK 的会话键，getSession 才能复用', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };

    persistPhoneSession(storage, 'wbpk_test', {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 123,
      user: { id: 'u', isAnonymous: false, raw: {} },
    });

    const raw = store.get('workbuddy-cloud.session.wbpk_test');
    expect(raw).toBeDefined();
    expect(JSON.parse(String(raw))).toMatchObject({ accessToken: 'a', refreshToken: 'r', expiresAt: 123 });
  });

  it('存储抛错时不影响登录结果', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('disk full');
      },
      removeItem: () => undefined,
    };

    expect(() =>
      persistPhoneSession(storage, 'wbpk_test', {
        accessToken: 'a',
        refreshToken: 'r',
        expiresAt: 1,
        user: { id: 'u', isAnonymous: false, raw: {} },
      }),
    ).not.toThrow();
  });
});
