/**
 * 在线内容服务：词典（dictionaryapi.dev）、AI 翻译、在线图词联想。
 *
 * 两条硬规则（每条都有测试锁定）：
 * 1. **防御式解析**：dictionaryapi.dev 的响应形状用 zod 锁定（非 strict——上游常加新字段），
 *    404 / 畸形 JSON / 字段缺失 → `null`，**不抛错、不编造义项**。上游一旦变样，
 *    这里只会“查不到”，绝不会把一个半残响应当成可用义项塞给用户。
 * 2. **隐私红线**：任何请求只发用户主动查的那一个词（`lemma`），headers 不带 token、
 *    学习历史、整本词库。AI 翻译结果只返回文本，**不写进词典义项**。
 *
 * 降级语义：
 * - `lookupDictionary` / `lookupAssociations` 在离线或请求失败时返回 `null`/`[]`
 *   （由上层走 `source='NONE'` / 只返回本地）；不把网络异常当成功，也不让它炸掉整条链路。
 * - `translate` 没有自然的“空值”可降级，`llm` 未配置抛 `NotConfiguredError('llm')`，
 *   请求失败抛 `ProviderError('llm')`。
 */

import { z } from 'zod';

import type { AssociationKind } from '@woyao/data';

import {
  dictionaryLookupInputSchema,
  onlineAssociationsInputSchema,
  parseOrThrow,
  translateInputSchema,
} from './dto';
import { NotConfiguredError, ProviderError } from './errors';
import type { ServiceContext } from './ports';

/** 一条词典义项（`definitionZh` 是“给用户看的目标语言释义”字段名）。 */
export interface DictionaryEntry {
  readonly lemma: string;
  readonly phoneticUk: string | null;
  readonly phoneticUs: string | null;
  readonly audioUrlUk: string | null;
  readonly audioUrlUs: string | null;
  readonly senses: { readonly pos: string; readonly definitionZh: string }[];
}

/** 一条在线联想提示。 */
export interface AssociationHint {
  readonly kind: AssociationKind;
  readonly text: string;
  readonly originUrl: string | null;
}

/** 在线服务契约。 */
export interface OnlineService {
  lookupDictionary(input: { lemma: string }): Promise<DictionaryEntry | null>;
  translate(input: { text: string; target: 'zh' | 'en' }): Promise<string>;
  lookupAssociations(input: { lemma: string; kind: AssociationKind }): Promise<AssociationHint[]>;
}

/** 构造参数。 */
export interface OnlineServiceOptions {
  readonly context: ServiceContext;
  /**
   * 在线联想 provider 的 base URL；**缺省 = 未配置** → `lookupAssociations` 恒返回 `[]`。
   * 词典 provider（dictionaryapi.dev）是内置默认，无需配置。
   */
  readonly associationProviderUrl?: string;
}

/** dictionaryapi.dev 的基础地址（发音/释义的唯一在线词典 provider，V1.0 内置）。 */
const DICTIONARYAPI_BASE_URL = 'https://api.dictionaryapi.dev/api/v2/entries/en/';

/**
 * dictionaryapi.dev 的响应形状。
 *
 * 用 `z.object`（非 strict）：该 API 会不断新增 `license` / `sourceUrls` / `synonyms` 等字段，
 * strict 会把这些**合法**响应也判成畸形。真正要锁的是“我们需要的字段”的类型：
 * 缺 `word`、`meanings` 不是数组、`definition` 不是字符串 → parse 失败 → `null`。
 */
const dictionaryPhoneticSchema = z.object({
  text: z.string().optional(),
  audio: z.string().optional(),
});
const dictionaryDefinitionSchema = z.object({
  definition: z.string(),
});
const dictionaryMeaningSchema = z.object({
  partOfSpeech: z.string(),
  definitions: z.array(dictionaryDefinitionSchema).optional().default([]),
});
const dictionaryApiEntrySchema = z.object({
  word: z.string(),
  phonetic: z.string().optional(),
  phonetics: z.array(dictionaryPhoneticSchema).optional().default([]),
  meanings: z.array(dictionaryMeaningSchema).optional().default([]),
});
const dictionaryApiResponseSchema = z.array(dictionaryApiEntrySchema);

/** 在线联想 provider 的响应形状：`kind` 来自请求，返回 `{ text, originUrl }` 数组。 */
const associationResponseSchema = z.array(
  z.object({
    text: z.string().min(1),
    originUrl: z.string().nullish(),
  }),
);

/** 取数组里前两个**互不相同**的非空字符串，不足补 null（用于 UK/US 槽位）。 */
function firstTwoDistinct(values: readonly string[]): [string | null, string | null] {
  const seen: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const text = value.trim();
    if (text === '' || seen.includes(text)) {
      continue;
    }
    seen.push(text);
  }
  return [seen[0] ?? null, seen[1] ?? null];
}

/** 把 provider 返回的 entries 映射成 `DictionaryEntry`。 */
function toDictionaryEntry(entry: z.infer<typeof dictionaryApiEntrySchema>): DictionaryEntry {
  const phoneticTexts = entry.phonetics
    .map((phonetic) => phonetic.text)
    .filter((text): text is string => typeof text === 'string');
  // dictionaryapi.dev 多数只有一份音标；只有一份时 UK/US 共用一个槽，别硬造第二个。
  const phoneticSources =
    phoneticTexts.length > 0 ? phoneticTexts : entry.phonetic !== undefined ? [entry.phonetic] : [];
  const [phoneticUk, phoneticUs] = firstTwoDistinct(phoneticSources);

  const audioUrls = entry.phonetics
    .map((phonetic) => phonetic.audio)
    .filter((audio): audio is string => typeof audio === 'string');
  const [audioUrlUk, audioUrlUs] = firstTwoDistinct(audioUrls);

  const senses = entry.meanings.flatMap((meaning) =>
    meaning.definitions.map((definition) => ({
      pos: meaning.partOfSpeech,
      definitionZh: definition.definition,
    })),
  );

  return {
    lemma: entry.word,
    phoneticUk,
    phoneticUs,
    audioUrlUk,
    audioUrlUs,
    senses,
  };
}

/** 把任意异常压成一行可读文本（用于 `ProviderError` 的 message，不泄露调用栈）。 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * 创建在线内容服务。
 *
 * @param options 上下文与可选的在线联想 provider 地址。
 * @returns 在线服务实例。
 */
export function createOnlineService(options: OnlineServiceOptions): OnlineService {
  const { context } = options;
  const associationProviderUrl = options.associationProviderUrl;

  return {
    async lookupDictionary(input: { lemma: string }): Promise<DictionaryEntry | null> {
      const { lemma } = parseOrThrow(dictionaryLookupInputSchema, input, '在线查词典');
      if (!context.network.isOnline()) {
        return null;
      }
      const url = `${DICTIONARYAPI_BASE_URL}${encodeURIComponent(lemma)}`;
      let status: number;
      let data: unknown;
      try {
        const response = await context.http.getJson({ url });
        status = response.status;
        data = response.data;
      } catch {
        // 网络层异常：降级为“查不到”，不抛错、不把异常当成功。
        return null;
      }
      // 404 与其它非 2xx 都是“没有这个条目”，不抛错。
      if (status < 200 || status >= 300) {
        return null;
      }
      const parsed = dictionaryApiResponseSchema.safeParse(data);
      if (!parsed.success || parsed.data[0] === undefined) {
        return null;
      }
      return toDictionaryEntry(parsed.data[0]);
    },

    async translate(input: { text: string; target: 'zh' | 'en' }): Promise<string> {
      const { text, target } = parseOrThrow(translateInputSchema, input, '翻译');
      if (context.llm === undefined) {
        throw new NotConfiguredError('llm', '未配置 AI 翻译能力');
      }
      try {
        return await context.llm.translate({ text, target });
      } catch (error: unknown) {
        // 已配置但调用失败：翻译没有“空值”可降级，只能用 ProviderError 显式报告。
        throw new ProviderError('llm', `AI 翻译请求失败：${describeError(error)}`);
      }
    },

    async lookupAssociations(input: {
      lemma: string;
      kind: AssociationKind;
    }): Promise<AssociationHint[]> {
      const { lemma, kind } = parseOrThrow(onlineAssociationsInputSchema, input, '在线查联想');
      // 未配置 provider → 空数组（不是报错），上层 `enrichOnline` 会只返回本地。
      if (associationProviderUrl === undefined) {
        return [];
      }
      if (!context.network.isOnline()) {
        return [];
      }
      const url = `${associationProviderUrl}?word=${encodeURIComponent(lemma)}&kind=${encodeURIComponent(kind)}`;
      try {
        const response = await context.http.getJson({ url });
        if (response.status < 200 || response.status >= 300) {
          return [];
        }
        const parsed = associationResponseSchema.safeParse(response.data);
        if (!parsed.success) {
          return [];
        }
        return parsed.data.map((item) => ({
          kind,
          text: item.text,
          originUrl: item.originUrl ?? null,
        }));
      } catch {
        return [];
      }
    },
  };
}
