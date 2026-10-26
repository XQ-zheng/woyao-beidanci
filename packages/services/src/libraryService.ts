/**
 * 词库、单词与词频读取服务。
 *
 * 三层职责切得很干净：
 * - **数据层**负责标准化、幂等与事务（`createWord` 已经是 create-or-update）；
 * - **core** 负责所有业务规则（这里是词频重要性分级）；
 * - **服务层**只做：取数 → 组装视图 → 校验入参 → 决定“找不到 / 冲突”的错误语义。
 *
 * 特别注意词频这条线：`classifyFrequencyImportance` 要的 `knownWordCount` 是
 * **该语料版本里有频率的词条总数**，不是当前词库的词数。用词库词数当分母，
 * 会让小词库里的常见词被误判成“高频”，这是需求里明确禁止的“虚报重要性”。
 */

import { classifyFrequencyImportance, type FrequencyEntry } from '@woyao/core';
import { LOCAL_OWNER_SCOPE, type DeckKind, type DeckRecord, type WordRecord } from '@woyao/data';

import {
  LOCAL_USER_SOURCE_ID,
  NOTEBOOK_DECK_NAME,
  createDeckInputSchema,
  createWordInputSchema,
  getFrequencyInputSchema,
  listDeckWordsInputSchema,
  parseOrThrow,
  renameDeckInputSchema,
  type CreateWordInput,
  type CreatedWordView,
  type DeckSummary,
  type DeckWordView,
  type FrequencyView,
} from './dto';
import { ServiceConflictError, ServiceNotFoundError } from './errors';
import type { ServiceContext } from './ports';

/** 词库服务契约。 */
export interface LibraryService {
  /** 列出当前归属范围内的词库（含种类与词数）。 */
  listDecks(): Promise<DeckSummary[]>;
  /** 新建自建词库（`kind` 默认 `CUSTOM`）。 */
  createDeck(input: { name: string; kind?: 'CUSTOM' | 'NOTEBOOK' }): Promise<DeckSummary>;
  /** 重命名；找不到抛 `ServiceNotFoundError`。 */
  renameDeck(input: { deckId: string; name: string }): Promise<DeckSummary>;
  /** 软删除；删除后 `listDecks` 不再返回它，但词库里的词与历史事件都还在。 */
  deleteDeck(deckId: string): Promise<void>;
  /** 列出词库里的词（按加入顺序），可带语料版本以附加词频分级。 */
  listDeckWords(input: {
    deckId: string;
    exam?: string;
    corpusVersion?: string;
  }): Promise<DeckWordView[]>;
  /** 收藏到生词本（幂等）。 */
  addWordToNotebook(wordId: string): Promise<void>;
  /** 从生词本移除（幂等）。 */
  removeWordFromNotebook(wordId: string): Promise<void>;
  /** 是否在生词本里。 */
  isInNotebook(wordId: string): Promise<boolean>;
  /** 自建词（含多义项）；重复词返回既有记录并标记 `created: false`。 */
  createWord(input: CreateWordInput): Promise<CreatedWordView>;
  /** 读一个词在指定语料里的重要性。 */
  getFrequency(input: { wordId: string; exam: string; corpusVersion: string }): Promise<FrequencyView>;
}

/** 构造参数。 */
export interface LibraryServiceOptions {
  readonly context: ServiceContext;
  /** 归属范围：未登录用 `LOCAL`，登录后用 `acct:<id>`。缺省 `LOCAL`。 */
  readonly ownerScope?: string;
}

/** 一次词频查询的结果（避免为每个词都去读一遍整份语料）。 */
interface FrequencyLookup {
  readonly byWordId: ReadonlyMap<string, FrequencyEntry>;
  readonly knownWordCount: number;
}

/** 没有语料上下文时的词频视图（**不把未知当低频**）。 */
const UNKNOWN_FREQUENCY: FrequencyView = {
  importance: 'UNKNOWN',
  frequency: null,
  rank: null,
  totalTokens: null,
  corpusVersion: null,
  sourceId: null,
};

/**
 * 判断一个异常是否是 SQLite 外键约束失败。
 *
 * 服务层不 import `better-sqlite3`（那是数据层的实现细节），但错误码是 SQLite 的稳定契约，
 * 按 `code` 判断比匹配 message 可靠得多。
 *
 * @param error 捕获到的异常。
 * @returns 是否外键约束失败。
 */
function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_FOREIGNKEY'
  );
}

/**
 * 创建词库服务。
 *
 * @param options 上下文与归属范围。
 * @returns 词库服务实例。
 */
export function createLibraryService(options: LibraryServiceOptions): LibraryService {
  const { context } = options;
  const ownerScope = options.ownerScope ?? LOCAL_OWNER_SCOPE;

  /** 读一份语料，建成 `wordId → entry` 的索引。 */
  async function loadFrequencyLookup(exam: string, corpusVersion: string): Promise<FrequencyLookup> {
    const entries = await context.repos.words.listFrequencyEntries(exam, corpusVersion);
    const byWordId = new Map<string, FrequencyEntry>();
    for (const entry of entries) {
      byWordId.set(entry.wordId, entry);
    }
    // 分母是**该语料版本里有频率的词条总数**，不是词库词数（见文件头注释）。
    return { byWordId, knownWordCount: entries.length };
  }

  /**
   * 组装词频视图。
   *
   * @param lookup 语料索引；`null` 表示调用方没给 exam/corpusVersion。
   * @param wordId 词条 id。
   * @returns 词频视图。
   */
  function toFrequencyView(lookup: FrequencyLookup | null, wordId: string): FrequencyView {
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
      // 数据层的 `listFrequencyEntries` 目前不返回 `total_tokens`（见 dto 的说明）。
      totalTokens: null,
      corpusVersion: entry.corpusVersion,
      sourceId: entry.sourceId,
    };
  }

  /** 行 → 摘要（词数按 `deck_words` 里未软删的行数算）。 */
  async function toDeckSummary(deck: DeckRecord): Promise<DeckSummary> {
    const wordIds = await context.repos.words.listDeckWordIds(deck.id);
    return {
      deckId: deck.id,
      name: deck.name,
      kind: deck.kind,
      wordCount: wordIds.length,
      createdAt: deck.createdAt,
      updatedAt: deck.updatedAt,
    };
  }

  /** 词条 + 词频 → 展示视图。 */
  async function toDeckWordView(word: WordRecord, frequency: FrequencyView): Promise<DeckWordView> {
    const senses = await context.repos.words.listSenses(word.id);
    return {
      wordId: word.id,
      lemma: word.lemma,
      phoneticUk: word.phoneticUk,
      phoneticUs: word.phoneticUs,
      senses: senses.map((sense) => ({
        senseNo: sense.senseNo,
        pos: sense.pos,
        simpleZh: sense.simpleZh,
        detailedZh: sense.detailedZh,
        contextText: sense.contextText,
      })),
      frequency,
    };
  }

  /** 找当前归属范围内的生词本；`create` 为真时缺了就建。 */
  async function findNotebookDeck(create: boolean): Promise<DeckRecord | null> {
    const decks = await context.repos.words.listDecks(ownerScope);
    const existing = decks.find((deck) => deck.kind === 'NOTEBOOK');
    if (existing !== undefined) {
      return existing;
    }
    if (!create) {
      return null;
    }
    // 生词本是“隐式词库”：用户点收藏时才出现，不需要先手动建一个词库。
    return context.repos.words.upsertDeck({
      ownerScope,
      name: NOTEBOOK_DECK_NAME,
      kind: 'NOTEBOOK',
      deviceId: context.device.deviceId(),
      now: context.clock.now(),
    });
  }

  /** 词条不存在时报 `NOT_FOUND`（而不是让外键抛一句 SQL 错误）。 */
  async function requireWord(wordId: string): Promise<WordRecord> {
    const word = await context.repos.words.getWordById(wordId);
    if (word === null) {
      throw new ServiceNotFoundError('word', wordId);
    }
    return word;
  }

  return {
    async listDecks(): Promise<DeckSummary[]> {
      const decks = await context.repos.words.listDecks(ownerScope);
      return Promise.all(decks.map((deck) => toDeckSummary(deck)));
    },

    async createDeck(input: { name: string; kind?: 'CUSTOM' | 'NOTEBOOK' }): Promise<DeckSummary> {
      const validated = parseOrThrow(createDeckInputSchema, input, '建库');
      const kind: DeckKind = validated.kind ?? 'CUSTOM';
      const deck = await context.repos.words.upsertDeck({
        ownerScope,
        name: validated.name,
        kind,
        deviceId: context.device.deviceId(),
        now: context.clock.now(),
      });
      return toDeckSummary(deck);
    },

    async renameDeck(input: { deckId: string; name: string }): Promise<DeckSummary> {
      const validated = parseOrThrow(renameDeckInputSchema, input, '重命名词库');
      const existing = await context.repos.words.getDeckById(validated.deckId);
      if (existing === null) {
        throw new ServiceNotFoundError('deck', validated.deckId);
      }
      const deck = await context.repos.words.upsertDeck({
        id: existing.id,
        ownerScope: existing.ownerScope,
        name: validated.name,
        kind: existing.kind,
        sourceId: existing.sourceId,
        deviceId: context.device.deviceId(),
        now: context.clock.now(),
      });
      return toDeckSummary(deck);
    },

    async deleteDeck(deckId: string): Promise<void> {
      if (typeof deckId !== 'string' || deckId.trim() === '') {
        throw new ServiceNotFoundError('deck', String(deckId));
      }
      const existing = await context.repos.words.getDeckById(deckId);
      if (existing === null) {
        throw new ServiceNotFoundError('deck', deckId);
      }
      await context.repos.words.deleteDeck(deckId, context.device.deviceId(), context.clock.now());
    },

    async listDeckWords(input: {
      deckId: string;
      exam?: string;
      corpusVersion?: string;
    }): Promise<DeckWordView[]> {
      const validated = parseOrThrow(listDeckWordsInputSchema, input, '查询词库单词');
      // 这里**不**因为“词库被软删”就报 NOT_FOUND：软删除只隐藏词库这个“目录项”，
      // 词库里的词、收藏关系与学习历史都还在（需求要求软删不级联硬删）。
      // 代价是拼错 id 会返回空数组而不是错误——所以 `listDecks` 才是目录的权威来源，
      // `renameDeck` / `deleteDeck` 这些**写操作**仍然会先查存在性并抛 NOT_FOUND。
      const wordIds = await context.repos.words.listDeckWordIds(validated.deckId);
      // `listWordsByIds` 保持入参顺序（Task 4 已保证），因此这里的顺序就是“加入顺序”。
      const words = await context.repos.words.listWordsByIds(wordIds);
      const lookup =
        validated.exam !== undefined && validated.corpusVersion !== undefined
          ? await loadFrequencyLookup(validated.exam, validated.corpusVersion)
          : null;

      // 先并行取义项再按词序组装：`Promise.all` 保证结果顺序与入参一致。
      const sensesPerWord = await Promise.all(
        words.map((word) => context.repos.words.listSenses(word.id)),
      );
      return words.map((word, index) => ({
        wordId: word.id,
        lemma: word.lemma,
        phoneticUk: word.phoneticUk,
        phoneticUs: word.phoneticUs,
        senses: sensesPerWord[index].map((sense) => ({
          senseNo: sense.senseNo,
          pos: sense.pos,
          simpleZh: sense.simpleZh,
          detailedZh: sense.detailedZh,
          contextText: sense.contextText,
        })),
        frequency: toFrequencyView(lookup, word.id),
      }));
    },

    async addWordToNotebook(wordId: string): Promise<void> {
      await requireWord(wordId);
      const notebook = await findNotebookDeck(true);
      if (notebook === null) {
        // `create: true` 时不可能为 null；写成显式分支是为了让“类型上可能为 null”不变成 `!`。
        throw new ServiceConflictError('notebook', '生词本创建失败');
      }
      // `addDeckWord` 对“已存在且未删除”的行是空操作，因此连续收藏两次不会改 revision、也不会报错。
      await context.repos.words.addDeckWord(
        notebook.id,
        wordId,
        context.device.deviceId(),
        context.clock.now(),
      );
    },

    async removeWordFromNotebook(wordId: string): Promise<void> {
      const notebook = await findNotebookDeck(false);
      if (notebook === null) {
        // 没有生词本 = 本来就不在里面，按幂等语义直接成功。
        return;
      }
      await context.repos.words.removeDeckWord(
        notebook.id,
        wordId,
        context.device.deviceId(),
        context.clock.now(),
      );
    },

    async isInNotebook(wordId: string): Promise<boolean> {
      const notebook = await findNotebookDeck(false);
      if (notebook === null) {
        return false;
      }
      const wordIds = await context.repos.words.listDeckWordIds(notebook.id);
      return wordIds.includes(wordId);
    },

    async createWord(input: CreateWordInput): Promise<CreatedWordView> {
      const validated = parseOrThrow(createWordInputSchema, input, '自建词');
      const scope = validated.ownerScope ?? ownerScope;
      const sourceId = validated.sourceId ?? LOCAL_USER_SOURCE_ID;

      // 先查后写，才能区分“新建”与“命中已有词”。`createWord` 本身是幂等的 create-or-update，
      // 但它的返回值里没有这个信息。
      const existing = await context.repos.words.getWordByLemma(validated.lemma, scope);

      let word: WordRecord;
      try {
        word = await context.repos.words.createWord({
          ...(validated.id === undefined ? {} : { id: validated.id }),
          ownerScope: scope,
          lemma: validated.lemma,
          ...(validated.language === undefined ? {} : { language: validated.language }),
          phoneticUk: validated.phoneticUk ?? null,
          phoneticUs: validated.phoneticUs ?? null,
          senses: validated.senses.map((sense, index) => ({
            senseNo: sense.senseNo ?? index + 1,
            pos: sense.pos,
            simpleZh: sense.simpleZh,
            detailedZh: sense.detailedZh ?? null,
            contextText: sense.contextText ?? null,
            sourceId,
          })),
          deviceId: context.device.deviceId(),
          now: context.clock.now(),
        });
      } catch (error: unknown) {
        if (isForeignKeyViolation(error)) {
          // 自建词的义项必须挂在一个来源上，而来源由导入脚本/引导流程创建（见 dto 的说明）。
          // 把它翻译成“环境没配好”，而不是让 UI 去解析 SQLite 的错误文本。
          throw new ServiceConflictError(
            'source',
            `内容来源 ${sourceId} 不存在：自建词需要先完成内容来源初始化`,
          );
        }
        throw error;
      }

      const lookup =
        validated.exam !== undefined && validated.corpusVersion !== undefined
          ? await loadFrequencyLookup(validated.exam, validated.corpusVersion)
          : null;
      const view = await toDeckWordView(word, toFrequencyView(lookup, word.id));
      return { ...view, created: existing === null };
    },

    async getFrequency(input: {
      wordId: string;
      exam: string;
      corpusVersion: string;
    }): Promise<FrequencyView> {
      const validated = parseOrThrow(getFrequencyInputSchema, input, '查询词频');
      const lookup = await loadFrequencyLookup(validated.exam, validated.corpusVersion);
      return toFrequencyView(lookup, validated.wordId);
    },
  };
}
