/**
 * 词条与词频仓储。
 *
 * 设计要点：
 * - **标准化只在仓储层做一次**：`lemma` 保留原词形，`normalized_lemma` 用于查重与查询，
 *   唯一键 `(owner_scope, normalized_lemma)` 保证同一用户不会有两个“abandon”。
 * - **create 是幂等的**：词库导入会重复遇到同一个词，重复调用返回同一条记录并补齐缺失义项，
 *   而不是抛唯一键错误——否则导入脚本必须自己先查一遍，容易写成竞态。
 * - **词频语料一次性整体写入**：`writeFrequencyCorpus` 在**单个事务**里校验并写入，
 *   任一条不合规就整体回滚，避免出现“写了一半的语料”。
 */

import { randomUUID } from 'node:crypto';

import type { SqliteDatabase } from './connection';
import {
  FrequencyCorpusMismatchError,
  InvalidRepositoryInputError,
} from './errors';
import { runInTransaction } from './transaction';

/** 本地（未登录）数据归属。多账号时用账号 id 作为 `ownerScope`，实现数据隔离。 */
export const LOCAL_OWNER_SCOPE = 'LOCAL';

/** 词条列表/查询的默认归属范围。 */
export const DEFAULT_OWNER_SCOPE = LOCAL_OWNER_SCOPE;

/** 一个义项的输入。 */
export interface WordSenseInput {
  /** 义项序号，从 1 开始；缺省按数组下标 + 1。 */
  readonly senseNo?: number;
  /** 词性，例如 `v.`。 */
  readonly pos?: string;
  /** 简明中文释义（必填，界面主展示）。 */
  readonly simpleZh: string;
  /** 详细中文释义。 */
  readonly detailedZh?: string | null;
  /** 例句/语境。 */
  readonly contextText?: string | null;
  /** 来源 id；自建内容可为空。 */
  readonly sourceId?: string | null;
}

/** 创建/更新一个词条的输入。 */
export interface WordInput {
  /** 词条 id；缺省时自动生成（导入脚本可传稳定 id 便于复现）。 */
  readonly id?: string;
  /** 归属范围，默认 `LOCAL`。 */
  readonly ownerScope?: string;
  /** 原词形，例如 `Abandon`。 */
  readonly lemma: string;
  /** 语言，默认 `en`。 */
  readonly language?: string;
  /** 英式音标。 */
  readonly phoneticUk?: string | null;
  /** 美式音标。 */
  readonly phoneticUs?: string | null;
  /** 义项（可选，按顺序写入）。 */
  readonly senses?: readonly WordSenseInput[];
  /** 注入的时间戳（UTC ISO 8601），默认取系统时钟。 */
  readonly now?: string;
}

/** 词条记录（camelCase，对应 `words` 一行）。 */
export interface WordRecord {
  readonly id: string;
  readonly ownerScope: string;
  readonly lemma: string;
  readonly normalizedLemma: string;
  readonly language: string;
  readonly phoneticUk: string | null;
  readonly phoneticUs: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 义项记录（camelCase，对应 `word_senses` 一行）。 */
export interface WordSenseRecord {
  readonly id: string;
  readonly wordId: string;
  readonly senseNo: number;
  readonly pos: string;
  readonly simpleZh: string;
  readonly detailedZh: string | null;
  readonly contextText: string | null;
  readonly sourceId: string | null;
}

/** 一条词频记录的输入。 */
export interface FrequencyEntryInput {
  /** 词条 id（必须先存在于 `words`）。 */
  readonly wordId: string;
  /** 考试/场景标签，默认 `ALL`。 */
  readonly exam?: string;
  /** 频次（原始出现次数）。 */
  readonly frequency: number;
  /** 语料总词数（用于 token 完整性校验）。 */
  readonly totalTokens: number;
  /** 降序名次；同频次并列共享**组内最小名次**。 */
  readonly rank: number;
  /** 并列组大小（含自身）。 */
  readonly equalCount: number;
}

/** 一次词频语料导入的输入。 */
export interface FrequencyCorpusInput {
  /** 语料版本，例如 `ngsl-1.2`。 */
  readonly corpusVersion: string;
  /** 来源 id。 */
  readonly sourceId: string;
  /** 考试标签，默认 `ALL`。 */
  readonly exam?: string;
  /** 该语料版本中频次大于 0 的词条总数（`percentile` 的分母）。 */
  readonly knownWordCount: number;
  /** 全部条目；必须覆盖整份语料。 */
  readonly entries: readonly FrequencyEntryInput[];
  /** 注入的时间戳（UTC ISO 8601），默认取系统时钟。 */
  readonly now?: string;
}

/** 词频语料写入结果。 */
export interface FrequencyCorpusWriteResult {
  /** 实际写入（或覆盖）的条目数。 */
  readonly written: number;
  /** 语料版本。 */
  readonly corpusVersion: string;
  /** `knownWordCount`，回显便于调用方断言。 */
  readonly knownWordCount: number;
}

/** 词条仓储契约（Task 5 直接消费）。 */
export interface WordRepository {
  createWord(input: WordInput): WordRecord;
  getWordByLemma(lemma: string, ownerScope?: string): WordRecord | null;
  listSenses(wordId: string): WordSenseRecord[];
  writeFrequencyCorpus(input: FrequencyCorpusInput): FrequencyCorpusWriteResult;
}

/** 把词形标准化：去首尾空白、内部连续空白折叠为单个空格、转小写。 */
export function normalizeLemma(lemma: string): string {
  return lemma.trim().replace(/\s+/gu, ' ').toLowerCase();
}

/**
 * 校验一个词形是否可以入库。
 *
 * @param lemma 原词形。
 * @returns 标准化结果。
 * @throws {InvalidRepositoryInputError} 词形为空或不是字符串时。
 */
function requireLemma(lemma: string): string {
  if (typeof lemma !== 'string' || lemma.trim() === '') {
    throw new InvalidRepositoryInputError('lemma', '词形必须是非空字符串');
  }
  return normalizeLemma(lemma);
}

/** 当前时间（UTC ISO 8601）。 */
function defaultNow(): string {
  return new Date().toISOString();
}

/** `words` 行的 snake_case 形状。 */
interface WordRow {
  id: string;
  owner_scope: string;
  lemma: string;
  normalized_lemma: string;
  language: string;
  phonetic_uk: string | null;
  phonetic_us: string | null;
  created_at: string;
  updated_at: string;
}

/** `word_senses` 行的 snake_case 形状。 */
interface WordSenseRow {
  id: string;
  word_id: string;
  sense_no: number;
  pos: string;
  simple_zh: string;
  detailed_zh: string | null;
  context_text: string | null;
  source_id: string | null;
}

/** 行 → 词条记录。 */
function toWordRecord(row: WordRow): WordRecord {
  return {
    id: row.id,
    ownerScope: row.owner_scope,
    lemma: row.lemma,
    normalizedLemma: row.normalized_lemma,
    language: row.language,
    phoneticUk: row.phonetic_uk,
    phoneticUs: row.phonetic_us,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 行 → 义项记录。 */
function toSenseRecord(row: WordSenseRow): WordSenseRecord {
  return {
    id: row.id,
    wordId: row.word_id,
    senseNo: row.sense_no,
    pos: row.pos,
    simpleZh: row.simple_zh,
    detailedZh: row.detailed_zh,
    contextText: row.context_text,
    sourceId: row.source_id,
  };
}

/**
 * 校验词频语料的自洽性（纯函数，便于单测直接喂数据）。
 *
 * 三条规则各自对应一种真实事故：
 * 1. 每个并列组内 `equalCount` 必须等于组大小——只写 `rank` 而让 `equal_count` 走默认 1，
 *    会让 core 的百分位偏高，把 P60–P90 的词误判为高频；
 * 2. 语料条数必须等于 `knownWordCount`，且同一个词只能出现一次——语料被截断、
 *    或同一词被重复计入时立刻失败；
 * 3. 同一 `rank` 必须对应同一 `frequency`——否则“并列”是假的，百分位无意义。
 *
 * **关于 `SUM(equal_count) == knownWordCount` 的口径（重要，与 D-02 的字面写法不同）**：
 * `equal_count` 是**每个词各自一行**上的“并列组大小”。若一个组有 `s` 个词，
 * 按行求和得到 `Σ s²`，只有在 `s = 1`（无并列）时才等于词数 `n`；
 * 例如两个词并列（各 `equal_count = 2`）按行求和是 `4`，而词数是 `2`。
 * 因此“`SUM(equal_count) == knownWordCount`”按字面执行会**禁止一切并列**，
 * 与 equal_count 的用途自相矛盾。真正等价于 `n` 的是**按组求和**：`Σ over groups s = n`，
 * 也就是「每个词一行」+「每行的 equal_count 等于本组大小」，本实现按后者校验。
 * 报告中已把这一点作为口径勘误上报，等 D-02 修订后此处只需换实现、测试不用动。
 *
 * @param entries 全部条目。
 * @param knownWordCount 语料中频次大于 0 的词条总数。
 * @throws {FrequencyCorpusMismatchError} 任一规则不满足时（`kind` 区分具体失配）。
 */
export function assertFrequencyCorpusConsistent(
  entries: readonly FrequencyEntryInput[],
  knownWordCount: number,
): void {
  if (
    typeof knownWordCount !== 'number' ||
    !Number.isInteger(knownWordCount) ||
    knownWordCount <= 0
  ) {
    throw new FrequencyCorpusMismatchError(
      'KNOWN_WORD_COUNT_INVALID',
      `knownWordCount 必须是正整数，收到 ${String(knownWordCount)}`,
      `knownWordCount=${String(knownWordCount)}`,
    );
  }

  const groups = new Map<number, { frequency: number; rows: FrequencyEntryInput[] }>();
  const seenWordIds = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.wordId !== 'string' || entry.wordId.trim() === '') {
      throw new FrequencyCorpusMismatchError(
        'DUPLICATE_WORD',
        `词频条目的 wordId 必须是非空字符串，收到 ${String(entry.wordId)}`,
        `wordId=${String(entry.wordId)}`,
      );
    }
    if (seenWordIds.has(entry.wordId)) {
      throw new FrequencyCorpusMismatchError(
        'DUPLICATE_WORD',
        `wordId=${entry.wordId} 在同一份语料里出现了多次：一个词只能被计入一次`,
        `wordId=${entry.wordId}`,
      );
    }
    seenWordIds.add(entry.wordId);
    if (!Number.isInteger(entry.rank) || entry.rank < 1) {
      throw new FrequencyCorpusMismatchError(
        'RANK_INCONSISTENT',
        `rank 必须是 >=1 的整数，收到 ${String(entry.rank)}（wordId=${entry.wordId}）`,
        `wordId=${entry.wordId}`,
      );
    }
    if (!Number.isInteger(entry.equalCount) || entry.equalCount < 1) {
      throw new FrequencyCorpusMismatchError(
        'TIE_GROUP_DEFAULT',
        `equalCount 必须是 >=1 的整数，收到 ${String(entry.equalCount)}（wordId=${entry.wordId}）`,
        `wordId=${entry.wordId}`,
      );
    }
    const existing = groups.get(entry.rank);
    if (existing === undefined) {
      groups.set(entry.rank, { frequency: entry.frequency, rows: [entry] });
    } else {
      existing.rows.push(entry);
    }
  }

  for (const [rank, group] of groups) {
    for (const entry of group.rows) {
      if (entry.frequency !== group.frequency) {
        throw new FrequencyCorpusMismatchError(
          'RANK_INCONSISTENT',
          `同一 rank=${rank} 的条目不共享同一 frequency（${group.frequency} vs ${entry.frequency}，wordId=${entry.wordId}）`,
          `rank=${rank},wordId=${entry.wordId}`,
        );
      }
    }
    const groupSize = group.rows.length;
    for (const entry of group.rows) {
      if (groupSize > 1 && entry.equalCount === 1) {
        throw new FrequencyCorpusMismatchError(
          'TIE_GROUP_DEFAULT',
          `rank=${rank} 是 ${groupSize} 个词的并列组，但 wordId=${entry.wordId} 的 equalCount 仍是默认值 1；` +
            '导入必须写入真实并列数，否则并列词的重要性会被判高',
          `rank=${rank},wordId=${entry.wordId},groupSize=${groupSize}`,
        );
      }
      if (entry.equalCount !== groupSize) {
        throw new FrequencyCorpusMismatchError(
          'RANK_INCONSISTENT',
          `rank=${rank} 的并列组有 ${groupSize} 个词，但 wordId=${entry.wordId} 的 equalCount=${entry.equalCount}`,
          `rank=${rank},wordId=${entry.wordId},groupSize=${groupSize},equalCount=${entry.equalCount}`,
        );
      }
    }
  }

  // 按组累计：每个并列组只计一次组大小，其结果恒等于词数（前提是每个词只出现一次）。
  const coveredWords = [...groups.values()].reduce((sum, group) => sum + group.rows.length, 0);
  const literalRowSum = entries.reduce((sum, entry) => sum + entry.equalCount, 0);
  if (coveredWords !== knownWordCount || entries.length !== knownWordCount) {
    throw new FrequencyCorpusMismatchError(
      'TOTAL_MISMATCH',
      `语料覆盖 ${coveredWords} 个词（${entries.length} 条记录，按行 SUM(equal_count)=${literalRowSum}），` +
        `与 knownWordCount=${knownWordCount} 不一致：语料被截断或重复计入`,
      `covered=${coveredWords},rows=${entries.length},rowSum=${literalRowSum},knownWordCount=${knownWordCount}`,
    );
  }
}

/**
 * 创建词条仓储。
 *
 * @param db 已迁移的连接。
 * @returns 仓储实例。
 */
export function createWordRepository(db: SqliteDatabase): WordRepository {
  const selectByNormalized = db.prepare(
    `SELECT id, owner_scope, lemma, normalized_lemma, language, phonetic_uk, phonetic_us, created_at, updated_at
       FROM words
      WHERE owner_scope = ? AND normalized_lemma = ? AND deleted_at IS NULL`,
  );
  const selectById = db.prepare(
    `SELECT id, owner_scope, lemma, normalized_lemma, language, phonetic_uk, phonetic_us, created_at, updated_at
       FROM words
      WHERE id = ?`,
  );
  const insertWord = db.prepare(
    `INSERT INTO words
       (id, owner_scope, lemma, normalized_lemma, language, phonetic_uk, phonetic_us, created_at, updated_at, device_id, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0)`,
  );
  const updateWord = db.prepare(
    `UPDATE words
        SET lemma = ?, language = ?, phonetic_uk = ?, phonetic_us = ?, updated_at = ?, revision = revision + 1
      WHERE id = ?`,
  );
  const selectSense = db.prepare(
    `SELECT id, word_id, sense_no, pos, simple_zh, detailed_zh, context_text, source_id
       FROM word_senses
      WHERE word_id = ? AND sense_no = ? AND ifnull(source_id, '') = ? AND deleted_at IS NULL`,
  );
  const insertSense = db.prepare(
    `INSERT INTO word_senses
       (id, word_id, sense_no, pos, simple_zh, detailed_zh, context_text, source_id, created_at, updated_at, device_id, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0)`,
  );
  const selectSenses = db.prepare(
    `SELECT id, word_id, sense_no, pos, simple_zh, detailed_zh, context_text, source_id
       FROM word_senses
      WHERE word_id = ? AND deleted_at IS NULL
      ORDER BY sense_no`,
  );
  const upsertFrequencyEntry = db.prepare(
    `INSERT INTO frequency_entries
       (word_id, exam, corpus_version, frequency, total_tokens, rank, equal_count, source_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (word_id, exam, corpus_version, source_id) DO UPDATE SET
       frequency = excluded.frequency,
       total_tokens = excluded.total_tokens,
       rank = excluded.rank,
       equal_count = excluded.equal_count`,
  );

  return {
    createWord(input: WordInput): WordRecord {
      if (input === null || typeof input !== 'object') {
        throw new InvalidRepositoryInputError('input', '词条输入不能为空');
      }
      const normalized = requireLemma(input.lemma);
      const ownerScope = input.ownerScope ?? DEFAULT_OWNER_SCOPE;
      if (typeof ownerScope !== 'string' || ownerScope.trim() === '') {
        throw new InvalidRepositoryInputError('ownerScope', '归属范围必须是非空字符串');
      }
      const now = input.now ?? defaultNow();
      const language = input.language ?? 'en';
      const phoneticUk = input.phoneticUk ?? null;
      const phoneticUs = input.phoneticUs ?? null;

      return runInTransaction(
        db,
        () => {
          const existing = selectByNormalized.get(ownerScope, normalized) as WordRow | undefined;
          let wordId: string;
          if (existing === undefined) {
            wordId = input.id ?? randomUUID();
            insertWord.run(
              wordId,
              ownerScope,
              input.lemma.trim(),
              normalized,
              language,
              phoneticUk,
              phoneticUs,
              now,
              now,
            );
          } else {
            // 幂等：同一个词再次导入时更新可变字段，并补齐缺失义项，而不是撞唯一键。
            wordId = existing.id;
            updateWord.run(
              input.lemma.trim(),
              language,
              phoneticUk,
              phoneticUs,
              now,
              wordId,
            );
          }

          const senses: readonly WordSenseInput[] = Array.isArray(input.senses) ? input.senses : [];
          senses.forEach((sense, index) => {
            if (sense === null || typeof sense !== 'object') {
              throw new InvalidRepositoryInputError('senses', '义项不能为空');
            }
            if (typeof sense.simpleZh !== 'string' || sense.simpleZh.trim() === '') {
              throw new InvalidRepositoryInputError('senses.simpleZh', '简明释义必须是非空字符串');
            }
            const senseNo = sense.senseNo ?? index + 1;
            if (!Number.isInteger(senseNo) || senseNo < 1) {
              throw new InvalidRepositoryInputError('senses.senseNo', '义项序号必须是 >=1 的整数');
            }
            const sourceKey = sense.sourceId ?? '';
            const present = selectSense.get(wordId, senseNo, sourceKey);
            if (present !== undefined) {
              return;
            }
            insertSense.run(
              randomUUID(),
              wordId,
              senseNo,
              sense.pos ?? '',
              sense.simpleZh.trim(),
              sense.detailedZh ?? null,
              sense.contextText ?? null,
              sense.sourceId ?? null,
              now,
              now,
            );
          });

          const row = selectById.get(wordId) as WordRow | undefined;
          if (row === undefined) {
            throw new InvalidRepositoryInputError('id', `词条写入后回读失败（id=${wordId}）`);
          }
          return toWordRecord(row);
        },
        { mode: 'IMMEDIATE' },
      );
    },

    getWordByLemma(lemma: string, ownerScope: string = DEFAULT_OWNER_SCOPE): WordRecord | null {
      const normalized = requireLemma(lemma);
      const row = selectByNormalized.get(ownerScope, normalized) as WordRow | undefined;
      return row === undefined ? null : toWordRecord(row);
    },

    listSenses(wordId: string): WordSenseRecord[] {
      const rows = selectSenses.all(wordId) as WordSenseRow[];
      return rows.map(toSenseRecord);
    },

    writeFrequencyCorpus(input: FrequencyCorpusInput): FrequencyCorpusWriteResult {
      if (input === null || typeof input !== 'object') {
        throw new InvalidRepositoryInputError('input', '词频语料输入不能为空');
      }
      const corpusVersion = input.corpusVersion;
      if (typeof corpusVersion !== 'string' || corpusVersion.trim() === '') {
        throw new InvalidRepositoryInputError('corpusVersion', '语料版本必须是非空字符串');
      }
      if (typeof input.sourceId !== 'string' || input.sourceId.trim() === '') {
        throw new InvalidRepositoryInputError('sourceId', '来源 id 必须是非空字符串');
      }
      const exam = input.exam ?? 'ALL';
      const entries: readonly FrequencyEntryInput[] = Array.isArray(input.entries) ? input.entries : [];

      assertFrequencyCorpusConsistent(entries, input.knownWordCount);

      const now = input.now ?? defaultNow();
      return runInTransaction(
        db,
        () => {
          for (const entry of entries) {
            if (
              typeof entry.totalTokens !== 'number' ||
              !Number.isInteger(entry.totalTokens) ||
              entry.totalTokens < 0
            ) {
              throw new InvalidRepositoryInputError(
                'totalTokens',
                `totalTokens 必须是非负整数，收到 ${String(entry.totalTokens)}（wordId=${entry.wordId}）`,
              );
            }
            if (!Number.isInteger(entry.frequency) || entry.frequency < 0) {
              throw new InvalidRepositoryInputError(
                'frequency',
                `frequency 必须是非负整数，收到 ${String(entry.frequency)}（wordId=${entry.wordId}）`,
              );
            }
            upsertFrequencyEntry.run(
              entry.wordId,
              entry.exam ?? exam,
              corpusVersion,
              entry.frequency,
              entry.totalTokens,
              entry.rank,
              entry.equalCount,
              input.sourceId,
              now,
            );
          }
          return {
            written: entries.length,
            corpusVersion,
            knownWordCount: input.knownWordCount,
          };
        },
        { mode: 'IMMEDIATE' },
      );
    },
  };
}
