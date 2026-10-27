import {
  LOCAL_OWNER_SCOPE,
  normalizeLemma,
  type FrequencyCorpusEntry,
  type FrequencyCorpusInput,
  type SourceRecord,
  type WordRepository,
} from '@woyao/data';

import { assertChecksum, assertEntryUsable, type AssetEntry } from './manifest';

/** 一条考试词频。 */
export interface FrequencyRow {
  readonly word: string;
  readonly frequency: number;
}

/**
 * 解析 NETEM 词频 JSON。
 *
 * 上游字段是中文（`单词`、`词频`）；同时接受英文键，方便用自建语料做回归。
 * **没有词频或词频 <= 0 的行不导入**——它们不是“低频”，而是“未知”，
 * 写进语料会把 UNKNOWN 错误地变成 BASIC。
 *
 * @param raw JSON 解析结果。
 * @returns 词频行（已归一化词形）。
 */
export function parseNetemJson(raw: unknown): FrequencyRow[] {
  if (!Array.isArray(raw)) {
    throw new Error('NETEM JSON 顶层必须是数组');
  }
  const rows: FrequencyRow[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    const word = record['单词'] ?? record.word;
    const frequency = record['词频'] ?? record.frequency;
    if (typeof word !== 'string' || word.trim() === '') {
      continue;
    }
    const parsed = typeof frequency === 'number' ? frequency : Number(frequency);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      continue;
    }
    rows.push({ word: normalizeLemma(word), frequency: Math.trunc(parsed) });
  }
  return rows;
}

/** 导入选项。 */
export interface ImportFrequencyOptions {
  readonly repo: WordRepository;
  readonly rows: readonly FrequencyRow[];
  readonly entry: AssetEntry;
  readonly exam: string;
  readonly corpusVersion: string;
  readonly deviceId: string;
  readonly now: Date;
  /** 导入前校验文件校验和（推荐传实际 JSON 路径）。 */
  readonly sourceFilePath?: string;
  readonly allowedLicenses?: readonly string[];
}

/** 导入结果。 */
export interface ImportFrequencyResult {
  readonly sourceId: string;
  readonly importedEntries: number;
  /** 词库里没有、因此保持“未知词频”的词数。 */
  readonly missingWords: number;
  readonly corpusVersion: string;
}

/**
 * 把词频条目写成一份语料（整卷覆盖）。
 *
 * 名次必须与数据层约定一致：并列组取**组内最小名次**，并写 `equalCount`。
 * 缺词的条目不会编造 frequency=0 占位，而是在结果里报告 missingWords，
 * 让这些词在 UI 上继续显示“未知”。
 *
 * @param options 导入参数。
 * @returns 导入统计。
 */
export async function importFrequency(options: ImportFrequencyOptions): Promise<ImportFrequencyResult> {
  if (options.sourceFilePath !== undefined) {
    await assertChecksum(options.entry, options.sourceFilePath);
  }
  assertEntryUsable(options.entry, {
    allowedLicenses: options.allowedLicenses,
    requireRedistribution: false,
  });
  if (options.entry.kind !== 'FREQUENCY') {
    throw new Error(`资源 ${options.entry.id} 不是词频语料`);
  }

  const source: SourceRecord = options.repo.upsertSource({
    id: 'builtin-netem',
    ownerScope: LOCAL_OWNER_SCOPE,
    type: 'BUILTIN',
    name: options.entry.source.name,
    version: options.entry.source.version,
    url: options.entry.source.url,
    licenseCode: options.entry.source.license.code,
    licenseUrl: options.entry.source.license.url,
    attribution: options.entry.source.license.attribution,
    redistributionAllowed: options.entry.source.license.redistributionAllowed,
    deviceId: options.deviceId,
    now: options.now,
  });

  // 同一个词出现多次（拼写变体）时合并词频，避免同一语料里出现两行同名。
  const byLemma = new Map<string, number>();
  for (const row of options.rows) {
    byLemma.set(row.word, (byLemma.get(row.word) ?? 0) + row.frequency);
  }

  const resolved: { wordId: string; frequency: number }[] = [];
  let missingWords = 0;
  for (const [lemma, frequency] of byLemma) {
    const word = options.repo.getWordByLemma(lemma, LOCAL_OWNER_SCOPE);
    if (word === null) {
      missingWords += 1;
      continue;
    }
    resolved.push({ wordId: word.id, frequency });
  }

  resolved.sort((left, right) => right.frequency - left.frequency || left.wordId.localeCompare(right.wordId));
  const entries: FrequencyCorpusEntry[] = [];
  let index = 0;
  while (index < resolved.length) {
    const frequency = resolved[index].frequency;
    let end = index;
    while (end < resolved.length && resolved[end].frequency === frequency) {
      end += 1;
    }
    const equalCount = end - index;
    for (let position = index; position < end; position += 1) {
      entries.push({
        wordId: resolved[position].wordId,
        frequency,
        rank: index + 1,
        equalCount,
      });
    }
    index = end;
  }

  const corpus: FrequencyCorpusInput = {
    exam: options.exam,
    corpusVersion: options.corpusVersion,
    sourceId: source.id,
    // NETEM 只提供词频，没有总词数；不拿“词条数”冒充 token 数。
    totalTokens: null,
    knownWordCount: entries.length,
    entries,
  };
  options.repo.writeFrequencyCorpus(corpus);

  return {
    sourceId: source.id,
    importedEntries: entries.length,
    missingWords,
    corpusVersion: options.corpusVersion,
  };
}
