/** 桌面端云端装配：读取公共配置 + 加密凭据存储 + 认证网关。 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { createCloudLlm, createWorkBuddyAuthGateway, readCloudPublicConfig, type CloudPublicConfig } from '@woyao/cloud';
import { createNoopCloud, type CloudPort, type LlmPort } from '@woyao/services';

import { EncryptedAuthStorage } from './secureStore';

/** 极简 .env 解析（只支持 KEY=VALUE 与 # 注释）。 */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
}

/**
 * 读取公共配置。
 *
 * 顺序：进程环境变量 → 打包资源 `resources/cloud-config.json` → 开发态仓库 `.env.local`。
 * 都不存在时返回 null，云登录显示“未配置”，不猜测 endpoint。
 *
 * @param userDataPath 应用数据目录。
 * @returns 公共配置或 null。
 */
export function loadCloudConfig(userDataPath: string): CloudPublicConfig | null {
  const fromProcess = readCloudPublicConfig(process.env);
  if (fromProcess !== null) {
    return fromProcess;
  }

  const candidates = [
    path.join(process.resourcesPath ?? '', 'cloud-config.json'),
    path.join(userDataPath, 'cloud-config.json'),
    path.join(__dirname, '../../../../.env.local'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      const text = readFileSync(candidate, 'utf8');
      if (candidate.endsWith('.json')) {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        return readCloudPublicConfig({
          VITE_WB_CLOUD_RESOURCE_ID: String(parsed.resourceId ?? ''),
          VITE_WB_CLOUD_ENDPOINT: String(parsed.endpoint ?? ''),
          VITE_WB_CLOUD_OAUTH_RELAY_BASE_URL: String(parsed.oauthRelayBaseUrl ?? ''),
          VITE_WB_CLOUD_PUBLISHABLE_KEY: String(parsed.publishableKey ?? ''),
        });
      }
      return readCloudPublicConfig(parseEnvFile(text));
    } catch (error) {
      console.warn('[woyao] 云公共配置读取失败：', error instanceof Error ? error.message : error);
      return null;
    }
  }
  return null;
}

/**
 * 创建云端端口。
 *
 * 未配置或安全存储不可用时返回 `createNoopCloud()`，账号页会如实显示未配置，
 * **不会伪造登录成功**。
 *
 * @param userDataPath 应用数据目录。
 * @returns 云端端口。
 */
export function createDesktopCloud(userDataPath: string): CloudPort {
  const config = loadCloudConfig(userDataPath);
  if (config === null) {
    return createNoopCloud();
  }
  try {
    const storage = new EncryptedAuthStorage(path.join(userDataPath, 'cloud-auth.bin'));
    const auth = createWorkBuddyAuthGateway({
      config,
      storage,
      fetch: createAuthTraceFetch(path.join(userDataPath, 'logs', 'auth-http.log')),
    });
    // 同步网关仍未实现（云端表结构与 RLS 未设计），这里明确保留 null。
    return { configured: true, auth, sync: null };
  } catch (error) {
    console.warn('[woyao] 云认证初始化失败：', error instanceof Error ? error.message : error);
    return createNoopCloud();
  }
}

/**
 * 创建云端 LLM 端口（翻译 + 导入释义生成）。
 *
 * 云未激活时返回 undefined：服务层据此如实走降级（导入时跳过 AI 补释义），
 * 而不是注入一个假装能用的实现。
 *
 * @param userDataPath 应用数据目录（读云公共配置用）。
 * @returns LLM 端口；云未配置时 undefined。
 */
export function createDesktopLlm(userDataPath: string): LlmPort | undefined {
  const config = loadCloudConfig(userDataPath);
  if (config === null) {
    return undefined;
  }
  try {
    return createCloudLlm({ config });
  } catch (error) {
    console.warn('[woyao] 云 LLM 初始化失败：', error instanceof Error ? error.message : error);
    return undefined;
  }
}

/** 认证追踪日志上限：超过就清空重写，避免长期运行把磁盘写满。 */
const AUTH_TRACE_LIMIT_BYTES = 256 * 1024;

/**
 * 脱敏：手机号只留前 3 后 4，JWT 只留长度，纯数字验证码替换为占位符。
 *
 * 追踪日志的价值在于“哪一步失败、服务端怎么说的”，不需要把凭据留在磁盘上。
 *
 * @param text 原始文本。
 * @returns 脱敏后的文本。
 */
export function redactAuthTrace(text: string): string {
  return text
    .replace(/\b1\d{10}\b/gu, (phone) => `${phone.slice(0, 3)}****${phone.slice(-4)}`)
    .replace(/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}\b/gu, (token) => `<jwt:${String(token.length)}>`)
    .replace(/"\d{4,8}"/gu, '"<digits>"');
}

/**
 * 包一层 fetch，把认证 HTTP 往返写进 `logs/auth-http.log`（NDJSON，脱敏）。
 *
 * 为什么需要它：打包版没有终端，用户能给的只有界面上的半句话；而
 * “云端拒绝建立会话”这类故障必须看到具体端点、状态码与服务端原始报文才能定位。
 *
 * @param logPath 日志文件绝对路径。
 * @returns 可注入 SDK 的 fetch。
 */
export function createAuthTraceFetch(logPath: string): typeof globalThis.fetch {
  return async (input, init) => {
    const startedAt = Date.now();
    const response = await globalThis.fetch(input, init);
    try {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const requestPath = url.replace(/^https?:\/\/[^/]+/u, '');
      const requestBody = typeof init?.body === 'string' ? redactAuthTrace(init.body) : null;
      const body = await response.clone().text();
      const line = `${JSON.stringify({
        at: new Date().toISOString(),
        path: requestPath,
        status: response.status,
        ms: Date.now() - startedAt,
        // 请求体也记，但同样脱敏：登录兜底会尝试多种字段写法，必须能看出是哪种生效。
        req: requestBody,
        body: redactAuthTrace(body).slice(0, 600),
      })}\n`;
      mkdirSync(path.dirname(logPath), { recursive: true });
      if (existsSync(logPath) && statSync(logPath).size > AUTH_TRACE_LIMIT_BYTES) {
        writeFileSync(logPath, line, 'utf8');
      } else {
        appendFileSync(logPath, line, 'utf8');
      }
    } catch {
      // 追踪本身失败绝不能影响登录。
    }
    return response;
  };
}
