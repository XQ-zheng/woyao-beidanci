/**
 * 批量导入服务：把一批英文单词/短语导入到指定词库。
 *
 * 释义三级策略（用户需求：先查内置词典，查不到就用云端大模型给释义，
 * **不再产生「暂无释义」占位词条**）：
 * 1. 查本地内置词典（ECDICT 导入的词条，`LOCAL` 归属）→ 命中复用其中文义项；
 * 2. 词典没有 → 调云端 LLM（`context.llm.defineWord`）生成义项；
 * 3. LLM 也失败（离线/额度/解析失败）→ **跳过该词不导入**，在报告里列出原因，
 *    用户联网后重新导入即可补上。
 *
 * 已存在的占位词条（历史导入产生的「（暂无释义）」）再次导入时会自动用
 * 词典/LLM 补全义项（数据层 createWord 是 upsert，按 senseNo+sourceId 补齐）。
 */
import { LOCAL_OWNER_SCOPE } from '@woyao/data';
import { LOCAL_USER_SOURCE_ID, type SenseView } from './dto';
import { ServiceNotFoundError } from './errors';
import type { LibraryService } from './libraryService';
import type { ServiceContext } from './ports';
import { ensureUserSource } from './sourceBootstrap';

/** 一条待导入的条目。 */
export interface ImportTerm {
  /** 词形（单词或短语，保留大小写）。 */
  readonly lemma: string;
  /** 是否短语（决定 LLM 提示词与展示）。 */
  readonly phrase?: boolean;
}

/** 被跳过的条目（附原因）。 */
export interface SkippedTerm {
  readonly lemma: string;
  readonly reason: string;
}

/** 批量导入结果。 */
export interface ImportWordsResult {
  /** 新建的词条数（含 LLM 释义）。 */
  readonly imported: number;
  /** 已存在且已有释义的词条数（直接复用，不重复计数）。 */
  readonly duplicates: number;
  /** 历史占位词条被补全释义的数量。 */
  readonly backfilled: number;
  /** 被跳过的条目（LLM 失败等），附原因。 */
  readonly skipped: ReadonlyArray<SkippedTerm>;
  /** 每条的结果（供 UI 展示详情）。 */
  readonly rows: ReadonlyArray<{
    readonly lemma: string;
    readonly imported: boolean;
    readonly backfilled: boolean;
    readonly senses: readonly SenseView[];
  }>;
}

/** 导入服务契约。 */
export interface ImportService {
  /** 把一批词/短语导入到指定词库。 */
  importWords(input: { deckId: string; terms: readonly ImportTerm[] }): Promise<ImportWordsResult>;
}

/** 构造参数。 */
export interface ImportServiceOptions {
  readonly context: ServiceContext;
  readonly library: LibraryService;
  /** 归属范围，与 library 保持一致。 */
  readonly ownerScope?: string;
}

/** 内置词典的义项 source id（ECDICT 导入脚本写死为 `builtin-ecdict`）。 */
const DICTIONARY_SOURCE_ID = 'builtin-ecdict';

/** 历史「无释义」占位义项的文案（旧版本导入产生的，本轮起不再新建）。 */
export const NO_DEFINITION_PLACEHOLDER = '（暂无释义）';

/** 命中词典时拿到的结果：义项 + 它们的来源 id。 */
interface DictionaryHit {
  readonly senses: SenseView[];
  /** 义项来源 id（词典词条自己的 sourceId，建词时原样复用）。 */
  readonly sourceId: string;
}

/**
 * 把内置词典词条的义项映射成 `SenseView`。
 *
 * 历史占位词条（义项全是「（暂无释义）」）也会被 `getWordByLemma` 命中——
 * 那不是有效词典释义，必须返回 null 让流程继续走 LLM 补全。
 *
 * @param context 服务上下文。
 * @param wordId 词典词条 id。
 * @returns 义项视图列表；没有有效义项返回 null。
 */
async function loadDictionarySenses(context: ServiceContext, wordId: string): Promise<DictionaryHit | null> {
  const senses = await context.repos.words.listSenses(wordId);
  const effective = senses.filter((sense) => sense.simpleZh !== NO_DEFINITION_PLACEHOLDER);
  if (effective.length === 0) {
    return null;
  }
  return {
    sourceId: effective[0]?.sourceId ?? DICTIONARY_SOURCE_ID,
    senses: effective.map((sense) => ({
      senseNo: sense.senseNo,
      pos: sense.pos,
      simpleZh: sense.simpleZh,
      detailedZh: sense.detailedZh ?? null,
      contextText: sense.contextText ?? null,
    })),
  };
}

/** 判断一组义项是否全是「无释义」占位。 */
function isPlaceholderSenses(senses: readonly SenseView[]): boolean {
  return senses.length > 0 && senses.every((sense) => sense.simpleZh === NO_DEFINITION_PLACEHOLDER);
}

/**
 * 创建批量导入服务。
 *
 * @param options 上下文、library 与归属范围。
 * @returns 导入服务实例。
 */
export function createImportService(options: ImportServiceOptions): ImportService {
  const { context, library } = options;
  const ownerScope = options.ownerScope ?? LOCAL_OWNER_SCOPE;

  return {
    async importWords(input): Promise<ImportWordsResult> {
      // 词库存在性校验：导入到不存在的词库应该直接失败，而不是建了一堆词才发现挂不上。
      const decks = await library.listDecks();
      const deck = decks.find((item) => item.deckId === input.deckId);
      if (deck === undefined) {
        throw new ServiceNotFoundError('deck', input.deckId);
      }

      const rows: Array<{
        readonly lemma: string;
        readonly imported: boolean;
        readonly backfilled: boolean;
        readonly senses: readonly SenseView[];
      }> = [];
      const skipped: Array<{ lemma: string; reason: string }> = [];
      let imported = 0;
      let duplicates = 0;
      let backfilled = 0;

      for (const term of input.terms) {
        const lemma = term.lemma.trim();
        if (lemma.length === 0) {
          continue;
        }

        // 1. 查内置词典补释义（LOCAL 归属下的词典词条）。
        let senses: SenseView[] = [];
        let sourceId: string | undefined;
        let fromDictionary = false;
        const dictionaryWord = await context.repos.words.getWordByLemma(lemma, LOCAL_OWNER_SCOPE);
        if (dictionaryWord !== null) {
          const hit = await loadDictionarySenses(context, dictionaryWord.id);
          if (hit !== null) {
            senses = hit.senses;
            sourceId = hit.sourceId;
            fromDictionary = true;
          }
        }

        // 2. 词典没有 → 云端 LLM 生成义项（联网；失败则跳过该词，不建占位词条）。
        if (fromDictionary === false && context.llm !== undefined) {
          try {
            const generated = await context.llm.defineWord({ lemma, phrase: term.phrase === true });
            senses = generated.map((sense, index) => ({
              senseNo: index + 1,
              pos: sense.pos,
              simpleZh: sense.simpleZh,
              detailedZh: sense.detailedZh,
              contextText: null,
            }));
          } catch (cause: unknown) {
            skipped.push({
              lemma,
              reason: cause instanceof Error ? cause.message : String(cause),
            });
            continue;
          }
        } else if (fromDictionary === false && context.llm === undefined) {
          skipped.push({ lemma, reason: '云端 AI 未配置（离线或云服务未激活），无法生成释义' });
          continue;
        }

        // 3. 已存在的词条：有释义 → 直接复用（重复）；是历史占位 → 走补全。
        const existing = await context.repos.words.getWordByLemma(lemma, ownerScope);
        if (existing !== null) {
          const existingSenses = await context.repos.words.listSenses(existing.id);
          if (isPlaceholderSenses(existingSenses) === false) {
            // 已有真实义项：直接挂到词库（幂等），不算新建。
            await context.repos.words.addDeckWord(
              input.deckId,
              existing.id,
              context.device.deviceId(),
              context.clock.now(),
            );
            duplicates += 1;
            rows.push({ lemma, imported: false, backfilled: false, senses: existingSenses.map((sense) => ({
              senseNo: sense.senseNo,
              pos: sense.pos,
              simpleZh: sense.simpleZh,
              detailedZh: sense.detailedZh ?? null,
              contextText: sense.contextText ?? null,
            })) });
            continue;
          }
          // 占位词条：用上面拿到的释义（词典或 LLM）补全（数据层 upsert 会补齐义项）。
          if (senses.length === 0) {
            // 极端情况：既有占位又拿不到新释义（LLM 失败且词典没有）→ 跳过。
            skipped.push({ lemma, reason: '词典与云端 AI 都没有给出释义' });
            continue;
          }
          const fallbackSource = sourceId ?? LOCAL_USER_SOURCE_ID;
          await context.repos.words.createWord({
            ownerScope,
            id: existing.id,
            lemma,
            senses: senses.map((sense) => ({
              pos: sense.pos,
              simpleZh: sense.simpleZh,
              detailedZh: sense.detailedZh,
              contextText: sense.contextText,
              sourceId: fallbackSource,
            })),
            deviceId: context.device.deviceId(),
            now: context.clock.now(),
          });
          await context.repos.words.addDeckWord(
            input.deckId,
            existing.id,
            context.device.deviceId(),
            context.clock.now(),
          );
          backfilled += 1;
          rows.push({ lemma, imported: false, backfilled: true, senses });
          continue;
        }

        // 4. 全新词条：建词（数据层 createWord 需要 sourceId 已存在；
        //    词典义项自带来源，LLM 义项用「本地自建来源」，先确保存在）。
        const finalSourceId = sourceId ?? LOCAL_USER_SOURCE_ID;
        if (sourceId === undefined) {
          await ensureUserSource(context, ownerScope);
        }
        const word = await context.repos.words.createWord({
          ownerScope,
          lemma,
          senses: senses.map((sense) => ({
            pos: sense.pos,
            simpleZh: sense.simpleZh,
            detailedZh: sense.detailedZh,
            contextText: sense.contextText,
            sourceId: finalSourceId,
          })),
          deviceId: context.device.deviceId(),
          now: context.clock.now(),
        });
        await context.repos.words.addDeckWord(
          input.deckId,
          word.id,
          context.device.deviceId(),
          context.clock.now(),
        );
        imported += 1;
        rows.push({ lemma, imported: true, backfilled: false, senses });
      }

      return { imported, duplicates, backfilled, skipped, rows };
    },
  };
}
