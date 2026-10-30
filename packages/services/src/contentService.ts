/**
 * 内容服务：一个词的释义与发音。
 *
 * 核心是**降级路径**（这是需求，不是异常处理补丁）：
 * 1. 本地有义项 → `source='LOCAL'`，**直接返回**，绝不因在线失败丢掉本地内容；
 * 2. 本地无义项 → 走在线词典，命中则落 `content_cache`、`source='ONLINE'`；
 * 3. 在线失败/离线 → `source='NONE'` + 空义项，**不抛错**（UI 据此显示“暂无内容”）。
 *
 * 缓存语义：命中且未过期 → 直接用；命中但过期 → **仍可用**，但会尝试刷新一次，
 * 刷新失败仍返回旧缓存（TTL 只决定“要不要刷新”，不决定“能不能用”）。
 *
 * 隐私红线：只请求用户主动查的那一个词的 lemma，请求不带 token/历史/整本词库。
 */

import {
  addMilliseconds,
  toIsoInstant,
} from '@woyao/core';
import type { ContentCacheRepository } from '@woyao/data';

import {
  contentWordInputSchema,
  distractorPoolInputSchema,
  parseOrThrow,
  pronunciationInputSchema,
  type DistractorWordView,
  type SenseView,
} from './dto';
import { ServiceNotFoundError } from './errors';
import type { Asyncify, ServiceContext } from './ports';
import type { DictionaryEntry, OnlineService } from './onlineService';

/** 一个词的内容（含来源徽标，UI 据此展示 LOCAL/ONLINE/NONE）。 */
export interface WordContentResult {
  readonly wordId: string;
  readonly lemma: string;
  readonly phoneticUk: string | null;
  readonly phoneticUs: string | null;
  readonly senses: SenseView[];
  /** 数据从哪来。 */
  readonly source: 'LOCAL' | 'ONLINE' | 'NONE';
}

/** 一个词的发音结果。 */
export interface AudioResult {
  readonly wordId: string;
  readonly accent: 'uk' | 'us';
  /** 音频 URL；在线失败时为 `null`（UI 回退本地音标）。 */
  readonly url: string | null;
  /** 本地音标文本（在线失败时的兜底）。 */
  readonly phoneticText: string | null;
}

/** 内容服务契约。 */
export interface ContentService {
  getWordContent(input: { wordId: string }): Promise<WordContentResult>;
  getPronunciation(input: { wordId: string; accent: 'uk' | 'us' }): Promise<AudioResult>;
  /**
   * 取一个词形的 AI 相近干扰词池（R3）。
   *
   * content_cache 优先（key = `distractors:${词形小写}`，TTL 30 天）；
   * 未命中才调 LLM。LLM 未配置或调用失败时返回 `[]`（**绝不抛错**——
   * 干扰项只是锦上添花，学习卡不能因为 AI 不可用而组不出来）。
   */
  getDistractorPool(input: { lemma: string }): Promise<ReadonlyArray<DistractorWordView>>;
}

/** 构造参数。 */
export interface ContentServiceOptions {
  readonly context: ServiceContext;
  /** 内容缓存仓储（异步视图）。 */
  readonly contentCache: Asyncify<ContentCacheRepository>;
  /** 在线内容服务（词典/发音 URL）。 */
  readonly online: OnlineService;
}

/** 词典缓存 TTL：24 小时。 */
const DICTIONARY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** 发音 URL 缓存 TTL：7 天（音频地址很少变）。 */
const AUDIO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** AI 相近干扰词池缓存 TTL：30 天（同一词形的易混词几乎不变）。 */
const DISTRACTOR_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 判断缓存是否“未过期”；`null` 表示永不过期。 */
function isFresh(expiresAt: string | null, nowIso: string): boolean {
  return expiresAt === null || expiresAt > nowIso;
}

/** 把词典义项投影成服务层 `SenseView`。 */
function sensesFromEntry(entry: DictionaryEntry): SenseView[] {
  return entry.senses.map((sense, index) => ({
    senseNo: index + 1,
    pos: sense.pos,
    simpleZh: sense.definitionZh,
    detailedZh: null,
    contextText: null,
  }));
}

/**
 * 创建内容服务。
 *
 * @param options 上下文、缓存仓储与在线服务。
 * @returns 内容服务实例。
 */
export function createContentService(options: ContentServiceOptions): ContentService {
  const { context, contentCache, online } = options;

  return {
    async getWordContent(input: { wordId: string }): Promise<WordContentResult> {
      const { wordId } = parseOrThrow(contentWordInputSchema, input, '查询词内容');
      const word = await context.repos.words.getWordById(wordId);
      if (word === null) {
        throw new ServiceNotFoundError('word', wordId);
      }

      // 第一步：本地义项优先，绝不因在线失败丢掉本地内容。
      const localSenses = await context.repos.words.listSenses(word.id);
      if (localSenses.length > 0) {
        return {
          wordId: word.id,
          lemma: word.lemma,
          phoneticUk: word.phoneticUk,
          phoneticUs: word.phoneticUs,
          senses: localSenses.map((sense) => ({
            senseNo: sense.senseNo,
            pos: sense.pos,
            simpleZh: sense.simpleZh,
            detailedZh: sense.detailedZh,
            contextText: sense.contextText,
          })),
          source: 'LOCAL',
        };
      }

      // 第二步：本地无义项，才查在线；先看缓存。
      const cacheKey = `content:word:${word.lemma}`;
      const now = context.clock.now();
      const nowIso = toIsoInstant(now);
      const cached = await contentCache.get(cacheKey);
      if (cached !== null && isFresh(cached.expiresAt, nowIso)) {
        return {
          wordId: word.id,
          lemma: word.lemma,
          // 音标优先取 words 表字段（本地），缺失才用在线。
          phoneticUk: word.phoneticUk ?? (cached.payload as DictionaryEntry).phoneticUk ?? null,
          phoneticUs: word.phoneticUs ?? (cached.payload as DictionaryEntry).phoneticUs ?? null,
          senses: sensesFromEntry(cached.payload as DictionaryEntry),
          source: 'ONLINE',
        };
      }

      const entry = await online.lookupDictionary({ lemma: word.lemma });
      if (entry !== null) {
        await contentCache.set({
          cacheKey,
          provider: 'dictionaryapi',
          payload: entry,
          fetchedAt: nowIso,
          expiresAt: toIsoInstant(addMilliseconds(now, DICTIONARY_CACHE_TTL_MS)),
          sourceId: null,
        });
        return {
          wordId: word.id,
          lemma: word.lemma,
          phoneticUk: word.phoneticUk ?? entry.phoneticUk ?? null,
          phoneticUs: word.phoneticUs ?? entry.phoneticUs ?? null,
          senses: sensesFromEntry(entry),
          source: 'ONLINE',
        };
      }

      // 第三步：在线失败，但还有“过期缓存”仍可用——离线时它比空结果更有价值。
      if (cached !== null) {
        return {
          wordId: word.id,
          lemma: word.lemma,
          phoneticUk: word.phoneticUk ?? (cached.payload as DictionaryEntry).phoneticUk ?? null,
          phoneticUs: word.phoneticUs ?? (cached.payload as DictionaryEntry).phoneticUs ?? null,
          senses: sensesFromEntry(cached.payload as DictionaryEntry),
          source: 'ONLINE',
        };
      }

      // 第四步：彻底没有 → NONE，不抛错。
      return {
        wordId: word.id,
        lemma: word.lemma,
        phoneticUk: word.phoneticUk,
        phoneticUs: word.phoneticUs,
        senses: [],
        source: 'NONE',
      };
    },

    async getPronunciation(input: { wordId: string; accent: 'uk' | 'us' }): Promise<AudioResult> {
      const { wordId, accent } = parseOrThrow(pronunciationInputSchema, input, '查询发音');
      const word = await context.repos.words.getWordById(wordId);
      if (word === null) {
        throw new ServiceNotFoundError('word', wordId);
      }

      // 音标优先取 words 表字段；音频 URL 只能在线取（本地不存音频）。
      const phoneticText = accent === 'uk' ? word.phoneticUk : word.phoneticUs;
      const cacheKey = `audio:${word.lemma}:${accent}`;
      const now = context.clock.now();
      const nowIso = toIsoInstant(now);

      const cached = await contentCache.get(cacheKey);
      if (cached !== null && isFresh(cached.expiresAt, nowIso)) {
        return {
          wordId: word.id,
          accent,
          url: (cached.payload as { url: string | null }).url ?? null,
          phoneticText,
        };
      }

      let url: string | null = null;
      const entry = await online.lookupDictionary({ lemma: word.lemma });
      if (entry !== null) {
        url = accent === 'uk' ? entry.audioUrlUk : entry.audioUrlUs;
        await contentCache.set({
          cacheKey,
          provider: 'dictionaryapi',
          payload: { url },
          fetchedAt: nowIso,
          expiresAt: toIsoInstant(addMilliseconds(now, AUDIO_CACHE_TTL_MS)),
          sourceId: null,
        });
      } else if (cached !== null) {
        // 在线失败回退过期缓存（仍可用）。
        url = (cached.payload as { url: string | null }).url ?? null;
      }

      return { wordId: word.id, accent, url, phoneticText };
    },

    async getDistractorPool(input: { lemma: string }): Promise<ReadonlyArray<DistractorWordView>> {
      const { lemma } = parseOrThrow(distractorPoolInputSchema, input, '查询相近干扰词');
      const cacheKey = `distractors:${lemma.toLowerCase()}`;
      const now = context.clock.now();
      const nowIso = toIsoInstant(now);

      // 缓存命中且未过期 → 直接返回，绝不重复烧 LLM 额度。
      const cached = await contentCache.get(cacheKey);
      if (cached !== null && isFresh(cached.expiresAt, nowIso)) {
        return cached.payload as DistractorWordView[];
      }

      // LLM 未配置：诚实地返回空池（调用方回退词库候选机制），不抛错。
      const llm = context.llm;
      if (llm === undefined) {
        return [];
      }

      try {
        const generated = await llm.generateDistractorWords({ lemma, count: 6 });
        const pool: DistractorWordView[] = [];
        const seen = new Set<string>([lemma.toLowerCase()]);
        for (const item of generated) {
          const candidateLemma = typeof item.lemma === 'string' ? item.lemma.trim() : '';
          const meaningZh = typeof item.meaningZh === 'string' ? item.meaningZh.trim() : '';
          // 防御性过滤：目标词本身与空词条一律剔除（绝不把题干词混进干扰项）。
          if (candidateLemma === '' || meaningZh === '' || seen.has(candidateLemma.toLowerCase())) {
            continue;
          }
          seen.add(candidateLemma.toLowerCase());
          pool.push({ lemma: candidateLemma, meaningZh });
        }
        await contentCache.set({
          cacheKey,
          provider: 'llm',
          payload: pool,
          fetchedAt: nowIso,
          expiresAt: toIsoInstant(addMilliseconds(now, DISTRACTOR_CACHE_TTL_MS)),
          sourceId: null,
        });
        return pool;
      } catch (cause: unknown) {
        // LLM 失败（离线/额度/解析失败）：有过期缓存就用旧值兜底，否则返回空池。
        context.log.warn(`AI 相近干扰词生成失败：${lemma}`, cause);
        if (cached !== null) {
          return cached.payload as DistractorWordView[];
        }
        return [];
      }
    },
  };
}
