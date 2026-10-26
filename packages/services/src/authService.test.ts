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
  it('signIn/refresh/signOut 纯委托假网关', async () => {
    const calls: string[] = [];
    const gateway: AuthGateway = {
      signIn: async (input) => {
        calls.push(`signIn:${input.provider}:${input.credential}`);
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

    const signedIn = await service.signIn({ provider: 'email', credential: 'a@b.c' });
    expect(signedIn).toEqual(SESSION);

    const refreshed = await service.refresh(SESSION);
    expect(refreshed.token).toBe('tok-2');

    await service.signOut(SESSION);

    expect(calls).toEqual(['signIn:email:a@b.c', 'refresh:u-1', 'signOut:u-1']);
  });

  it('cloud 未配置（createNoopCloud）→ 三个方法都抛 NotConfiguredError，绝不伪造会话', async () => {
    const harness = createServiceTestHarness(); // 缺省 cloud = createNoopCloud()
    harnesses.push(harness);
    const service = createAuthService({ context: harness.context });

    await expect(service.signIn({ provider: 'email', credential: 'a@b.c' })).rejects.toBeInstanceOf(
      NotConfiguredError,
    );
    await expect(service.refresh(SESSION)).rejects.toBeInstanceOf(NotConfiguredError);
    await expect(service.signOut(SESSION)).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it('cloud 已配置但 auth 网关为 null → NotConfiguredError', async () => {
    const { service } = makeAuth(null);

    await expect(service.signIn({ provider: 'wechat', credential: 'code' })).rejects.toBeInstanceOf(
      NotConfiguredError,
    );
  });
});
