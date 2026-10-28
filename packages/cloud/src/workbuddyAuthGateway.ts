/**
 * WorkBuddy Cloud 认证网关。
 *
 * 只封装 SDK 的真实能力：手机/邮箱 OTP 与网页 OAuth。**没有 QQ Provider**。
 * 会话映射只暴露 `AuthSession`（userId/token/refreshToken/expiresAt），
 * 不把 SDK 的完整 user 对象泄漏到服务层。
 */
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk';
import type {
  AuthModule,
  CloudAuthStorage,
  CloudResult,
  CloudSession,
  OtpChallenge,
  VerifyOtpParams,
} from '@tencent-ai/workbuddy-cloud-sdk';
import type { AuthGateway, AuthSession, OtpChallengeView } from '@woyao/services';

import { CloudConfigError, type CloudPublicConfig } from './config';

/** 只依赖实际用到的 Auth 方法，便于单测注入假实现。 */
export type WorkBuddyAuthLike = Pick<
  AuthModule,
  'sendOtp' | 'verifyOtp' | 'getSession' | 'refreshSession' | 'signOut'
>;

/** 网关构造参数。 */
export interface WorkBuddyAuthGatewayOptions {
  readonly config: CloudPublicConfig;
  /** 凭据存储；Node/Electron 主进程必须显式传，浏览器可用 SDK 默认。 */
  readonly storage?: CloudAuthStorage;
  /** 测试注入；缺省用真实 SDK。 */
  readonly auth?: WorkBuddyAuthLike;
}

/** 云端认证失败（保留 SDK 的错误码，UI 可据此提示）。 */
export class CloudAuthError extends Error {
  readonly code: string | null;

  /**
   * @param message 面向用户的说明。
   * @param code SDK 稳定错误码。
   */
  constructor(message: string, code: string | null) {
    super(message);
    this.name = 'CloudAuthError';
    this.code = code;
  }
}

/** 把 SDK 的 `{data,error}` 结果解包，失败时抛可读错误。 */
function unwrap<T>(result: CloudResult<T>, action: string): T {
  if (result.error !== null) {
    throw new CloudAuthError(`${action}失败：${result.error.message}`, result.error.code ?? null);
  }
  return result.data as T;
}

/**
 * 把 SDK 会话映射成服务层 `AuthSession`。
 *
 * @param session SDK 会话。
 * @returns 服务层会话。
 */
export function toAuthSession(session: CloudSession): AuthSession {
  const expiresAt = Number.isFinite(session.expiresAt)
    ? new Date(session.expiresAt).toISOString()
    : null;
  return {
    userId: session.user.id,
    token: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt,
  };
}

/**
 * 创建真实认证网关。
 *
 * @param options 公共配置、存储与可选假 Auth。
 * @returns `AuthGateway`。
 */
export function createWorkBuddyAuthGateway(options: WorkBuddyAuthGatewayOptions): AuthGateway {
  const { config } = options;
  if (config.endpoint.trim() === '' || config.publishableKey.trim() === '') {
    throw new CloudConfigError('认证网关缺少 endpoint/publishableKey');
  }
  const auth: WorkBuddyAuthLike =
    options.auth ??
    createWorkBuddyCloud({
      endpoint: config.endpoint,
      oauthRelayBaseUrl: config.oauthRelayBaseUrl,
      publishableKey: config.publishableKey,
      ...(options.storage === undefined ? {} : { storage: options.storage }),
    }).auth;

  return {
    async requestOtp(input): Promise<OtpChallengeView> {
      const credentials =
        input.channel === 'phone' ? { phone: input.target } : { email: input.target };
      const challenge = unwrap<OtpChallenge>(await auth.sendOtp(credentials), '发送验证码');
      return {
        challengeId: challenge.verificationId,
        isExistingUser: challenge.isExistingUser,
      };
    },

    async verifyOtp(input): Promise<AuthSession> {
      const params: VerifyOtpParams & { isExistingUser: boolean } =
        input.channel === 'phone'
          ? {
              verificationId: input.challengeId,
              token: input.token,
              phone: input.target,
              isExistingUser: input.isExistingUser,
            }
          : {
              verificationId: input.challengeId,
              token: input.token,
              email: input.target,
              isExistingUser: input.isExistingUser,
            };
      const session = unwrap<CloudSession>(await auth.verifyOtp(params), '验证码校验');
      return toAuthSession(session);
    },

    async getSession(): Promise<AuthSession | null> {
      const session = unwrap<CloudSession | null>(await auth.getSession(), '读取登录状态');
      return session === null ? null : toAuthSession(session);
    },

    async refresh(): Promise<AuthSession> {
      const session = unwrap<CloudSession | null>(await auth.refreshSession(), '刷新登录状态');
      if (session === null) {
        throw new CloudAuthError('登录已失效，请重新登录', 'unauthenticated');
      }
      return toAuthSession(session);
    },

    async signOut(session): Promise<void> {
      void session;
      unwrap<null>(await auth.signOut(), '退出登录');
    },
  };
}
