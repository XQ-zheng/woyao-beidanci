/**
 * 手机号 OTP 登录的兜底通道。
 *
 * 为什么需要它（2026-10-28 线上定位）：
 * SDK 的 `verifyOtp` 在「已注册用户」分支会 POST `/v1/signin`，body 是
 * `{ username: normalizePhone(phone), verification_token }`，而 `normalizePhone`
 * 会把大陆号码改写成 `"+86 137xxxxxxxx"`。实测服务端对这套参数返回
 * `401 invalid_grant — the session is invalid, expired or issued for another client`；
 * 换成裸号当 username 又会明确回 `404 User not exist.`——说明**手机号注册的账号
 * 根本没有 username 字段**，按 username 查必然查不到人。
 *
 * 验证码本身是好的：同一轮里 `/v1/verification/verify` 返回 200 并签发了
 * `verification_token`。所以这里自己接管这两步：验码换 token，再用
 * **手机号字段**（phone_number / phone / 裸号 username，逐个试）换会话。
 *
 * 取舍：这是对官方 SDK 的兜底，不是替代——`isExistingUser === false`（新注册）
 * 仍然走 SDK 原路径，那条路径已被验证可用。等 SDK 修好后删掉本文件即可。
 */
import type { CloudAuthStorage, CloudSession } from '@tencent-ai/workbuddy-cloud-sdk';

/** Auth 数据面的固定前缀（与 SDK 的 `CLOUD_MODULE_PATHS.auth` 一致）。 */
const AUTH_PATH_PREFIX = '/.cloud/auth';
/** SDK 的会话存储键前缀（`SessionStore` 内部常量）；读不到就只影响“下次免登录”。 */
const SESSION_STORAGE_PREFIX = 'workbuddy-cloud.session.';

/** 构造参数。 */
export interface PhoneOtpSignInOptions {
  /** 数据面基址（应用发布域名）。 */
  readonly endpoint: string;
  /** 半公开 key，作为 `x-wb-webapp-access-key` 发送。 */
  readonly publishableKey: string;
  /** 可注入 fetch（追踪/测试）。 */
  readonly fetch?: typeof globalThis.fetch;
  /** 逐次尝试的追踪回调（写脱敏日志）。 */
  readonly trace?: (line: string) => void;
}

/** 登录入参。 */
export interface PhoneOtpSignInInput {
  /** 11 位大陆手机号（未加前缀的原始值）。 */
  readonly phone: string;
  /** 发码返回的 challenge id。 */
  readonly verificationId: string;
  /** 用户输入的验证码（已归一化）。 */
  readonly code: string;
}

/** 成功结果。 */
export interface PhoneOtpSignInResult {
  /** 云端会话。 */
  readonly session: CloudSession;
  /** 命中的字段写法，便于日志与后续收敛。 */
  readonly variant: string;
}

/** 一次 HTTP 往返的结果。 */
interface HttpOutcome {
  readonly status: number;
  readonly body: Record<string, unknown>;
  /** 服务端给的可读原因。 */
  readonly reason: string | null;
}

/**
 * 把手机号归一成「裸 11 位」：去掉 +86 / 0086 / 非数字字符。
 *
 * @param phone 原始手机号。
 * @returns 裸号码。
 */
export function toBarePhone(phone: string): string {
  const digits = phone.replace(/\D+/gu, '');
  if (digits.startsWith('0086')) {
    return digits.slice(4);
  }
  if (digits.startsWith('86') && digits.length === 13) {
    return digits.slice(2);
  }
  return digits;
}

/**
 * POST 一个 JSON 并解析响应；网络异常也折成统一结构，便于逐档尝试。
 *
 * @param options 传输配置。
 * @param path 相对路径（以 `/` 开头）。
 * @param body 请求体。
 * @returns 状态码、解析后的 body 与可读原因。
 */
async function postJson(
  options: PhoneOtpSignInOptions,
  path: string,
  body: Record<string, unknown>,
): Promise<HttpOutcome> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  try {
    const response = await fetchImpl(`${options.endpoint}${AUTH_PATH_PREFIX}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-wb-webapp-access-key': options.publishableKey,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>);
    } catch {
      parsed = {};
    }
    const reason =
      typeof parsed.error_description === 'string'
        ? parsed.error_description
        : typeof parsed.error === 'string'
          ? parsed.error
          : null;
    return { status: response.status, body: parsed, reason };
  } catch (error) {
    return {
      status: 0,
      body: {},
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 把 `/v1/signin`、`/v1/signup` 的成功响应解析成 `CloudSession`。
 *
 * @param body 响应体。
 * @param receivedAt 收到响应的时刻（毫秒）。
 * @returns 会话；缺少 access_token 时返回 null。
 */
export function parsePhoneSession(
  body: Record<string, unknown>,
  receivedAt: number,
): CloudSession | null {
  const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
  if (accessToken === '') {
    return null;
  }
  const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : '';
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 0;
  const name = typeof body.name === 'string' ? body.name : undefined;
  const avatarUrl = typeof body.avatar_url === 'string' ? body.avatar_url : undefined;
  return {
    accessToken,
    refreshToken,
    expiresAt: receivedAt + expiresIn * 1000,
    user: {
      id: typeof body.sub === 'string' ? body.sub : '',
      name,
      avatarUrl,
      isAnonymous: body.is_anonymous === true,
      raw: body,
    },
  };
}

/**
 * 把会话写进 SDK 的存储键，让后续 `getSession()` / 续期能直接复用。
 *
 * 键名与结构来自 SDK 的 `SessionStore`（`workbuddy-cloud.session.<publishableKey>`）。
 * SDK 升级改了格式时会读失败并自行清掉，最坏结果只是要重新登录一次。
 *
 * @param storage 凭据存储（桌面端是加密文件）。
 * @param publishableKey 半公开 key（参与拼键）。
 * @param session 会话。
 */
export function persistPhoneSession(
  storage: CloudAuthStorage | undefined,
  publishableKey: string,
  session: CloudSession,
): void {
  if (storage === undefined) {
    return;
  }
  try {
    storage.setItem(`${SESSION_STORAGE_PREFIX}${publishableKey}`, JSON.stringify(session));
  } catch {
    // 存不进去只影响“下次免登录”，不影响本次登录结果。
  }
}

/**
 * 用手机号验证码完成登录（已注册用户）。
 *
 * @param options 传输配置（endpoint / key / fetch / trace）。
 * @param input 手机号、challenge id 与验证码。
 * @returns 会话与命中的字段写法。
 * @throws {Error} 验码被拒或所有登录写法都被拒时抛出，附服务端原文。
 */
export async function signInWithPhoneOtp(
  options: PhoneOtpSignInOptions,
  input: PhoneOtpSignInInput,
): Promise<PhoneOtpSignInResult> {
  const phone = toBarePhone(input.phone);
  const trace = options.trace ?? ((): void => undefined);

  const verified = await postJson(options, '/v1/verification/verify', {
    verification_id: input.verificationId,
    verification_code: input.code,
  });
  trace(`verify ${String(verified.status)}${verified.reason === null ? '' : ` ${verified.reason}`}`);
  if (verified.status < 200 || verified.status >= 300) {
    throw new Error(verified.reason ?? `验证码校验失败（HTTP ${String(verified.status)}）`);
  }
  const verificationToken =
    typeof verified.body.verification_token === 'string' ? verified.body.verification_token : '';
  if (verificationToken === '') {
    throw new Error('验码通过但服务端没有返回 verification_token');
  }

  // 逐档尝试：手机号账号没有 username，优先用 phone_number / phone。
  const variants: ReadonlyArray<{ readonly label: string; readonly body: Record<string, string> }> = [
    { label: 'phone_number', body: { phone_number: phone, verification_token: verificationToken } },
    { label: 'phone', body: { phone, verification_token: verificationToken } },
    {
      label: 'phone_number(+86)',
      body: { phone_number: `+86 ${phone}`, verification_token: verificationToken },
    },
    { label: 'username(bare)', body: { username: phone, verification_token: verificationToken } },
    { label: 'username(+86)', body: { username: `+86 ${phone}`, verification_token: verificationToken } },
  ];

  let lastReason = '';
  for (const variant of variants) {
    const attempt = await postJson(options, '/v1/signin', variant.body);
    trace(`signin[${variant.label}] ${String(attempt.status)}${attempt.reason === null ? '' : ` ${attempt.reason}`}`);
    if (attempt.status >= 200 && attempt.status < 300) {
      const session = parsePhoneSession(attempt.body, Date.now());
      if (session !== null) {
        return { session, variant: variant.label };
      }
    }
    lastReason = attempt.reason ?? `HTTP ${String(attempt.status)}`;
  }

  // 兜底注册：万一账号在半步失败的中间态，注册能把它补完整。
  const signup = await postJson(options, '/v1/signup', {
    verification_token: verificationToken,
    phone_number: phone,
  });
  trace(`signup ${String(signup.status)}${signup.reason === null ? '' : ` ${signup.reason}`}`);
  if (signup.status >= 200 && signup.status < 300) {
    const session = parsePhoneSession(signup.body, Date.now());
    if (session !== null) {
      return { session, variant: 'signup' };
    }
  }

  throw new Error(
    `手机号登录被服务端拒绝（最后一次原因：${signup.reason ?? (lastReason === '' ? '未知' : lastReason)}）`,
  );
}
