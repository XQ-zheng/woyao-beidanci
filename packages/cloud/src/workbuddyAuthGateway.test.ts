import { describe, expect, it, vi } from 'vitest';
import type { CloudSession } from '@tencent-ai/workbuddy-cloud-sdk';

import type { CloudPublicConfig } from './config';
import {
  CloudAuthError,
  createWorkBuddyAuthGateway,
  toAuthSession,
  type WorkBuddyAuthLike,
} from './workbuddyAuthGateway';

const config: CloudPublicConfig = {
  resourceId: 'wbcs_test',
  endpoint: 'https://example.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_test',
};

const session: CloudSession = {
  accessToken: 'access-1',
  refreshToken: 'wbrt_1',
  expiresAt: 1760000000000,
  user: {
    id: 'u-1',
    phone: '13800138000',
    isAnonymous: false,
  },
};

/** 构造假 Auth；每个方法的返回值按用例覆盖。 */
function fakeAuth(overrides: Partial<WorkBuddyAuthLike> = {}): WorkBuddyAuthLike {
  return {
    sendOtp: vi.fn(async () => ({
      data: { verificationId: 'ch-1', isExistingUser: true },
      error: null,
    })),
    verifyOtp: vi.fn(async () => ({ data: session, error: null })),
    getSession: vi.fn(async () => ({ data: session, error: null })),
    refreshSession: vi.fn(async () => ({
      data: { ...session, accessToken: 'access-2' },
      error: null,
    })),
    signOut: vi.fn(async () => ({ data: null, error: null })),
    ...overrides,
  } as unknown as WorkBuddyAuthLike;
}

describe('WorkBuddy 认证网关', () => {
  it('手机发码走 phone，邮箱发码走 email', async () => {
    const auth = fakeAuth();
    const gateway = createWorkBuddyAuthGateway({ config, auth });

    await expect(gateway.requestOtp({ channel: 'phone', target: '13800138000' })).resolves.toStrictEqual({
      challengeId: 'ch-1',
      isExistingUser: true,
    });
    await gateway.requestOtp({ channel: 'email', target: 'a@b.c' });

    expect(auth.sendOtp).toHaveBeenNthCalledWith(1, { phone: '13800138000' });
    expect(auth.sendOtp).toHaveBeenNthCalledWith(2, { email: 'a@b.c' });
  });

  it('验码带上同一标识与 challengeId，并把会话映射成 AuthSession', async () => {
    const auth = fakeAuth();
    const gateway = createWorkBuddyAuthGateway({ config, auth });

    const result = await gateway.verifyOtp({
      channel: 'phone',
      target: '13800138000',
      challengeId: 'ch-1',
      isExistingUser: true,
      token: '123456',
    });

    expect(auth.verifyOtp).toHaveBeenCalledWith({
      verificationId: 'ch-1',
      token: '123456',
      phone: '13800138000',
      isExistingUser: true,
    });
    expect(result).toStrictEqual({
      userId: 'u-1',
      token: 'access-1',
      refreshToken: 'wbrt_1',
      expiresAt: new Date(1760000000000).toISOString(),
    });
  });

  it('邮箱验码只传 email，不同时传 phone/email', async () => {
    const auth = fakeAuth();
    const gateway = createWorkBuddyAuthGateway({ config, auth });

    await gateway.verifyOtp({
      channel: 'email',
      target: 'a@b.c',
      challengeId: 'ch-2',
      isExistingUser: false,
      token: '654321',
    });

    expect(auth.verifyOtp).toHaveBeenCalledWith({
      verificationId: 'ch-2',
      token: '654321',
      email: 'a@b.c',
      isExistingUser: false,
    });
  });

  it('未登录时 getSession 返回 null；刷新后会话更新；退出调用 SDK', async () => {
    const auth = fakeAuth({
      getSession: vi.fn(async () => ({ data: null, error: null })),
    } as unknown as Partial<WorkBuddyAuthLike>);
    const gateway = createWorkBuddyAuthGateway({ config, auth });

    await expect(gateway.getSession()).resolves.toBeNull();
    const refreshed = await gateway.refresh(toAuthSession(session));
    expect(refreshed.token).toBe('access-2');
    await gateway.signOut(refreshed);
    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });

  it('SDK 错误转成 CloudAuthError 并保留 code', async () => {
    const auth = fakeAuth({
      sendOtp: vi.fn(async () => ({
        data: null,
        error: { kind: 'rate-limited', message: '请求过于频繁', status: 429, code: 'quota_rate_limited' },
      })),
    } as unknown as Partial<WorkBuddyAuthLike>);
    const gateway = createWorkBuddyAuthGateway({ config, auth });

    await expect(gateway.requestOtp({ channel: 'phone', target: '13800138000' })).rejects.toMatchObject({
      name: 'CloudAuthError',
      code: 'quota_rate_limited',
    });
    await expect(
      gateway.requestOtp({ channel: 'phone', target: '13800138000' }),
    ).rejects.toBeInstanceOf(CloudAuthError);
  });
});
