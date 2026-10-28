/** WorkBuddy Cloud 公共配置（只包含可公开下发的字段）。 */

/** 公共配置。 */
export interface CloudPublicConfig {
  readonly resourceId: string;
  readonly endpoint: string;
  readonly oauthRelayBaseUrl: string;
  readonly publishableKey: string;
}

/** 配置缺失/非法。 */
export class CloudConfigError extends Error {
  /**
   * @param message 说明。
   */
  constructor(message: string) {
    super(message);
    this.name = 'CloudConfigError';
  }
}

/** 环境变量名（与 `.env.local` 完全一致）。 */
export const CLOUD_ENV_KEYS = {
  resourceId: 'VITE_WB_CLOUD_RESOURCE_ID',
  endpoint: 'VITE_WB_CLOUD_ENDPOINT',
  oauthRelayBaseUrl: 'VITE_WB_CLOUD_OAUTH_RELAY_BASE_URL',
  publishableKey: 'VITE_WB_CLOUD_PUBLISHABLE_KEY',
} as const;

/**
 * 从环境读取公共配置。
 *
 * 三种结果：
 * - 四个键全空 → `null`（云未配置，页面如实显示未开通）；
 * - 部分为空 → 抛 `CloudConfigError`（配置写了一半比没写更危险）；
 * - 齐全 → 返回配置。
 *
 * @param env 环境变量（Vite 的 `import.meta.env`、Electron 的 `.env.local` 解析结果都可）。
 * @returns 配置或 `null`。
 */
export function readCloudPublicConfig(
  env: Readonly<Record<string, string | undefined>>,
): CloudPublicConfig | null {
  const values = {
    resourceId: env[CLOUD_ENV_KEYS.resourceId]?.trim() ?? '',
    endpoint: env[CLOUD_ENV_KEYS.endpoint]?.trim() ?? '',
    oauthRelayBaseUrl: env[CLOUD_ENV_KEYS.oauthRelayBaseUrl]?.trim() ?? '',
    publishableKey: env[CLOUD_ENV_KEYS.publishableKey]?.trim() ?? '',
  };
  const present = Object.values(values).filter((value) => value.length > 0);
  if (present.length === 0) {
    return null;
  }
  const missing = Object.entries(values)
    .filter(([, value]) => value.length === 0)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new CloudConfigError(`云公共配置不完整，缺少：${missing.join(', ')}`);
  }
  if (!values.endpoint.startsWith('https://')) {
    throw new CloudConfigError('云 endpoint 必须是 https 地址');
  }
  return values;
}
