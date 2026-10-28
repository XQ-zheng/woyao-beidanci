/** 桌面端云端装配：读取公共配置 + 加密凭据存储 + 认证网关。 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { createWorkBuddyAuthGateway, readCloudPublicConfig, type CloudPublicConfig } from '@woyao/cloud';
import { createNoopCloud, type CloudPort } from '@woyao/services';

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
    const auth = createWorkBuddyAuthGateway({ config, storage });
    // 同步网关仍未实现（云端表结构与 RLS 未设计），这里明确保留 null。
    return { configured: true, auth, sync: null };
  } catch (error) {
    console.warn('[woyao] 云认证初始化失败：', error instanceof Error ? error.message : error);
    return createNoopCloud();
  }
}
