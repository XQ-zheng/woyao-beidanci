/**
 * 批量导入服务：把一批英文单词/短语导入到指定词库。
 *
 * 释义策略（按用户需求）：先查本地内置词典（ECDICT 导入的词条，`LOCAL` 归属），
 * 命中就复用它的中文义项；查不到则建一个「空义项」词条（词形保留、释义留空），
 * 供用户之后补。导入与建词都是幂等的：重复词返回既有记录、重复挂载不重复计数。
 */
import { LOCAL_OWNER_SCOPE } from '@woyao/data';
import type { SenseView } from './dto';
import { ServiceNotFoundError } from './errors';
import type { LibraryService } from './libraryService';
import type { ServiceContext } from './ports';

/** 一条待导入的条目。 */
export interface ImportTerm {
  /** 词形（单词或短语，保留大小写）。 */
  readonly lemma: string;
  /** 是否短语（仅用于展示/去重提示，不影响建词）。 */
  readonly phrase?: boolean;
}

/** 批量导入结果。 */
export interface ImportWordsResult {
  /** 本次新建的词条数。 */
  readonly imported: number;
  /** 已存在（重复）的词条数。 */
  readonly duplicates: number;
  /** 命中内置词典、自动补到释义的词条数。 */
  readonly withDefinition: number;
  /** 未命中词典、释义留空的词条数。 */
  readonly withoutDefinition: number;
  /** 每条的结果（供 UI 展示详情）。 */
  readonly rows: ReadonlyArray<{
    readonly lemma: string;
    readonly imported: boolean;
    readonly hasDefinition: boolean;
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

/** 无释义词条的占位释义（`createWord` 的 schema 要求 simpleZh 非空）。 */
export const NO_DEFINITION_PLACEHOLDER = '（暂无释义）';

/** 命中词典时拿到的结果：义项 + 它们的来源 id。 */
interface DictionaryHit {
  readonly senses: SenseView[];
  /** 义项来源 id（词典词条自己的 sourceId，建词时原样复用）。 */
  readonly sourceId: string;
}

/**
 * 把内置词典词条的义项映射成 `SenseView`（给 UI 展示与建词复用）。
 *
 * @param context 服务上下文。
 * @param wordId 词典词条 id。
 * @returns 义项视图列表。
 */
async function loadDictionarySenses(context: ServiceContext, wordId: string): Promise<DictionaryHit | null> {
  const senses = await context.repos.words.listSenses(wordId);
  if (senses.length === 0) {
    return null;
  }
  return {
    sourceId: senses[0]?.sourceId ?? DICTIONARY_SOURCE_ID,
    senses: senses.map((sense) => ({
      senseNo: sense.senseNo,
      pos: sense.pos,
      simpleZh: sense.simpleZh,
      detailedZh: sense.detailedZh ?? null,
      contextText: sense.contextText ?? null,
    })),
  };
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
        readonly hasDefinition: boolean;
        readonly senses: readonly SenseView[];
      }> = [];
      let imported = 0;
      let duplicates = 0;
      let withDefinition = 0;
      let withoutDefinition = 0;

      for (const term of input.terms) {
        const lemma = term.lemma.trim();
        if (lemma.length === 0) {
          continue;
        }

        // 1. 查内置词典补释义（LOCAL 归属下的词典词条）。
        let senses: SenseView[] = [];
        let sourceId: string | undefined;
        let hasDefinition = false;
        const dictionaryWord = await context.repos.words.getWordByLemma(lemma, LOCAL_OWNER_SCOPE);
        if (dictionaryWord !== null) {
          const hit = await loadDictionarySenses(context, dictionaryWord.id);
          if (hit !== null) {
            senses = hit.senses;
            sourceId = hit.sourceId;
            hasDefinition = true;
          }
        }

        // 2. 建词（或命中已有词）。无释义时用一个占位义项（schema 要求 simpleZh 非空），
        //    UI 据此显示「暂无释义」，用户之后可补。
        const created = await library.createWord({
          lemma,
          ownerScope,
          sourceId,
          senses:
            senses.length > 0
              ? senses.map((sense) => ({
                  pos: sense.pos,
                  simpleZh: sense.simpleZh,
                  detailedZh: sense.detailedZh,
                  contextText: sense.contextText,
                }))
              : [{ pos: '', simpleZh: NO_DEFINITION_PLACEHOLDER, detailedZh: null, contextText: null }],
        });

        // 3. 挂到目标词库（幂等）。
        await context.repos.words.addDeckWord(
          input.deckId,
          created.wordId,
          context.device.deviceId(),
          context.clock.now(),
        );

        if (created.created) {
          imported += 1;
          // 「有无释义」只对新建词计数，重复词不再重复计入（避免与 imported 口径打架）。
          if (hasDefinition) {
            withDefinition += 1;
          } else {
            withoutDefinition += 1;
          }
        } else {
          duplicates += 1;
        }
        rows.push({ lemma, imported: created.created, hasDefinition, senses: created.senses });
      }

      return { imported, duplicates, withDefinition, withoutDefinition, rows };
    },
  };
}
