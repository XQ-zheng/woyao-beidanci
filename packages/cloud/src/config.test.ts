import { describe, expect, it } from 'vitest';

import { CloudConfigError, readCloudPublicConfig } from './config';

const fullEnv = {
  VITE_WB_CLOUD_RESOURCE_ID: 'wbcs_test',
  VITE_WB_CLOUD_ENDPOINT: 'https://example.workbuddy.host',
  VITE_WB_CLOUD_OAUTH_RELAY_BASE_URL: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  VITE_WB_CLOUD_PUBLISHABLE_KEY: 'wbpk_test',
};

describe('云公共配置', () => {
  it('四项齐全时返回配置', () => {
    expect(readCloudPublicConfig(fullEnv)).toEqual({
      resourceId: 'wbcs_test',
      endpoint: 'https://example.workbuddy.host',
      oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
      publishableKey: 'wbpk_test',
    });
  });

  it('四项全空时返回 null（未配置是合法状态）', () => {
    expect(readCloudPublicConfig({})).toBeNull();
  });

  it('只填了一半时抛错，避免带着半套配置启动', () => {
    expect(() =>
      readCloudPublicConfig({ VITE_WB_CLOUD_ENDPOINT: 'https://example.workbuddy.host' }),
    ).toThrow(CloudConfigError);
  });

  it('非 https endpoint 被拒绝', () => {
    expect(() =>
      readCloudPublicConfig({ ...fullEnv, VITE_WB_CLOUD_ENDPOINT: 'http://localhost:5173' }),
    ).toThrow(/https/);
  });
});
