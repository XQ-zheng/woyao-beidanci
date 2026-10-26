/**
 * 词频视图的共用装配逻辑。
 *
 * 为什么单独成一个文件：`libraryService`（词库列表、单词详情、词频查询）与
 * `studyService`（卡片上的“重要性”标签）都要给出同一份 `FrequencyView`。
 * 两份实现迟早会在口径上漂移——而“虚报重要性”是需求明令禁止的坑，
 * 所以这里只留一份：**分母永远是该语料版本里的词条总数**，
 * 语料里没有的词按 `UNKNOWN` 处理，绝不按“低频”处理。
 *
 * 口径说明（三条都不能改）：
 * 1. `knownWordCount` 是**语料词数**，不是当前词库词数。用词库词数当分母，
 *    小词库里的常见词会被误判成“高频”。
 * 2. `totalTokens` 是语料级字段（`frequency_entries.total_tokens`，整卷同值），
 *    没有语料或导入方没给值时一律 `null`，不编数字。
 * 3. 分级本身由 `@woyao/core` 的 `classifyFrequencyImportance` 决定，服务层不算百分位。
 */

import { classifyFrequencyImportance, type FrequencyEntry } from '@woyao/core';
import type { FrequencyCorpusMeta } from '@woyao/data';

import type { FrequencyView } from './dto';
import type { AsyncRepositories } from './ports';

/** 一次词频查询的结果（避免为每个词都去读一遍整份语料）。 */
export interface FrequencyLookup {
  /** `wordId → 条目` 索引。 */
  readonly byWordId: ReadonlyMap<string, FrequencyEntry>;
  /** 该语料版本里有频率的词条总数（百分位分母）。 */
  readonly knownWordCount: number;
  /**
   * 语料级元信息。
   *
   * `null` 表示**该 (exam, corpusVersion) 没有任何频率行**；非 null 时
   * `totalTokens` 仍可能是 `null`（导入方没给出语料总词数）。
   * 这两种情况都不能编一个数字出来——UI 的“统计口径”宁可空着，也不能虚报。
   */
  readonly meta: FrequencyCorpusMeta | null;
}

/** 没有语料上下文时的词频视图（**不把未知当低频**）。 */
export const UNKNOWN_FREQUENCY: FrequencyView = {
  importance: 'UNKNOWN',
  frequency: null,
  rank: null,
  totalTokens: null,
  corpusVersion: null,
  sourceId: null,
};

/**
 * 读一份语料，建成 `wordId → entry` 的索引。
 *
 * @param words 词条仓储的异步端口。
 * @param exam 考试标签（例如 `CET4`）。
 * @param corpusVersion 语料版本（例如 `ngsl-1.2`）。
 * @returns 语料索引。
 */
export async function loadFrequencyLookup(
  words: AsyncRepositories['words'],
  exam: string,
  corpusVersion: string,
): Promise<FrequencyLookup> {
  // 两次读并行：逐词条目（分级要用）与语料级元信息（`totalTokens` 要用）。
  const [entries, meta] = await Promise.all([
    words.listFrequencyEntries(exam, corpusVersion),
    words.getFrequencyCorpusMeta(exam, corpusVersion),
  ]);
  const byWordId = new Map<string, FrequencyEntry>();
  for (const entry of entries) {
    byWordId.set(entry.wordId, entry);
  }
  return { byWordId, knownWordCount: entries.length, meta };
}

/**
 * 组装词频视图。
 *
 * @param lookup 语料索引；`null` 表示调用方没给 exam/corpusVersion。
 * @param wordId 词条 id。
 * @returns 词频视图。
 */
export function toFrequencyView(lookup: FrequencyLookup | null, wordId: string): FrequencyView {
  if (lookup === null) {
    return UNKNOWN_FREQUENCY;
  }
  const entry = lookup.byWordId.get(wordId) ?? null;
  const importance = classifyFrequencyImportance(entry, lookup.knownWordCount);
  if (entry === null) {
    // 语料完整（分母 > 0）但这个词不在里面：按“未知”处理，不按“低频”处理。
    return {
      importance,
      frequency: null,
      rank: null,
      totalTokens: null,
      corpusVersion: null,
      sourceId: null,
    };
  }
  return {
    importance,
    frequency: entry.frequency,
    rank: entry.rank ?? null,
    // 语料级字段，整卷同值。词不在语料里时上面已经返回 null；
    // 这里用可选链兜住“将来数据层改了聚合口径”的情况，而不是断言非空。
    totalTokens: lookup.meta?.totalTokens ?? null,
    corpusVersion: entry.corpusVersion,
    sourceId: entry.sourceId,
  };
}
