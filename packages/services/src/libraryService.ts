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

import {
  LOCAL_OWNER_SCOPE,
  type DeckKind,
  type DeckRecord,
  type WordRecord,
} from '@woyao/data';

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
import { ServiceConflictError, ServiceNotFoundError, ServiceValidationError } from './errors';
import { loadFrequencyLookup, toFrequencyView, type FrequencyLookup } from './frequencyView';
import type { ServiceContext } from './ports';
import { ensureUserSource as ensureLocalUserSource } from './sourceBootstrap';

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

  /** 读一份语料（实现见 `frequencyView.ts`，与 `studyService` 共用同一份口径）。 */
  async function loadLookup(exam: string, corpusVersion: string): Promise<FrequencyLookup> {
    return loadFrequencyLookup(context.repos.words, exam, corpusVersion);
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

  /**
   * 确保“本地自建内容来源”存在（实现见 `sourceBootstrap.ts`，与 `associationService` 共用）。
   *
   * 为什么必须在**写词之前**做：`word_senses.source_id` 有外键，来源表在 5A 之前
   * 一个写入口都没有，于是自建词的义项只能靠外键失败兜底——那等于“自建词库不可用”。
   * upsert 对内容一致的行**不写、不推 revision**，重复调用无副作用。
   *
   * @param sourceId 目标来源 id。
   */
  async function ensureUserSource(sourceId: string): Promise<void> {
    await ensureLocalUserSource(context, ownerScope, sourceId);
  }

  /**
   * 把义项序号补齐成 1..n，并拒绝重复。
   *
   * 为什么要在服务层拦：数据层按 `(wordId, senseNo, sourceId)` upsert，
   * 两个同号义项会**静默**后者覆盖前者——用户会发现自己填的义项少了一个，
   * 而界面上没有任何报错。宁可在这里报 `VALIDATION_FAILED`，让用户改序号。
   *
   * @param senses 已通过 zod 校验的义项。
   * @returns 补齐后的序号数组（与入参等长、同序）。
   * @throws {ServiceValidationError} 存在重复序号时。
   */
  function resolveSenseNos(senses: readonly { senseNo?: number }[]): number[] {
    const senseNos = senses.map((sense, index) => sense.senseNo ?? index + 1);
    const seen = new Set<number>();
    const duplicates = new Set<number>();
    for (const senseNo of senseNos) {
      if (seen.has(senseNo)) {
        duplicates.add(senseNo);
      }
      seen.add(senseNo);
    }
    if (duplicates.size > 0) {
      const repeated = [...duplicates].sort((left, right) => left - right);
      throw new ServiceValidationError(
        repeated.map((senseNo) => ({
          path: 'senses.senseNo',
          message: `义项序号 ${String(senseNo)} 重复：同一序号会覆盖前一个义项`,
        })),
        '自建词校验未通过',
      );
    }
    return senseNos;
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
          ? await loadLookup(validated.exam, validated.corpusVersion)
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
      const senseNos = resolveSenseNos(validated.senses);

      // 先查后写，才能区分“新建”与“命中已有词”。`createWord` 本身是幂等的 create-or-update，
      // 但它的返回值里没有这个信息。
      const existing = await context.repos.words.getWordByLemma(validated.lemma, scope);

      // 写词之前先确保来源存在——这是“用户随时把不会的单词收入单词本/自建词库”的前提。
      // 默认来源（`local-user`）由服务层自建；调用方显式指定的来源则要求已存在（见下面的 catch）。
      if (validated.sourceId === undefined) {
        await ensureUserSource(sourceId);
      }

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
            senseNo: senseNos[index],
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
        // 这一层**不再**兜“默认来源缺失”：上一段已经 upsert 过，走不到这里。
        // 剩下的唯一可能是调用方显式传了一个不存在的 `sourceId`（导入/脚本场景），
        // 服务层没有 `getSourceById` 读口可以预检，于是把外键失败翻译成 CONFLICT，
        // 让 UI 知道“引用的来源不存在”，而不是漏一句 SQLite 错误出去。
        if (validated.sourceId !== undefined && isForeignKeyViolation(error)) {
          throw new ServiceConflictError(
            'source',
            `内容来源 ${sourceId} 不存在：显式指定的来源必须已由导入流程创建`,
          );
        }
        throw error;
      }

      const lookup =
        validated.exam !== undefined && validated.corpusVersion !== undefined
          ? await loadLookup(validated.exam, validated.corpusVersion)
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
      const lookup = await loadLookup(validated.exam, validated.corpusVersion);
      return toFrequencyView(lookup, validated.wordId);
    },
  };
}
