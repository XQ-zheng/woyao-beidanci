/**
 * 词条、义项、词库与词频仓储。
 *
 * 设计要点：
 * - **标准化只在仓储层做一次**：`lemma` 保留原词形，`normalized_lemma` 用于查重与查询，
 *   唯一键 `(owner_scope, normalized_lemma)` 保证同一用户不会有两个“abandon”。
 * - **create 是幂等的**：词库导入会重复遇到同一个词，重复调用返回同一条记录并补齐/更新义项，
 *   而不是抛唯一键错误——否则导入脚本必须自己先查一遍，容易写成竞态。
 * - **词频语料一次性整体写入**：`writeFrequencyCorpus` 在**单个事务**里校验并写入，
 *   任一条不合规就整体回滚，避免出现“写了一半的语料”。
 * - 时间一律由调用方注入（`now: Date`），ID 用 `globalThis.crypto.randomUUID()`：
 *   本包没有任何 `node:*` 导入，也没有 `new Date()`。
 */

import type { FrequencyEntry } from '@woyao/core';

import type { SqliteDatabase } from './connection';
import {
  FrequencyCorpusMismatchError,
  InvalidOwnerScopeError,
  InvalidRepositoryInputError,
} from './errors';
import { runInTransaction } from './transaction';

/** 随应用分发的内置词库/词条归属（用户不可覆盖）。 */
export const BUILTIN_OWNER_SCOPE = 'BUILTIN';

/** 未登录时的本地匿名空间。 */
export const LOCAL_OWNER_SCOPE = 'LOCAL';

/** 归属范围的合法形态：`BUILTIN` / `LOCAL` / `acct:<accountId>`。 */
const OWNER_SCOPE_PATTERN = /^(?:BUILTIN|LOCAL|acct:\S+)$/u;

/**
 * 登录账号的归属范围。
 *
 * @param accountId 账号 id（非空）。
 * @returns `acct:<accountId>`。
 * @throws {InvalidOwnerScopeError} 账号 id 为空时。
 */
export function accountOwnerScope(accountId: string): string {
  if (typeof accountId !== 'string' || accountId.trim() === '') {
    throw new InvalidOwnerScopeError(accountId);
  }
  return `acct:${accountId.trim()}`;
}

/**
 * 校验归属范围。
 *
 * @param ownerScope 待校验的归属范围。
 * @returns 原值（便于链式调用）。
 * @throws {InvalidOwnerScopeError} 不在三种合法形态内时。
 */
export function assertValidOwnerScope(ownerScope: string): string {
  if (typeof ownerScope !== 'string' || !OWNER_SCOPE_PATTERN.test(ownerScope)) {
    throw new InvalidOwnerScopeError(ownerScope);
  }
  return ownerScope;
}

/** 一个义项的输入。 */
export interface SenseInput {
  /** 义项序号，从 1 开始；缺省按数组序 1..n。 */
  readonly senseNo?: number;
  /** 词性，例如 `v.`。 */
  readonly pos: string;
  /** 简明中文释义（界面主展示）。 */
  readonly simpleZh: string;
  /** 详细中文释义。 */
  readonly detailedZh?: string | null;
  /** 例句/语境。 */
  readonly contextText?: string | null;
  /** 来源 id（`sources.id`，必须已存在）。 */
  readonly sourceId: string;
}

/** 创建/更新一个词条的输入。 */
export interface WordInput {
  /** 词条 id；缺省时自动生成（导入脚本可传稳定 id 便于复现）。 */
  readonly id?: string;
  /** 归属范围，见 `assertValidOwnerScope`。 */
  readonly ownerScope: string;
  /** 原词形，例如 `Abandon`（会保留大小写）。 */
  readonly lemma: string;
  /** 语言，默认 `en`。 */
  readonly language?: string;
  /** 英式音标。 */
  readonly phoneticUk?: string | null;
  /** 美式音标。 */
  readonly phoneticUs?: string | null;
  /** 义项列表。 */
  readonly senses: readonly SenseInput[];
  /** 设备 id（同步元数据）。 */
  readonly deviceId: string;
  /** 注入的时间。 */
  readonly now: Date;
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
  readonly deletedAt: string | null;
  readonly deviceId: string;
  readonly revision: number;
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
  readonly sourceId: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly deviceId: string;
  readonly revision: number;
}

/** 词库种类。 */
export type DeckKind = 'BUILTIN' | 'CUSTOM' | 'NOTEBOOK';

/** 创建/更新一个词库的输入。 */
export interface DeckInput {
  /** 词库 id；缺省时自动生成。 */
  readonly id?: string;
  /** 归属范围。 */
  readonly ownerScope: string;
  /** 词库名（非空）。 */
  readonly name: string;
  /** 种类。 */
  readonly kind: DeckKind;
  /** 来源 id（可空）。 */
  readonly sourceId?: string | null;
  /** 设备 id。 */
  readonly deviceId: string;
  /** 注入的时间。 */
  readonly now: Date;
}

/** 词库记录（camelCase，对应 `decks` 一行）。 */
export interface DeckRecord {
  readonly id: string;
  readonly ownerScope: string;
  readonly name: string;
  readonly kind: DeckKind;
  readonly sourceId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly deviceId: string;
  readonly revision: number;
}

/**
 * 一条词频记录。
 *
 * `rank` 是**competition rank**（并列组共享组内最小名次），
 * `equalCount` 是该并列组的大小（含自身），两者必须同时正确写入：
 * 只写 `rank` 而让 `equalCount` 走默认 1，会让 core 的百分位偏高。
 */
export interface FrequencyCorpusEntry {
  /** 词条 id（必须先存在于 `words`）。 */
  readonly wordId: string;
  /** 原始出现次数。 */
  readonly frequency: number;
  /** 降序名次（1 = 频次最高）。 */
  readonly rank: number;
  /** 并列组大小（含自身）。 */
  readonly equalCount: number;
}

/** 一次词频语料导入的输入。 */
export interface FrequencyCorpusInput {
  /** 考试/场景标签，例如 `CET4`。 */
  readonly exam: string;
  /** 语料版本，例如 `ngsl-1.2`。 */
  readonly corpusVersion: string;
  /** 来源 id（`sources.id`）。 */
  readonly sourceId: string;
  /** 语料总词数；来源没给出时为 `null`（不写 0 冒充统计过）。 */
  readonly totalTokens: number | null;
  /** 该版本中频次大于 0 的词条总数（percentile 的分母）。 */
  readonly knownWordCount: number;
  /** 全部条目，必须覆盖整份语料。 */
  readonly entries: readonly FrequencyCorpusEntry[];
}

/** 词条/词库/词频仓储契约（Task 5 直接消费）。 */
export interface WordRepository {
  createWord(input: WordInput): WordRecord;
  getWordById(id: string): WordRecord | null;
  getWordByLemma(lemma: string, ownerScope: string): WordRecord | null;
  listWordsByIds(ids: readonly string[]): WordRecord[];
  listSenses(wordId: string): WordSenseRecord[];
  upsertDeck(input: DeckInput): DeckRecord;
  getDeckById(id: string): DeckRecord | null;
  listDecks(ownerScope: string): DeckRecord[];
  addDeckWord(deckId: string, wordId: string, deviceId: string, now: Date): void;
  removeDeckWord(deckId: string, wordId: string, deviceId: string, now: Date): void;
  listDeckWordIds(deckId: string): string[];
  writeFrequencyCorpus(input: FrequencyCorpusInput): void;
  listFrequencyEntries(exam: string, corpusVersion: string): FrequencyEntry[];
}

/** 把词形标准化：去首尾空白、内部连续空白折叠为单个空格、转小写。 */
export function normalizeLemma(lemma: string): string {
  return lemma.trim().replace(/\s+/gu, ' ').toLowerCase();
}

/**
 * 校验并标准化词形。
 *
 * @param lemma 原词形。
 * @returns 标准化结果。
 * @throws {InvalidRepositoryInputError} 词形为空或不是字符串时。
 */
function requireNormalizedLemma(lemma: string): string {
  if (typeof lemma !== 'string' || lemma.trim() === '') {
    throw new InvalidRepositoryInputError('lemma', '词形必须是非空字符串');
  }
  return normalizeLemma(lemma);
}

/**
 * 校验非空字符串字段。
 *
 * @param value 待校验值。
 * @param field 字段名（用于错误定位）。
 * @returns 原值。
 * @throws {InvalidRepositoryInputError} 不是非空字符串时。
 */
function requireNonEmptyString(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidRepositoryInputError(field, '必须是非空字符串');
  }
  return value;
}

/**
 * 校验注入的时间。
 *
 * @param now 时间。
 * @returns UTC ISO-8601 字符串。
 * @throws {InvalidRepositoryInputError} 不是有效 Date 时。
 */
function toIsoInstant(now: Date, field = 'now'): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new InvalidRepositoryInputError(field, `${field} 必须是有效 Date`);
  }
  return now.toISOString();
}

/** 生成一个新的 uuid（不依赖 `node:crypto`）。 */
function newId(): string {
  return globalThis.crypto.randomUUID();
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
  deleted_at: string | null;
  device_id: string;
  revision: number;
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
  updated_at: string;
  deleted_at: string | null;
  device_id: string;
  revision: number;
}

/** `decks` 行的 snake_case 形状。 */
interface DeckRow {
  id: string;
  owner_scope: string;
  name: string;
  kind: DeckKind;
  source_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  device_id: string;
  revision: number;
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
    deletedAt: row.deleted_at,
    deviceId: row.device_id,
    revision: row.revision,
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
    sourceId: row.source_id ?? '',
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    deviceId: row.device_id,
    revision: row.revision,
  };
}

/** 行 → 词库记录。 */
function toDeckRecord(row: DeckRow): DeckRecord {
  return {
    id: row.id,
    ownerScope: row.owner_scope,
    name: row.name,
    kind: row.kind,
    sourceId: row.source_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    deviceId: row.device_id,
    revision: row.revision,
  };
}

/**
 * 校验词频语料的自洽性（纯函数，便于直接单测）。
 *
 * 三条规则，各自对应一种真实事故：
 * 1. **并列数必须如实写入**：同频次组内每一行的 `equalCount` 必须等于组大小；
 *    组大小 > 1 而行里仍是默认值 1 时单独报 `TIE_GROUP_DEFAULT`——这是导入脚本
 *    “只算了名次、没算并列”的典型症状，会让 core 的百分位**偏高**。
 * 2. **名次必须连续且是 competition rank**：按 frequency 降序分组后，
 *    第 k 组的 `rank` 必须等于 `1 + 前面各组大小之和`。
 * 3. **必须覆盖整份语料**：不同词的个数必须等于 `knownWordCount`。
 *
 * **关于 `SUM(equal_count) == knownWordCount` 这个字面口径（重要）**：
 * `equal_count` 存在**每个词各自一行**上，等于它所在并列组的大小 `s`。
 * 一个组有 `s` 个词时，按行求和得到 `Σ s²`；只有 `s = 1`（无并列）时才等于词数 `n`。
 * 例：两个词并列成一组、各写 `equal_count = 2`，行求和是 4，而词数是 2。
 * 因此“按行 SUM == knownWordCount”会**禁止一切并列**，与 `equal_count` 的用途自相矛盾；
 * 真正等价于 `n` 的是**按组求和**（每组只计一次组大小），也就是本函数的规则 1 + 3。
 * 无并列时两者完全一致（`Σ 1 = n`），不影响原有校验强度。
 *
 * @param entries 全部条目。
 * @param knownWordCount 语料中频次大于 0 的词条总数。
 * @throws {FrequencyCorpusMismatchError} 任一规则不满足时（`kind` 区分具体失配）。
 */
export function assertFrequencyCorpusConsistent(
  entries: readonly FrequencyCorpusEntry[],
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

  const byFrequency = new Map<number, FrequencyCorpusEntry[]>();
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
    if (!Number.isInteger(entry.frequency) || entry.frequency < 0) {
      throw new FrequencyCorpusMismatchError(
        'RANK_GAP',
        `frequency 必须是非负整数，收到 ${String(entry.frequency)}（wordId=${entry.wordId}）`,
        `wordId=${entry.wordId}`,
      );
    }
    if (!Number.isInteger(entry.rank) || entry.rank < 1) {
      throw new FrequencyCorpusMismatchError(
        'RANK_GAP',
        `rank 必须是 >=1 的整数，收到 ${String(entry.rank)}（wordId=${entry.wordId}）`,
        `wordId=${entry.wordId}`,
      );
    }
    if (!Number.isInteger(entry.equalCount) || entry.equalCount < 1) {
      throw new FrequencyCorpusMismatchError(
        'EQUAL_COUNT_MISMATCH',
        `equalCount 必须是 >=1 的整数，收到 ${String(entry.equalCount)}（wordId=${entry.wordId}）`,
        `wordId=${entry.wordId}`,
      );
    }
    const group = byFrequency.get(entry.frequency);
    if (group === undefined) {
      byFrequency.set(entry.frequency, [entry]);
    } else {
      group.push(entry);
    }
  }

  const frequencies = [...byFrequency.keys()].sort((left, right) => right - left);
  let expectedRank = 1;
  for (const frequency of frequencies) {
    const group = byFrequency.get(frequency) ?? [];
    const groupSize = group.length;
    for (const entry of group) {
      if (entry.rank !== expectedRank) {
        throw new FrequencyCorpusMismatchError(
          'RANK_GAP',
          `rank gap at frequency=${frequency} expected=${expectedRank} actual=${entry.rank}`,
          `frequency=${frequency},wordId=${entry.wordId},expected=${expectedRank},actual=${entry.rank}`,
        );
      }
      if (groupSize > 1 && entry.equalCount === 1) {
        throw new FrequencyCorpusMismatchError(
          'TIE_GROUP_DEFAULT',
          `equal_count mismatch at frequency=${frequency} expected=${groupSize} actual=1（并列组未写入真实并列数）`,
          `frequency=${frequency},wordId=${entry.wordId},groupSize=${groupSize}`,
        );
      }
      if (entry.equalCount !== groupSize) {
        throw new FrequencyCorpusMismatchError(
          'EQUAL_COUNT_MISMATCH',
          `equal_count mismatch at frequency=${frequency} expected=${groupSize} actual=${entry.equalCount}`,
          `frequency=${frequency},wordId=${entry.wordId},groupSize=${groupSize},actual=${entry.equalCount}`,
        );
      }
    }
    expectedRank += groupSize;
  }

  if (seenWordIds.size !== knownWordCount || entries.length !== knownWordCount) {
    throw new FrequencyCorpusMismatchError(
      'TOTAL_MISMATCH',
      `knownWordCount mismatch expected=${knownWordCount} actual=${seenWordIds.size}`,
      `distinctWords=${seenWordIds.size},rows=${entries.length},knownWordCount=${knownWordCount}`,
    );
  }
}

/**
 * 创建词条/词库/词频仓储。
 *
 * @param db 已迁移的连接。
 * @returns 仓储实例。
 */
export function createWordRepository(db: SqliteDatabase): WordRepository {
  const WORD_COLUMNS = `id, owner_scope, lemma, normalized_lemma, language, phonetic_uk, phonetic_us,
                        created_at, updated_at, deleted_at, device_id, revision`;
  const selectWordByNormalized = db.prepare(
    `SELECT ${WORD_COLUMNS} FROM words
      WHERE owner_scope = ? AND normalized_lemma = ? AND deleted_at IS NULL`,
  );
  const selectWordById = db.prepare(`SELECT ${WORD_COLUMNS} FROM words WHERE id = ?`);
  const insertWord = db.prepare(
    `INSERT INTO words
       (id, owner_scope, lemma, normalized_lemma, language, phonetic_uk, phonetic_us,
        created_at, updated_at, deleted_at, device_id, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0)`,
  );
  const updateWord = db.prepare(
    `UPDATE words
        SET lemma = ?, language = ?, phonetic_uk = ?, phonetic_us = ?,
            updated_at = ?, device_id = ?, revision = revision + 1
      WHERE id = ?`,
  );
  const SENSE_COLUMNS = `id, word_id, sense_no, pos, simple_zh, detailed_zh, context_text, source_id,
                         updated_at, deleted_at, device_id, revision`;
  const selectSense = db.prepare(
    `SELECT ${SENSE_COLUMNS} FROM word_senses
      WHERE word_id = ? AND sense_no = ? AND ifnull(source_id, '') = ? AND deleted_at IS NULL`,
  );
  const insertSense = db.prepare(
    `INSERT INTO word_senses
       (id, word_id, sense_no, pos, simple_zh, detailed_zh, context_text, source_id,
        created_at, updated_at, deleted_at, device_id, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0)`,
  );
  const updateSense = db.prepare(
    `UPDATE word_senses
        SET pos = ?, simple_zh = ?, detailed_zh = ?, context_text = ?,
            updated_at = ?, device_id = ?, revision = revision + 1
      WHERE id = ?`,
  );
  const selectSenses = db.prepare(
    `SELECT ${SENSE_COLUMNS} FROM word_senses
      WHERE word_id = ? AND deleted_at IS NULL
      ORDER BY sense_no ASC, id ASC`,
  );
  const DECK_COLUMNS = `id, owner_scope, name, kind, source_id, created_at, updated_at, deleted_at,
                        device_id, revision`;
  const selectDeckById = db.prepare(`SELECT ${DECK_COLUMNS} FROM decks WHERE id = ?`);
  const insertDeck = db.prepare(
    `INSERT INTO decks
       (id, owner_scope, name, kind, source_id, created_at, updated_at, deleted_at, device_id, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 0)`,
  );
  const updateDeck = db.prepare(
    `UPDATE decks
        SET name = ?, kind = ?, source_id = ?, updated_at = ?, device_id = ?,
            deleted_at = NULL, revision = revision + 1
      WHERE id = ?`,
  );
  const selectDecks = db.prepare(
    `SELECT ${DECK_COLUMNS} FROM decks
      WHERE owner_scope = ? AND deleted_at IS NULL
      ORDER BY created_at ASC, id ASC`,
  );
  const upsertDeckWord = db.prepare(
    `INSERT INTO deck_words (deck_id, word_id, added_at, updated_at, deleted_at, device_id, revision)
     VALUES (?, ?, ?, ?, NULL, ?, 0)
     ON CONFLICT (deck_id, word_id) DO UPDATE SET
       updated_at = excluded.updated_at,
       deleted_at = NULL,
       device_id = excluded.device_id,
       revision = deck_words.revision + 1`,
  );
  const softDeleteDeckWord = db.prepare(
    `UPDATE deck_words
        SET deleted_at = ?, updated_at = ?, device_id = ?, revision = revision + 1
      WHERE deck_id = ? AND word_id = ? AND deleted_at IS NULL`,
  );
  const selectDeckWordIds = db.prepare(
    `SELECT word_id FROM deck_words
      WHERE deck_id = ? AND deleted_at IS NULL
      ORDER BY added_at ASC, word_id ASC`,
  );
  const upsertFrequencyEntry = db.prepare(
    // `created_at` 由 SQLite 生成：语料导入的输入里没有注入时钟（见 brief §4.1），
    // 而本包禁止 `new Date()`；重复导入时保留首次写入时间。
    `INSERT INTO frequency_entries
       (word_id, exam, corpus_version, frequency, total_tokens, rank, equal_count, source_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (word_id, exam, corpus_version, source_id) DO UPDATE SET
       frequency = excluded.frequency,
       total_tokens = excluded.total_tokens,
       rank = excluded.rank,
       equal_count = excluded.equal_count`,
  );
  const selectFrequencyEntries = db.prepare(
    `SELECT word_id, frequency, rank, equal_count, corpus_version, source_id
       FROM frequency_entries
      WHERE exam = ? AND corpus_version = ?
      ORDER BY rank ASC, word_id ASC`,
  );

  return {
    createWord(input: WordInput): WordRecord {
      if (input === null || typeof input !== 'object') {
        throw new InvalidRepositoryInputError('input', '词条输入不能为空');
      }
      const normalizedLemma = requireNormalizedLemma(input.lemma);
      const ownerScope = assertValidOwnerScope(input.ownerScope);
      const deviceId = requireNonEmptyString(input.deviceId, 'deviceId');
      const nowIso = toIsoInstant(input.now);
      const lemma = input.lemma.trim();
      const language = input.language ?? 'en';
      const phoneticUk = input.phoneticUk ?? null;
      const phoneticUs = input.phoneticUs ?? null;
      const senses: readonly SenseInput[] = Array.isArray(input.senses) ? input.senses : [];

      return runInTransaction(
        db,
        () => {
          const existing = selectWordByNormalized.get(ownerScope, normalizedLemma) as
            | WordRow
            | undefined;
          let wordId: string;
          if (existing === undefined) {
            wordId = input.id ?? newId();
            insertWord.run(
              wordId,
              ownerScope,
              lemma,
              normalizedLemma,
              language,
              phoneticUk,
              phoneticUs,
              nowIso,
              nowIso,
              deviceId,
            );
          } else {
            // 幂等：同一个词再次导入时更新可变字段并补齐义项，而不是撞唯一键。
            wordId = existing.id;
            updateWord.run(lemma, language, phoneticUk, phoneticUs, nowIso, deviceId, wordId);
          }

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
            const sourceId = requireNonEmptyString(sense.sourceId, 'senses.sourceId');
            const pos = sense.pos ?? '';
            const simpleZh = sense.simpleZh.trim();
            const detailedZh = sense.detailedZh ?? null;
            const contextText = sense.contextText ?? null;

            const present = selectSense.get(wordId, senseNo, sourceId) as WordSenseRow | undefined;
            if (present === undefined) {
              insertSense.run(
                newId(),
                wordId,
                senseNo,
                pos,
                simpleZh,
                detailedZh,
                contextText,
                sourceId,
                nowIso,
                nowIso,
                deviceId,
              );
              return;
            }
            updateSense.run(pos, simpleZh, detailedZh, contextText, nowIso, deviceId, present.id);
          });

          const row = selectWordById.get(wordId) as WordRow | undefined;
          if (row === undefined) {
            throw new InvalidRepositoryInputError('id', `词条写入后回读失败（id=${wordId}）`);
          }
          return toWordRecord(row);
        },
        { mode: 'IMMEDIATE' },
      );
    },

    getWordById(id: string): WordRecord | null {
      requireNonEmptyString(id, 'id');
      const row = selectWordById.get(id) as WordRow | undefined;
      if (row === undefined || row.deleted_at !== null) {
        return null;
      }
      return toWordRecord(row);
    },

    getWordByLemma(lemma: string, ownerScope: string): WordRecord | null {
      const normalizedLemma = requireNormalizedLemma(lemma);
      const scope = assertValidOwnerScope(ownerScope);
      const row = selectWordByNormalized.get(scope, normalizedLemma) as WordRow | undefined;
      return row === undefined ? null : toWordRecord(row);
    },

    listWordsByIds(ids: readonly string[]): WordRecord[] {
      if (!Array.isArray(ids)) {
        throw new InvalidRepositoryInputError('ids', 'ids 必须是数组');
      }
      const records: WordRecord[] = [];
      for (const id of ids) {
        if (typeof id !== 'string' || id.trim() === '') {
          continue;
        }
        const row = selectWordById.get(id) as WordRow | undefined;
        if (row === undefined || row.deleted_at !== null) {
          continue;
        }
        records.push(toWordRecord(row));
      }
      return records;
    },

    listSenses(wordId: string): WordSenseRecord[] {
      requireNonEmptyString(wordId, 'wordId');
      const rows = selectSenses.all(wordId) as WordSenseRow[];
      return rows.map(toSenseRecord);
    },

    upsertDeck(input: DeckInput): DeckRecord {
      if (input === null || typeof input !== 'object') {
        throw new InvalidRepositoryInputError('input', '词库输入不能为空');
      }
      const ownerScope = assertValidOwnerScope(input.ownerScope);
      const name = requireNonEmptyString(input.name, 'name').trim();
      const deviceId = requireNonEmptyString(input.deviceId, 'deviceId');
      const nowIso = toIsoInstant(input.now);
      if (input.kind !== 'BUILTIN' && input.kind !== 'CUSTOM' && input.kind !== 'NOTEBOOK') {
        throw new InvalidRepositoryInputError('kind', `未知词库类型：${String(input.kind)}`);
      }
      const sourceId = input.sourceId ?? null;

      return runInTransaction(
        db,
        () => {
          const existing = selectDeckById.get(input.id ?? '') as DeckRow | undefined;
          if (existing === undefined) {
            const deckId = input.id ?? newId();
            insertDeck.run(deckId, ownerScope, name, input.kind, sourceId, nowIso, nowIso, deviceId);
            const created = selectDeckById.get(deckId) as DeckRow | undefined;
            if (created === undefined) {
              throw new InvalidRepositoryInputError('id', `词库写入后回读失败（id=${deckId}）`);
            }
            return toDeckRecord(created);
          }
          if (existing.owner_scope !== ownerScope) {
            throw new InvalidRepositoryInputError(
              'ownerScope',
              `词库 ${existing.id} 属于 ${existing.owner_scope}，不能写入 ${ownerScope}`,
            );
          }
          updateDeck.run(name, input.kind, sourceId, nowIso, deviceId, existing.id);
          const updated = selectDeckById.get(existing.id) as DeckRow | undefined;
          if (updated === undefined) {
            throw new InvalidRepositoryInputError('id', `词库更新后回读失败（id=${existing.id}）`);
          }
          return toDeckRecord(updated);
        },
        { mode: 'IMMEDIATE' },
      );
    },

    getDeckById(id: string): DeckRecord | null {
      requireNonEmptyString(id, 'id');
      const row = selectDeckById.get(id) as DeckRow | undefined;
      if (row === undefined || row.deleted_at !== null) {
        return null;
      }
      return toDeckRecord(row);
    },

    listDecks(ownerScope: string): DeckRecord[] {
      const scope = assertValidOwnerScope(ownerScope);
      const rows = selectDecks.all(scope) as DeckRow[];
      return rows.map(toDeckRecord);
    },

    addDeckWord(deckId: string, wordId: string, deviceId: string, now: Date): void {
      requireNonEmptyString(deckId, 'deckId');
      requireNonEmptyString(wordId, 'wordId');
      requireNonEmptyString(deviceId, 'deviceId');
      const nowIso = toIsoInstant(now);
      runInTransaction(
        db,
        () => {
          // 已存在且未被软删时是空操作（重复收藏不该改 revision，否则同步会一直有变更）。
          const alive = db
            .prepare(
              'SELECT 1 FROM deck_words WHERE deck_id = ? AND word_id = ? AND deleted_at IS NULL',
            )
            .get(deckId, wordId);
          if (alive !== undefined) {
            return;
          }
          upsertDeckWord.run(deckId, wordId, nowIso, nowIso, deviceId);
        },
        { mode: 'IMMEDIATE' },
      );
    },

    removeDeckWord(deckId: string, wordId: string, deviceId: string, now: Date): void {
      requireNonEmptyString(deckId, 'deckId');
      requireNonEmptyString(wordId, 'wordId');
      requireNonEmptyString(deviceId, 'deviceId');
      const nowIso = toIsoInstant(now);
      runInTransaction(
        db,
        () => {
          softDeleteDeckWord.run(nowIso, nowIso, deviceId, deckId, wordId);
        },
        { mode: 'IMMEDIATE' },
      );
    },

    listDeckWordIds(deckId: string): string[] {
      requireNonEmptyString(deckId, 'deckId');
      const rows = selectDeckWordIds.all(deckId) as { word_id: string }[];
      return rows.map((row) => row.word_id);
    },

    writeFrequencyCorpus(input: FrequencyCorpusInput): void {
      if (input === null || typeof input !== 'object') {
        throw new InvalidRepositoryInputError('input', '词频语料输入不能为空');
      }
      const exam = requireNonEmptyString(input.exam, 'exam');
      const corpusVersion = requireNonEmptyString(input.corpusVersion, 'corpusVersion');
      const sourceId = requireNonEmptyString(input.sourceId, 'sourceId');
      const entries: readonly FrequencyCorpusEntry[] = Array.isArray(input.entries)
        ? input.entries
        : [];
      if (input.totalTokens !== null) {
        if (
          typeof input.totalTokens !== 'number' ||
          !Number.isInteger(input.totalTokens) ||
          input.totalTokens < 0
        ) {
          throw new InvalidRepositoryInputError(
            'totalTokens',
            `totalTokens 必须是非负整数或 null，收到 ${String(input.totalTokens)}`,
          );
        }
      }

      // 先做纯校验（不碰库），再进事务写入：任一失配都不留半份语料。
      assertFrequencyCorpusConsistent(entries, input.knownWordCount);

      runInTransaction(
        db,
        () => {
          for (const entry of entries) {
            upsertFrequencyEntry.run(
              entry.wordId,
              exam,
              corpusVersion,
              entry.frequency,
              input.totalTokens,
              entry.rank,
              entry.equalCount,
              sourceId,
            );
          }
        },
        { mode: 'IMMEDIATE' },
      );
    },

    listFrequencyEntries(exam: string, corpusVersion: string): FrequencyEntry[] {
      const examKey = requireNonEmptyString(exam, 'exam');
      const versionKey = requireNonEmptyString(corpusVersion, 'corpusVersion');
      const rows = selectFrequencyEntries.all(examKey, versionKey) as {
        word_id: string;
        frequency: number;
        rank: number | null;
        equal_count: number;
        corpus_version: string;
        source_id: string;
      }[];
      return rows.map((row) => {
        const entry: FrequencyEntry = {
          wordId: row.word_id,
          frequency: row.frequency,
          corpusVersion: row.corpus_version,
          sourceId: row.source_id,
        };
        if (row.rank !== null) {
          entry.rank = row.rank;
        }
        entry.equalCount = row.equal_count;
        return entry;
      });
    },
  };
}
