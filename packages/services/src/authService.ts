/**
 * 认证服务：纯委托 `cloud.auth`。
 *
 * 三条不能破的边界：
 * 1. **服务层不碰 token 存储**：`AuthSession` 只是透传值。桌面端 keytar / 系统钥匙链、
 *    移动端 SecureStore 都是 Task 7/10 的事，这里绝不落地、绝不缓存。
 * 2. **绝不伪造登录成功**：`cloud` 未配置 → `NotConfiguredError('auth')`，不会返回一个假的
 *    `AuthSession` 让 UI 以为登录上了。
 * 3. 签名原样委托，不加“本地已登录”之类的额外状态。
 */

import { NotConfiguredError } from './errors';
import type { AuthSession, ServiceContext, SignInInput } from './ports';

/** 认证服务契约。 */
export interface AuthService {
  signIn(input: SignInInput): Promise<AuthSession>;
  refresh(session: AuthSession): Promise<AuthSession>;
  signOut(session: AuthSession): Promise<void>;
}

/** 构造参数。 */
export interface AuthServiceOptions {
  readonly context: ServiceContext;
}

/**
 * 创建认证服务。
 *
 * @param options 上下文。
 * @returns 认证服务实例。
 */
export function createAuthService(options: AuthServiceOptions): AuthService {
  const { context } = options;

  /** 取认证网关；未配置时抛 `NotConfiguredError`（不是返回假会话）。 */
  function requireAuth(): NonNullable<ServiceContext['cloud']['auth']> {
    if (!context.cloud.configured || context.cloud.auth === null) {
      throw new NotConfiguredError('auth', '云认证未配置（WorkBuddy Cloud 未激活）');
    }
    return context.cloud.auth;
  }

  return {
    async signIn(input: SignInInput): Promise<AuthSession> {
      return requireAuth().signIn(input);
    },

    async refresh(session: AuthSession): Promise<AuthSession> {
      return requireAuth().refresh(session);
    },

    async signOut(session: AuthSession): Promise<void> {
      await requireAuth().signOut(session);
    },
  };
}
