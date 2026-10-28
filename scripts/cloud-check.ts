/**
 * WorkBuddy Cloud 连通性检查（不含任何密钥输出）。
 *
 * 读取仓库根的 `.env.local`（被 git 忽略），用官方 SDK 初始化客户端，
 * 先列模型，再发一条最小流式请求。Origin 不匹配会如实报错，不伪造成功。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk';

/** 极简 .env 解析（只支持 KEY=VALUE 与 # 注释）。 */
function loadEnv(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * 取必填公开配置。
 *
 * @param env 环境变量。
 * @param key 键名。
 * @returns 值。
 */
function requireValue(env: Record<string, string>, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(`缺少公开配置 ${key}`);
  }
  return value;
}

const env = loadEnv(path.resolve('.env.local'));
const endpoint = requireValue(env, 'VITE_WB_CLOUD_ENDPOINT');
const publishableKey = requireValue(env, 'VITE_WB_CLOUD_PUBLISHABLE_KEY');
const oauthRelayBaseUrl = requireValue(env, 'VITE_WB_CLOUD_OAUTH_RELAY_BASE_URL');

const cloud = createWorkBuddyCloud({ endpoint, publishableKey, oauthRelayBaseUrl });

const sessionResult = await cloud.auth.getSession();
if (sessionResult.error !== null) {
  throw new Error(`Auth 数据面不可用：${sessionResult.error.message}`);
}
console.log(JSON.stringify({ authReachable: true, signedIn: sessionResult.data !== null }, null, 2));

const models = await cloud.llm.models.list();
const usable = models.filter((model) => model.enabled !== false && model.disabled !== true);
console.log(
  JSON.stringify(
    {
      models: models.length,
      usable: usable.length,
      sample: usable.slice(0, 3).map((model) => model.id),
    },
    null,
    2,
  ),
);
if (usable.length === 0) {
  throw new Error('模型目录为空，无法继续');
}

let reply = '';
let usage: { total_tokens?: number } | undefined;
let finishReason: string | null = null;
for await (const chunk of cloud.llm.chat.completions.create({
  model: 'deepseek-v4.1-flash',
  messages: [
    { role: 'system', content: '你是一个只回复极短文本的连通性检查助手。' },
    { role: 'user', content: '只回复四个字：连通正常' },
  ],
  stream: true,
  stream_options: { include_usage: true },
  temperature: 0,
})) {
  const choice = chunk.choices[0];
  if (choice?.delta?.content) {
    reply += choice.delta.content;
  }
  if (choice?.finish_reason) {
    finishReason = choice.finish_reason;
  }
  if (chunk.usage) {
    usage = { total_tokens: chunk.usage.total_tokens };
  }
}

console.log(
  JSON.stringify(
    {
      reply: reply.slice(0, 40),
      finishReason,
      totalTokens: usage?.total_tokens ?? null,
    },
    null,
    2,
  ),
);
