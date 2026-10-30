/**
 * WorkBuddy Cloud LLM 端口实现。
 *
 * 用官方 SDK 的 `llm.chat.completions` 提供两类能力：
 * - `translate`：文本翻译（在线服务的 AI 翻译降级路径）；
 * - `defineWord`：为导入的英文单词/短语生成词典义项（内置词典查不到时的补全来源）。
 *
 * 模型用 `deepseek-v4.1-flash`（`npm run cloud:check` 验证过连通；快、成本低）。
 * defineWord 要求模型输出严格 JSON，解析失败按「AI 未给出释义」抛错，由调用方跳过。
 */
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk';
import type { LlmDistractorWord, LlmPort, LlmWordSense } from '@woyao/services';

import { CloudConfigError, type CloudPublicConfig } from './config';

/** 释义生成的默认模型（`npm run cloud:check` 已验证可用）。 */
const DEFINE_MODEL = 'deepseek-v4.1-flash';

/** 构造参数。 */
export interface CloudLlmOptions {
  readonly config: CloudPublicConfig;
  /** 覆盖默认模型（测试用）。 */
  readonly model?: string;
}

/** 从模型回复里抠出 JSON 数组（容忍 ```json 围栏）。 */
function parseSenseArray(text: string): LlmWordSense[] {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/```\s*$/u, '');
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('AI 返回内容里没有找到释义 JSON');
  }
  const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
  if (!Array.isArray(parsed)) {
    throw new Error('AI 返回的释义不是数组');
  }
  const senses: LlmWordSense[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') {
      continue;
    }
    const record = item as { pos?: unknown; simpleZh?: unknown; detailedZh?: unknown };
    const simpleZh = typeof record.simpleZh === 'string' ? record.simpleZh.trim() : '';
    if (simpleZh === '') {
      continue;
    }
    senses.push({
      pos: typeof record.pos === 'string' ? record.pos.trim() : '',
      simpleZh,
      detailedZh: typeof record.detailedZh === 'string' && record.detailedZh.trim() !== '' ? record.detailedZh : null,
    });
    if (senses.length >= 3) {
      break;
    }
  }
  if (senses.length === 0) {
    throw new Error('AI 返回的释义为空');
  }
  return senses;
}

/** 从模型回复里抠出相近干扰词数组（容忍 ```json 围栏，解析容错与 parseSenseArray 同一口径）。 */
function parseDistractorArray(text: string, targetLemma: string): LlmDistractorWord[] {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/```\s*$/u, '');
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('AI 返回内容里没有找到干扰词 JSON');
  }
  const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
  if (!Array.isArray(parsed)) {
    throw new Error('AI 返回的干扰词不是数组');
  }
  const targetKey = targetLemma.trim().toLowerCase();
  const words: LlmDistractorWord[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') {
      continue;
    }
    const record = item as { lemma?: unknown; meaningZh?: unknown; meanings?: unknown };
    const lemma = typeof record.lemma === 'string' ? record.lemma.trim() : '';
    // 新格式给 meanings 数组（多义项）；旧格式只有 meaningZh 单条 —— 两种都收。
    const rawMeanings = Array.isArray(record.meanings)
      ? record.meanings.filter((entry): entry is string => typeof entry === 'string')
      : [];
    // 最多保留 4 条：用户要求干扰项显示「这个词的全部常用义项」，
    // 原来的 3 条会把第 4 个义项（常是“比喻/引申义”）截掉，选项看起来就不完整。
    const meanings = rawMeanings.map((entry) => entry.trim()).filter((entry) => entry !== '').slice(0, 4);
    const meaningZh =
      meanings.length > 0
        ? meanings.join('；')
        : typeof record.meaningZh === 'string'
          ? record.meaningZh.trim()
          : '';
    if (lemma === '' || meaningZh === '') {
      continue;
    }
    // 防御：模型偶尔会把目标词自己塞回来——它绝不能出现在干扰项里。
    if (lemma.toLowerCase() === targetKey) {
      continue;
    }
    words.push(meanings.length > 0 ? { lemma, meaningZh, meanings } : { lemma, meaningZh });
  }
  if (words.length === 0) {
    throw new Error('AI 返回的干扰词为空');
  }
  return words;
}

/**
 * 创建云端 LLM 端口。
 *
 * @param options 云公共配置与可选模型覆盖。
 * @returns LLM 端口。
 * @throws {CloudConfigError} 配置缺失（endpoint/publishableKey）。
 */
export function createCloudLlm(options: CloudLlmOptions): LlmPort {
  const { config } = options;
  if (config.endpoint.trim() === '' || config.publishableKey.trim() === '') {
    throw new CloudConfigError('LLM 端口缺少 endpoint/publishableKey');
  }
  const model = options.model ?? DEFINE_MODEL;
  const cloud = createWorkBuddyCloud({
    endpoint: config.endpoint,
    publishableKey: config.publishableKey,
    oauthRelayBaseUrl: config.oauthRelayBaseUrl,
  });

  /** 非流式调用一次 chat，返回首条回复文本；429 限流按服务端提示退避重试。 */
  async function chat(system: string, user: string): Promise<string> {
    let reply = '';
    for await (const chunk of cloud.llm.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      stream: true,
    })) {
      const delta = chunk.choices[0]?.delta?.content;
      if (typeof delta === 'string') {
        reply += delta;
      }
    }
    if (reply.trim() === '') {
      throw new Error('AI 返回了空回复');
    }
    return reply;
  }

  /** 带限流退避的 chat：最多重试 2 次（间隔 3s / 8s）。 */
  async function chatWithRetry(system: string, user: string): Promise<string> {
    const delays = [3000, 8000];
    let lastError: unknown;
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, delays[attempt - 1]));
      }
      try {
        return await chat(system, user);
      } catch (error: unknown) {
        lastError = error;
        const code = (error as { code?: unknown }).code;
        if (code !== 'quota_rate_limited' && (error as { status?: unknown }).status !== 429) {
          throw error;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  return {
    async translate(input: { text: string; target: 'zh' | 'en' }): Promise<string> {
      const targetLang = input.target === 'zh' ? '简体中文' : 'English';
      return chatWithRetry(
        '你是翻译助手。只输出译文本身，不要任何解释、引号或额外文字。',
        `把下面的文本翻译成${targetLang}：\n${input.text}`,
      );
    },

    async defineWord(input: { lemma: string; phrase: boolean }): Promise<readonly LlmWordSense[]> {
      const kind = input.phrase ? '英语短语' : '英语单词';
      const reply = await chatWithRetry(
        [
          '你是权威英语词典的编写者。对给定的英语词条，输出 1-3 个最常用的义项。',
          '只输出 JSON 数组，不要任何其他文字或代码围栏，数组元素形如：',
          '{"pos":"词性缩写（如 n. / v. / adj. / phr.）","simpleZh":"简明中文释义（短语）","detailedZh":"补充说明或例句（没有就填空字符串）"}',
        ].join('\n'),
        `${kind}：${input.lemma}`,
      );
      return parseSenseArray(reply);
    },

    async generateDistractorWords(input: {
      lemma: string;
      count: number;
    }): Promise<readonly LlmDistractorWord[]> {
      const count = Number.isInteger(input.count) && input.count > 0 ? input.count : 3;
      const reply = await chatWithRetry(
        [
          '你是出题助手。给定的一个英语单词，列出与它拼写相近、读音相近或容易混淆的英语单词。',
          `只输出 JSON 数组，不要任何其他文字或代码围栏，恰好 ${String(count)} 个元素，每个元素形如：`,
          '{"lemma":"相近的英文单词（小写）","meanings":["义项1","义项2","义项3","义项4"]}',
          // 用户明确要求干扰项显示「该词的所有意思」：只要模型多给义项，选项文本就更像
          // 一个真实的释义条目，而不是一个孤零零的短词；上限 4 条是为了不让单个选项长到
          // 撑破按钮（再多义项在选项里也读不过来）。
          'meanings 给出该词的**全部常用义项**（最多 4 条，按常用度排序；只有一个意思就只给一条，用简短名词或动宾短语）。',
          '数组里绝不能包含目标单词本身。',
        ].join('\n'),
        `目标单词：${input.lemma}`,
      );
      return parseDistractorArray(reply, input.lemma);
    },
  };
}
