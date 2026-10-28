import { afterEach, describe, expect, it } from 'vitest';

import {
  NotConfiguredError,
  createAuthService,
  type AuthGateway,
  type AuthService,
  type AuthSession,
} from './index';
import { createServiceTestHarness, type ServiceTestHarness } from './testSupport';

const harnesses: ServiceTestHarness[] = [];

afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.close();
  }
});

const SESSION: AuthSession = {
  userId: 'u-1',
  token: 'tok',
  refreshToken: 'refresh',
  expiresAt: null,
};

/** 装配认证服务；`auth` 缺省为 `null`（已配置但无网关）。 */
function makeAuth(auth: AuthGateway | null = null): {
  harness: ServiceTestHarness;
  service: AuthService;
} {
  const harness = createServiceTestHarness({
    cloud: { configured: true, auth, sync: null },
  });
  harnesses.push(harness);
  return { harness, service: createAuthService({ context: harness.context }) };
}

describe('authService', () => {
  it('发码 → 验码 → 取会话 → 续期 → 退出，全部纯委托给网关', async () => {
    const calls: string[] = [];
    const gateway: AuthGateway = {
      requestOtp: async (input) => {
        calls.push(`request:${input.channel}:${input.target}`);
        return { challengeId: 'ch-1', isExistingUser: true };
      },
      verifyOtp: async (input) => {
        calls.push(`verify:${input.channel}:${input.challengeId}:${input.token}`);
        return SESSION;
      },
      getSession: async () => {
        calls.push('getSession');
        return SESSION;
      },
      refresh: async (session) => {
        calls.push(`refresh:${session.userId}`);
        return { ...SESSION, token: 'tok-2' };
      },
      signOut: async (session) => {
        calls.push(`signOut:${session.userId}`);
      },
    };
    const { service } = makeAuth(gateway);

    const challenge = await service.requestOtp({ channel: 'phone', target: '13800138000' });
    expect(challenge).toStrictEqual({ challengeId: 'ch-1', isExistingUser: true });

    const signedIn = await service.verifyOtp({
      channel: 'phone',
      target: '13800138000',
      challengeId: challenge.challengeId,
      isExistingUser: challenge.isExistingUser,
      token: '123456',
    });
    expect(signedIn).toEqual(SESSION);

    await expect(service.getSession()).resolves.toEqual(SESSION);
    const refreshed = await service.refresh(SESSION);
    expect(refreshed.token).toBe('tok-2');
    await service.signOut(SESSION);

    expect(calls).toEqual([
      'request:phone:13800138000',
      'verify:phone:ch-1:123456',
      'getSession',
      'refresh:u-1',
      'signOut:u-1',
    ]);
  });

  it('cloud 未配置（createNoopCloud）→ 所有方法抛 NotConfiguredError，绝不伪造会话', async () => {
    const harness = createServiceTestHarness(); // 缺省 cloud = createNoopCloud()
    harnesses.push(harness);
    const service = createAuthService({ context: harness.context });

    await expect(service.requestOtp({ channel: 'email', target: 'a@b.c' })).rejects.toBeInstanceOf(
      NotConfiguredError,
    );
    await expect(
      service.verifyOtp({
        channel: 'email',
        target: 'a@b.c',
        challengeId: 'ch-1',
        isExistingUser: false,
        token: '123456',
      }),
    ).rejects.toBeInstanceOf(NotConfiguredError);
    await expect(service.getSession()).rejects.toBeInstanceOf(NotConfiguredError);
    await expect(service.refresh(SESSION)).rejects.toBeInstanceOf(NotConfiguredError);
    await expect(service.signOut(SESSION)).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it('cloud 已配置但 auth 网关为 null → NotConfiguredError', async () => {
    const { service } = makeAuth(null);

    await expect(service.requestOtp({ channel: 'phone', target: '13800138000' })).rejects.toBeInstanceOf(
      NotConfiguredError,
    );
  });
});
