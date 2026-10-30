/**
 * 学习闭环服务：开始会话 → 逐题作答 → 结束会话，以及“此单词不再出现”。
 *
 * 分工交代得很清楚，改代码前先看这一段：
 * - **`@woyao/core` 决定一切业务规则**：今日队列（`buildDailyQueue`）、状态迁移
 *   （`nextLearningState`）、干扰项（`generateDistractors`）、模式解析
 *   （`resolveDistractorMode`）、洗牌（`seededShuffle`）。本文件**不排序、不抽样、
 *   不重写 stage 口径、不重写 90 天/权重/间隔规则**，只负责取数、组装与落库。
 * - **`@woyao/data` 决定事务与幂等**：`appendEventAndUpdateState` 在单事务里
 *   插事件 + upsert 状态 + 写两条发件箱；`event_id` 重复时直接返回 `applied: false`。
 *   服务层**不套第二层事务**（套了反而会让“外键失败整笔回滚”的保证变复杂）。
 *
 * 三条硬规则（每条都有测试锁定）：
 * 1. **`ClockSkewError` 原样向上传播且零残留**：`nextLearningState` 在任何写操作之前
 *    就抛错，服务层不 try/catch 它、不翻译成 `ServiceError`、也不补一条“校正后”的事件。
 * 2. **重复 `eventId` 不再加一次计数**：`applied === false` 时返回库里 `learning_state`
 *    的真实值，绝不把内存里的 `next` 状态当成事实。
 * 3. **历史不可改写**：`finishSession` 的 `newCount`/`reviewCount` 从**事件事实**汇总
 *    （`stageBefore === STAGE_NEVER_REVIEWED` 的条数），不读会话行上“开始时”的预估数，
 *    因此中途改设置不会把已经发生的会话改写掉。
 */

import {
  REQUIRED_DISTRACTOR_COUNT,
  STAGE_NEVER_REVIEWED,
  buildDailyQueue,
  createInitialLearningState,
  displayAnswerOf,
  generateDistractors,
  nextLearningState,
  resolveDistractorMode,
  seededShuffle,
  toIsoInstant,
  type LearningState,
  type Recognition,
  type ReviewPlan,
  type TrainingMode,
  type WordWithSenses,
} from '@woyao/core';
import { LOCAL_OWNER_SCOPE, makeUserWordId } from '@woyao/data';

import {
  finishSessionInputSchema,
  parseOrThrow,
  startSessionInputSchema,
  submitAnswerInputSchema,
  toLocalDateString,
  wordRefInputSchema,
  type DistractorWordView,
  type SenseView,
  type FrequencyView,
} from './dto';
import { ServiceNotFoundError, ServiceValidationError } from './errors';
import { loadFrequencyLookup, toFrequencyView } from './frequencyView';
import type { ServiceContext } from './ports';
import type { SettingsService } from './settingsService';

/** 一张学习卡片。 */
export interface CardView {
  /** 词条 id。 */
  readonly wordId: string;
  /** 英文词形。 */
  readonly lemma: string;
  /** 英式音标。 */
  readonly phoneticUk: string | null;
  /** 美式音标。 */
  readonly phoneticUs: string | null;
  /** 本题方向（`MIXED` 已在生成卡片时解析成具体方向，所以这里只有两种）。 */
  readonly mode: 'EN_TO_ZH' | 'ZH_TO_EN';
  /** 题型。 */
  readonly style: 'CHOICE' | 'REVEAL';
  /** 题干：`EN_TO_ZH` 是词形，`ZH_TO_EN` 是义项简解拼接。 */
  readonly prompt: string;
  /** 正确答案文本。 */
  readonly answer: string;
  /**
   * 选项（含正确答案，已按种子打乱）；`style === 'REVEAL'` 时为 `[]`。
   *
   * 候选词不足时可能少于 4 个（**绝不编造干扰项**，见 core 的 `generateDistractors`）；
   * 只剩 1 个选项时 UI 应退化为“直接显示答案”。
   */
  readonly options: string[];
  /**
   * 每个干扰选项的「选项文本 → 来源词形」（R4 收藏干扰词用）。
   *
   * options 是释义文本，UI 没法从文本反查词形去收藏；这里由服务层在组装选项时
   * 顺手记下每个干扰项的来源词形（自定义干扰词的词形 / AI 相近词的词形 /
   * 词库候选词的词形）。查不到来源的选项不出现在这个数组里，UI 据此不渲染收藏按钮。
   * `style === 'REVEAL'` 时为空数组。
   */
  readonly distractorWords?: ReadonlyArray<{ text: string; lemma: string }>;
  /** 全部义项（答题后展示详细释义）。 */
  readonly senses: SenseView[];
  /** 词频重要性（没有语料上下文时为 `UNKNOWN`，不按“低频”处理）。 */
  readonly frequency: FrequencyView;
  /** 是否是新词卡（从未作答过）。 */
  readonly isNew: boolean;
  /** 是否已收藏进生词本。 */
  readonly isFavorite: boolean;
}

/** 一次学习会话的完整视图（含今日全部卡片）。 */
export interface SessionView {
  readonly sessionId: string;
  readonly deckId: string;
  readonly startedAt: string;
  readonly localDate: string;
  readonly timeZone: string;
  /** 今日新词数（队列长度，不是词库大小）。 */
  readonly newCount: number;
  /** 今日复习数（队列长度）。 */
  readonly reviewCount: number;
  /** 卡片总数 = `newCount + reviewCount`。 */
  readonly totalCards: number;
  /** 今日卡片（已按 core 的确定性交错顺序排列）。 */
  readonly cards: CardView[];
  /** 本次会话使用的计划快照。 */
  readonly plan: ReviewPlan;
}

/** 提交一次作答的入参。 */
export interface SubmitAnswerInput {
  readonly sessionId: string;
  readonly deckId: string;
  readonly wordId: string;
  /**
   * 训练模式。
   *
   * 必须是**卡片已解析后的具体方向**（`EN_TO_ZH` / `ZH_TO_EN`）：答案文本要按
   * 同一个方向给出。传 `MIXED` 会得到 `VALIDATION_FAILED`——猜一个方向去算
   * “正确答案”比报错更糟（用户会看到错误答案被标成正确）。
   */
  readonly mode: TrainingMode;
  /** 题干原文（落库用于复盘；也可用于判别方向）。 */
  readonly prompt: string;
  /** 用户实际选择的答案文本（可以直接跳过，此时为空串）。 */
  readonly answer: string;
  readonly isCorrect: boolean;
  readonly recognition: Recognition;
  /** 作答时刻（`Date`，数据层会转成 UTC ISO 毫秒）。 */
  readonly answeredAt: Date;
  /** 作答耗时（毫秒）。 */
  readonly durationMs?: number;
  /** 幂等键；缺省由服务层生成。 */
  readonly eventId?: string;
  /** 给了 exam + corpusVersion 才查词频；否则返回 `UNKNOWN`。 */
  readonly exam?: string;
  readonly corpusVersion?: string;
}

/** 一次作答的结果。 */
export interface AnswerResult {
  /** `false` 表示该 `eventId` 已存在（幂等命中），本次没有改动任何数据。 */
  readonly applied: boolean;
  readonly isCorrect: boolean;
  /** 正确答案文本（按作答方向给出）。 */
  readonly correctAnswer: string;
  /** 累计答错次数（取自 `learning_state`，不清零）。 */
  readonly cumulativeWrongCount: number;
  /** 是否提示“这个单词已经错了 N 次”（答错且累计错次 >= 2）。 */
  readonly showCumulativeWrongPrompt: boolean;
  /** 下一次到期时间（UTC ISO 毫秒）。 */
  readonly nextDueAt: string;
  readonly stage: number;
  readonly weight: number;
  readonly frequency: FrequencyView;
}

/** 会话汇总（结束会话的返回值，也是会话列表的一行）。 */
export interface SessionSummary {
  readonly sessionId: string;
  readonly deckId: string;
  readonly startedAt: string;
  /** `null` 表示会话还没结束（列表里可能出现，`finishSession` 一定会写上）。 */
  readonly endedAt: string | null;
  readonly localDate: string;
  readonly timeZone: string;
  /** 本次会话里**首次作答**的词数（由事件的 `stageBefore` 汇总，不是会话行的预估数）。 */
  readonly newCount: number;
  /** 本次会话里复习过的词数。 */
  readonly reviewCount: number;
  /** 实际作答次数（含重复作答同一个词）。 */
  readonly totalAnswers: number;
  readonly correctCount: number;
  /** 作答耗时之和（毫秒），未提供耗时的作答按 0 计。 */
  readonly activeDurationMs: number;
}

/** 学习服务契约。 */
export interface StudyService {
  /** 开始（或重建）今天的学习会话。 */
  startSession(input: { deckId: string; now: Date; seed?: string; force?: boolean }): Promise<SessionView>;
  /** 提交一次作答。 */
  submitAnswer(input: SubmitAnswerInput): Promise<AnswerResult>;
  /** 结束会话并写回汇总（中断的会话也能结束）。 */
  finishSession(input: { sessionId: string; now: Date }): Promise<SessionSummary>;
  /** 把某个词设为“不再出现”。 */
  suppressWord(input: { deckId: string; wordId: string; now: Date }): Promise<void>;
  /** 取消“不再出现”。 */
  restoreWord(input: { deckId: string; wordId: string; now: Date }): Promise<void>;
}

/** 构造参数。 */
export interface StudyServiceOptions {
  readonly context: ServiceContext;
  /**
   * 复习计划与训练偏好的来源。
   *
   * **必填**：`SettingsService` 需要一个 `defaultTimeZone`（由外壳传
   * `Intl.DateTimeFormat().resolvedOptions().timeZone`），而默认时区**不能**在服务层
   * 猜一个——猜错会让所有到期时间按错误的日历日计算。所以让调用方显式注入
   * （Task 7 会把同一个实例共享给所有服务）。
   */
  readonly settings: SettingsService;
  /** 归属范围（决定读哪个生词本判断“已收藏”）。缺省 `LOCAL`。 */
  readonly ownerScope?: string;
  /**
   * 内容服务（可选注入，R3）：组装选择题时用它取 AI 相近干扰词池。
   *
   * 缺省（未注入）时跳过 AI 干扰项，直接回退词库候选机制——学习卡不因 AI
   * 未配置而不可用。注入最小结构接口而不是整个 `ContentService`，
   * 避免服务间的强类型耦合与装配环。
   */
  readonly content?: {
    getDistractorPool(input: { lemma: string }): Promise<ReadonlyArray<DistractorWordView>>;
  };
}

/** 累计错次达到该值起提示“这个单词已经错了 N 次”（需求的硬要求）。 */
export const CUMULATIVE_WRONG_PROMPT_THRESHOLD = 2;

/** 生词本判定的归属范围默认值（与 `LibraryService` 同一套语义）。 */
const DEFAULT_OWNER_SCOPE = LOCAL_OWNER_SCOPE;

/**
 * 把词条 + 义项投影成 core 的 `WordWithSenses`。
 *
 * 只做类型/字段投影，**不含任何答案规则**：判卷答案一律走 core 的 `displayAnswerOf`
 * （与 `generateDistractors` 挑选项里的正确答案是同一个函数）。这里绝不能自己实现
 * “EN_TO_ZH 取第一个非空义项、ZH_TO_EN 取词形”——那会让两处口径静默分叉。
 */
function toWordWithSenses(
  word: { id: string; lemma: string },
  senses: readonly SenseView[],
): WordWithSenses {
  return {
    wordId: word.id,
    lemma: word.lemma,
    pos: senses[0]?.pos ?? '',
    senses: senses.map((sense) => sense.simpleZh),
  };
}

/**
 * FNV-1a 32 位散列（确定性，不依赖 Math.random）。
 *
 * 只用于「从多个义项里挑一个」这类**内部均匀化**，不承担安全职责。
 *
 * @param value 待散列字符串。
 * @returns 无符号 32 位整数。
 */
function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 确定性挑选本题考查的义项下标（R2 修 bug 的核心）。
 *
 * 之前 `EN_TO_ZH` 的正确答案固定取义项 1——多义词永远只考第一个释义。
 * 现在用 `hash(seed + ':' + wordId) % 义项数` 在该词**全部非空义项**里确定性挑选：
 * 同一 (seed, wordId) 在任何端、任何时刻都得到同一下标（种子确定性不破坏），
 * 不同词/不同天则自然分散到不同义项。
 *
 * `buildCard` 与 `submitAnswer` 的判卷口径共用本函数，两处绝不会各挑各的。
 *
 * @param seed 会话级种子。
 * @param wordId 词条 id。
 * @param senseCount 该词非空义项数。
 * @returns `[0, senseCount)` 内的下标；`senseCount <= 0` 时返回 0。
 */
export function selectAnswerSenseIndex(seed: string, wordId: string, senseCount: number): number {
  if (!Number.isInteger(senseCount) || senseCount <= 0) {
    return 0;
  }
  return fnv1a32(`${seed}:${wordId}`) % senseCount;
}

/**
 * 从会话行的计划快照里取回会话种子。
 *
 * `startSession` 把种子随计划一起写进 `plan_snapshot_json`（判卷要用）；
 * 旧版本会话的快照里没有 `seed` 字段，解析失败/缺失一律返回 `null`，
 * 调用方回退到 core「第一个非空义项」的旧口径——宁可口径退一档，也不抛错。
 *
 * @param planSnapshotJson 会话行的快照 JSON（可空）。
 * @returns 会话种子；取不到时为 `null`。
 */
function parseSessionSeed(planSnapshotJson: string | null): string | null {
  if (planSnapshotJson === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(planSnapshotJson);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as { seed?: unknown }).seed === 'string'
    ) {
      return (parsed as { seed: string }).seed;
    }
  } catch {
    // 损坏的快照：走旧口径，不影响作答主流程。
  }
  return null;
}

/** 选项文本的排重口径：去首尾空白 + 小写（与 core 的 normalizeText 同一口径）。 */
function normalizeOptionKey(text: string): string {
  return text.trim().toLowerCase();
}

/** 一个干扰选项：展示文本 + 来源词形（收藏五角星用）。 */
interface DistractorEntry {
  readonly text: string;
  readonly lemma: string;
}

/**
 * 拼 `ZH_TO_EN` 的题干（义项简解）。
 *
 * @param senses 义项（已按 `senseNo` 升序）。
 * @returns 形如 `放弃；抛弃` 的题干。
 */
function promptOfZhToEn(senses: readonly SenseView[]): string {
  return senses
    .map((sense) => sense.simpleZh.trim())
    .filter((text) => text !== '')
    .join('；');
}

/**
 * 从 `userWordId`（`${deckId}:${wordId}`）里取回 `wordId`。
 *
 * 事件表不存 `word_id`（只存 `user_word_id`），而评估与错词本要按词聚合。
 * 已知 `deckId` 时按前缀剥离是**无歧义**的；只有库里存在“前缀对不上”的脏数据时
 * 才退到“第一个冒号之后”的宽松解析——这条路只为不崩，不会静默造出一个新词。
 *
 * @param deckId 词库 id。
 * @param userWordId 学习状态主键。
 * @returns 词条 id。
 */
export function wordIdFromUserWordId(deckId: string, userWordId: string): string {
  const prefix = `${deckId}:`;
  if (userWordId.startsWith(prefix)) {
    return userWordId.slice(prefix.length);
  }
  const separatorIndex = userWordId.indexOf(':');
  return separatorIndex >= 0 ? userWordId.slice(separatorIndex + 1) : userWordId;
}

/**
 * 创建学习服务。
 *
 * @param options 上下文、计划来源与归属范围。
 * @returns 学习服务实例。
 */
export function createStudyService(options: StudyServiceOptions): StudyService {
  const { context } = options;
  const { settings } = options;
  const ownerScope = options.ownerScope ?? DEFAULT_OWNER_SCOPE;
  const distractorContent = options.content ?? null;

  /** 读一个词的全部义项，并按 `senseNo` 升序（数据层已保证顺序，这里只做投影）。 */
  async function loadSenses(wordId: string): Promise<SenseView[]> {
    const senses = await context.repos.words.listSenses(wordId);
    return senses.map((sense) => ({
      senseNo: sense.senseNo,
      pos: sense.pos,
      simpleZh: sense.simpleZh,
      detailedZh: sense.detailedZh,
      contextText: sense.contextText,
    }));
  }

  /** 当前归属范围内的生词本词 id 集合（一次会话只查一次，不按卡片查）。 */
  async function loadFavoriteWordIds(): Promise<ReadonlySet<string>> {
    const decks = await context.repos.words.listDecks(ownerScope);
    const notebook = decks.find((deck) => deck.kind === 'NOTEBOOK');
    if (notebook === undefined) {
      return new Set<string>();
    }
    const wordIds = await context.repos.words.listDeckWordIds(notebook.id);
    return new Set<string>(wordIds);
  }

  /**
   * 把词库里的词装成 core 的干扰项候选形状。
   *
   * 只在 `style === 'CHOICE'` 时调用：`REVEAL` 不需要候选池，
   * 否则纯“看答案”的会话也要把整个词库的义项读一遍。
   */
  async function loadDistractorCandidates(deckWordIds: readonly string[]): Promise<WordWithSenses[]> {
    const words = await context.repos.words.listWordsByIds(deckWordIds);
    const candidates: WordWithSenses[] = [];
    for (const word of words) {
      const senses = await context.repos.words.listSenses(word.id);
      candidates.push({
        wordId: word.id,
        lemma: word.lemma,
        pos: senses[0]?.pos ?? '',
        senses: senses.map((sense) => sense.simpleZh),
      });
    }
    return candidates;
  }

  /**
   * 取一个词形的 AI 相近干扰词池；未注入内容服务或取池失败时返回空数组（绝不抛错）。
   *
   * @param lemma 词形。
   * @returns 相近词池（可能为空）。
   */
  async function loadDistractorPool(lemma: string): Promise<ReadonlyArray<DistractorWordView>> {
    if (distractorContent === null) {
      return [];
    }
    try {
      return await distractorContent.getDistractorPool({ lemma });
    } catch (cause: unknown) {
      context.log.warn(`AI 相近干扰词池读取失败：${lemma}`, cause);
      return [];
    }
  }

  /**
   * 组装一张卡片。
   *
   * @param input 卡片上下文（词条、计划、种子、题型、候选池加载器等）。
   * @returns 卡片视图。
   */
  async function buildCard(input: {
    wordId: string;
    state: LearningState | undefined;
    favoriteWordIds: ReadonlySet<string>;
    trainingMode: TrainingMode;
    questionStyle: 'CHOICE' | 'REVEAL';
    seed: string;
    frequencyLookup: Awaited<ReturnType<typeof loadFrequencyLookup>> | null;
    /** 词库候选池加载器（REVEAL 不需要；CHOICE 里也只在 AI/自定义席位不足时才真正加载）。 */
    loadCandidates: () => Promise<readonly WordWithSenses[]>;
  }): Promise<CardView | null> {
    const word = await context.repos.words.getWordById(input.wordId);
    if (word === null) {
      // 词库里有指向不存在词条的行（导入中断/同步半途）：跳过而不是让整次会话失败。
      context.log.warn(`会话队列里的词条不存在，已跳过：${input.wordId}`);
      return null;
    }
    const senses = await loadSenses(word.id);
    // `MIXED` 在这里解析成具体方向：卡片必须明确“问的是英译中还是中译英”，
    // 同一 (seed, wordId) 永远得到同一方向，因此重开会话也能复现同一套题。
    const mode = resolveDistractorMode(input.trainingMode, input.seed, word.id);

    // R2 修 bug：EN_TO_ZH 不再固定考义项 1，而是在全部非空义项里按 (seed, wordId)
    // 确定性挑一个；ZH_TO_EN 的答案仍是词形，不受影响。
    const nonEmptySenses = senses.filter((sense) => sense.simpleZh.trim() !== '');
    const bundle = toWordWithSenses(word, senses);
    let answer = displayAnswerOf(bundle, mode);
    let target = bundle;
    if (mode === 'EN_TO_ZH' && nonEmptySenses.length > 0) {
      const selected =
        nonEmptySenses[selectAnswerSenseIndex(input.seed, word.id, nonEmptySenses.length)] ??
        nonEmptySenses[0]!;
      answer = selected.simpleZh.trim();
      // 传给 generateDistractors 的 target 只含被考的义项：core 的“候选与目标义项有交集
      // 则剔除”的排重只应对被考义项生效——带全部义项会让正确答案被其他义项误判成重复。
      target = {
        wordId: word.id,
        lemma: word.lemma,
        pos: selected.pos,
        senses: [selected.simpleZh],
      };
    }
    const prompt = mode === 'EN_TO_ZH' ? word.lemma : promptOfZhToEn(senses);

    let options: string[] = [];
    let distractorWords: ReadonlyArray<DistractorEntry> = [];
    if (input.questionStyle === 'CHOICE') {
      const entries: DistractorEntry[] = [];
      const usedKeys = new Set<string>([normalizeOptionKey(answer)]);
      /** 占一个干扰席：文本为空或与已选项重复时放弃（绝不编造、正确答案绝不重复出现）。 */
      const occupy = (text: string, lemma: string): boolean => {
        const key = normalizeOptionKey(text);
        if (text.trim() === '' || usedKeys.has(key)) {
          return false;
        }
        usedKeys.add(key);
        entries.push({ text, lemma });
        return true;
      };

      if (mode === 'EN_TO_ZH') {
        // ① 自定义干扰词（R5）必占一席：选项文本取该词形 AI 相近词池里的中文释义
        //    （setWordDistractors 保存时已预热缓存）；池里没有可用释义就放弃该席，
        //    绝不编造。来源词形记用户指定的词形本身，收藏五角星按它建词。
        const customLemmas = await context.repos.words.listWordDistractors(word.id);
        for (const customLemma of customLemmas) {
          if (entries.length >= REQUIRED_DISTRACTOR_COUNT) {
            break;
          }
          const pool = await loadDistractorPool(customLemma);
          for (const item of pool) {
            if (occupy(item.meaningZh, customLemma)) {
              break;
            }
          }
        }
        // ② AI 相近词池（R3）填充剩余席位：文本 = 相近词的中文释义，词形记相近词本身。
        if (entries.length < REQUIRED_DISTRACTOR_COUNT) {
          const pool = await loadDistractorPool(word.lemma);
          for (const item of pool) {
            if (entries.length >= REQUIRED_DISTRACTOR_COUNT) {
              break;
            }
            if (item.lemma.toLowerCase() === word.lemma.toLowerCase()) {
              continue;
            }
            occupy(item.meaningZh, item.lemma);
          }
        }
      } else {
        // ZH_TO_EN 的选项是英文词形：自定义干扰词直接以词形占席（无需释义），
        // AI 池给与目标词拼写相近的词形。
        const customLemmas = await context.repos.words.listWordDistractors(word.id);
        for (const customLemma of customLemmas) {
          if (entries.length >= REQUIRED_DISTRACTOR_COUNT) {
            break;
          }
          occupy(customLemma, customLemma);
        }
        if (entries.length < REQUIRED_DISTRACTOR_COUNT) {
          const pool = await loadDistractorPool(word.lemma);
          for (const item of pool) {
            if (entries.length >= REQUIRED_DISTRACTOR_COUNT) {
              break;
            }
            if (item.lemma.toLowerCase() === word.lemma.toLowerCase()) {
              continue;
            }
            occupy(item.lemma, item.lemma);
          }
        }
      }

      // ③ 仍不足 → 回退现有词库候选机制（core.generateDistractors，相似度排序，
      //    绝不编造）。候选池按需加载：AI/自定义已凑满 3 席时整库义项一次都不读。
      if (entries.length < REQUIRED_DISTRACTOR_COUNT) {
        const candidates = await input.loadCandidates();
        const fallback = generateDistractors(target, candidates, input.trainingMode, input.seed);
        // 干扰项文本 → 候选词形：收藏五角星需要知道选项来自哪个词。
        const lemmaByText = new Map<string, string>();
        for (const candidate of candidates) {
          const text = displayAnswerOf(candidate, mode);
          const key = normalizeOptionKey(text);
          if (text !== '' && !lemmaByText.has(key)) {
            lemmaByText.set(key, candidate.lemma);
          }
        }
        for (const text of fallback) {
          if (entries.length >= REQUIRED_DISTRACTOR_COUNT) {
            break;
          }
          occupy(text, lemmaByText.get(normalizeOptionKey(text)) ?? '');
        }
      }

      // 选项含正确答案并按种子打乱：顺序也要可复现，否则同一天两次开会话的
      // 同一道题选项位置会变，用户会以为“题变了”。
      options = seededShuffle(
        [answer, ...entries.map((entry) => entry.text)],
        `${input.seed}|${word.id}|options`,
      );
      distractorWords = entries;
    }

    return {
      wordId: word.id,
      lemma: word.lemma,
      phoneticUk: word.phoneticUk,
      phoneticUs: word.phoneticUs,
      mode,
      style: input.questionStyle,
      prompt,
      answer,
      options,
      distractorWords,
      senses,
      frequency: toFrequencyView(input.frequencyLookup, word.id),
      isNew: input.state === undefined || input.state.stage === STAGE_NEVER_REVIEWED,
      isFavorite: input.favoriteWordIds.has(word.id),
    };
  }

  /** 校验作答模式：`MIXED` 必须在生成卡片时解析掉，不能落到这里。 */
  function requireResolvedMode(mode: TrainingMode): 'EN_TO_ZH' | 'ZH_TO_EN' {
    if (mode === 'EN_TO_ZH' || mode === 'ZH_TO_EN') {
      return mode;
    }
    throw new ServiceValidationError(
      [
        {
          path: 'mode',
          message: '提交作答时必须回传卡片已解析的方向（EN_TO_ZH 或 ZH_TO_EN），不能是 MIXED',
        },
      ],
      '作答校验未通过',
    );
  }

  return {
    async startSession(input: { deckId: string; now: Date; seed?: string; force?: boolean }): Promise<SessionView> {
      const validated = parseOrThrow(startSessionInputSchema, input, '开始学习');
      const plan = await settings.loadReviewPlan();
      const snapshot = await settings.getSnapshot();

      const deck = await context.repos.words.getDeckById(validated.deckId);
      if (deck === null) {
        throw new ServiceNotFoundError('deck', validated.deckId);
      }

      const localDate = toLocalDateString(validated.now, plan.timeZone);
      // 种子确定性是需求硬要求：同一天同一词库两次开会话必须得到同一顺序。
      // 缺省种子由“词库 + 本地日”派生，**绝不使用 Math.random()**。
      const seed = validated.seed ?? `${validated.deckId}|${localDate}`;

      const [states, deckWordIds] = await Promise.all([
        context.repos.learning.listStatesByDeck(validated.deckId),
        context.repos.words.listDeckWordIds(validated.deckId),
      ]);

      const stateByWordId = new Map<string, LearningState>();
      for (const state of states) {
        stateByWordId.set(state.wordId, state);
      }
      // 未学过的词 = 词库里有、但还没有学习状态的词（保持词库顺序）。
      // 重学模式（force）：不过滤「今日已学」、不受每日新词上限与复习到期约束——
      // 词库全部词当作全新一轮重新排队；每次会话的学习事件独立记录，历史互不影响。
      const unseenWordIds =
        validated.force === true
          ? deckWordIds
          : deckWordIds.filter((wordId) => !stateByWordId.has(wordId));

      // 队列完全交给 core：排序、上限截断、屏蔽词过滤、确定性交错都在里面。
      // `newCount`/`reviewCount` 在卡片组装之前就已确定（取队列长度），不受后续组装/重排影响。
      const queue =
        validated.force === true
          ? buildDailyQueue([], unseenWordIds, { ...plan, dailyNewLimit: 500 }, validated.now, seed)
          : buildDailyQueue(states, unseenWordIds, plan, validated.now, seed);

      // 先组装卡片、后写会话行：卡片组装不依赖 `sessionId`，把“可能抛错的读组装”放到
      // 写库之前，避免组装中途失败留下一条永远空的会话行（那会被会话列表当成一次“0 作答”的历史）。
      const frequencyLookup =
        validated.exam !== undefined && validated.corpusVersion !== undefined
          ? await loadFrequencyLookup(context.repos.words, validated.exam, validated.corpusVersion)
          : null;
      const favoriteWordIds = await loadFavoriteWordIds();
      // 候选池改为**按需加载**（R3）：AI/自定义干扰词凑满 3 席时，整库义项一次都不读。
      let candidatesCache: readonly WordWithSenses[] | null = null;
      const loadCandidates = async (): Promise<readonly WordWithSenses[]> => {
        if (candidatesCache === null) {
          candidatesCache = await loadDistractorCandidates(deckWordIds);
        }
        return candidatesCache;
      };

      const cards: CardView[] = [];
      for (const wordId of queue.interleavedWordIds) {
        const card = await buildCard({
          wordId,
          state: stateByWordId.get(wordId),
          favoriteWordIds,
          trainingMode: snapshot.trainingMode,
          questionStyle: snapshot.questionStyle,
          seed,
          frequencyLookup,
          loadCandidates,
        });
        if (card !== null) {
          cards.push(card);
        }
      }

      const sessionId = context.ids.nextId();
      await context.repos.learning.upsertSession({
        sessionId,
        deckId: validated.deckId,
        startedAt: toIsoInstant(validated.now),
        endedAt: null,
        localDate,
        timeZone: plan.timeZone,
        newCount: queue.newWordIds.length,
        reviewCount: queue.reviewWordIds.length,
        activeDurationMs: 0,
        // 种子随计划一起入快照：submitAnswer 判卷要用同一种子复算“考哪个义项”。
        // 旧快照没有 seed 字段时判卷回退 core 旧口径（见 parseSessionSeed）。
        planSnapshotJson: JSON.stringify({ ...plan, seed }),
        deviceId: context.device.deviceId(),
        revision: 0,
      });

      return {
        sessionId,
        deckId: validated.deckId,
        startedAt: toIsoInstant(validated.now),
        localDate,
        timeZone: plan.timeZone,
        newCount: queue.newWordIds.length,
        reviewCount: queue.reviewWordIds.length,
        totalCards: cards.length,
        cards,
        plan,
      };
    },

    async submitAnswer(input: SubmitAnswerInput): Promise<AnswerResult> {
      const validated = parseOrThrow(submitAnswerInputSchema, input, '提交作答');
      const mode = requireResolvedMode(validated.mode);

      const session = await context.repos.learning.getSession(validated.sessionId);
      if (session === null) {
        throw new ServiceNotFoundError('session', validated.sessionId);
      }
      if (session.deckId !== validated.deckId) {
        throw new ServiceValidationError(
          [{ path: 'deckId', message: `与会话所属词库不一致（会话属于 ${session.deckId}）` }],
          '作答校验未通过',
        );
      }

      const plan = await settings.loadReviewPlan();
      const userWordId = makeUserWordId(validated.deckId, validated.wordId);
      const existing = await context.repos.learning.getState(userWordId);
      const answeredAtIso = toIsoInstant(validated.answeredAt);
      const now = context.clock.now();

      // 状态缺失时按“从未复习”初始化：`dueAt` 用作答时刻本身——它不会被写进库
      // （`nextLearningState` 一定会给出新的 dueAt），只是为了满足结构约束。
      const baseState =
        existing ??
        createInitialLearningState({
          userWordId,
          deckId: validated.deckId,
          wordId: validated.wordId,
          dueAt: answeredAtIso,
        });

      // ⚠️ 这一步会抛 `ClockSkewError`（作答时间超前注入时钟 60 秒以上）。
      // **不要** try/catch 它：需求要求原样传播，且因为它在任何写操作之前，
      // 库里一行都不会留下（“零残留”就是这么来的）。
      const next = nextLearningState(
        baseState,
        {
          isCorrect: validated.isCorrect,
          recognition: validated.recognition,
          mode,
          answeredAt: answeredAtIso,
        },
        plan,
        now,
      );

      const appended = await context.repos.learning.appendEventAndUpdateState(
        {
          eventId: validated.eventId ?? context.ids.nextId(),
          userWordId,
          sessionId: validated.sessionId,
          mode,
          prompt: validated.prompt,
          answer: validated.answer,
          isCorrect: validated.isCorrect,
          recognition: validated.recognition,
          stageBefore: baseState.stage,
          stageAfter: next.stage,
          // 复习作答记“本次作答所履行的到期时间”；新词首答（stage === -1）没有到期概念，记 null。
          // 评估的 M 项靠它算“到期后 48h 内是否答对”，此处不给值 M 就会永远缺样本。
          dueAt: baseState.stage === STAGE_NEVER_REVIEWED ? null : baseState.dueAt,
          answeredAt: answeredAtIso,
          localDate: toLocalDateString(validated.answeredAt, plan.timeZone),
          timeZone: plan.timeZone,
          durationMs: validated.durationMs ?? null,
          deviceId: context.device.deviceId(),
          syncedAt: null,
        },
        next,
      );

      // 幂等命中时**不得**用内存里的 `next` 当事实（那会把计数加两次）。
      // 真实值一律回读库。
      const effective = appended.applied
        ? next
        : await context.repos.learning.getState(userWordId);
      if (effective === null) {
        // 只有在 `applied === false` 且状态又被外部删掉的情况下才会走到这里。
        throw new ServiceNotFoundError('learningState', userWordId);
      }

      // 正确答案按作答方向给出。EN_TO_ZH 的义项选择必须与 buildCard 同一条确定性规则
      // （selectAnswerSenseIndex + 会话快照里的种子），否则“卡片上考义项 2、
      // 反馈区却说正确答案是义项 1”这类口径分叉会出现；旧会话快照没有种子时
      // 回退 core 的「第一个非空义项」旧口径。
      const word = await context.repos.words.getWordById(validated.wordId);
      const senses = word === null ? [] : await loadSenses(word.id);
      let correctAnswer = '';
      if (word !== null) {
        if (mode === 'EN_TO_ZH') {
          const nonEmptySenses = senses.filter((sense) => sense.simpleZh.trim() !== '');
          const snapshotSeed = parseSessionSeed(session.planSnapshotJson);
          if (snapshotSeed !== null && nonEmptySenses.length > 0) {
            correctAnswer =
              nonEmptySenses[
                selectAnswerSenseIndex(snapshotSeed, word.id, nonEmptySenses.length)
              ]?.simpleZh.trim() ?? '';
          } else {
            correctAnswer = displayAnswerOf(toWordWithSenses(word, senses), mode);
          }
        } else {
          correctAnswer = displayAnswerOf(toWordWithSenses(word, senses), mode);
        }
      }

      const frequencyLookup =
        validated.exam !== undefined && validated.corpusVersion !== undefined
          ? await loadFrequencyLookup(context.repos.words, validated.exam, validated.corpusVersion)
          : null;

      return {
        applied: appended.applied,
        isCorrect: validated.isCorrect,
        correctAnswer,
        cumulativeWrongCount: effective.wrongCount,
        // 需求硬要求：答错且累计错次 >= 2 时提示“这个单词你已经错了 N 次”。
        // 答对恒为 false（否则用户会觉得“答对了还被念叨”）。
        showCumulativeWrongPrompt:
          !validated.isCorrect && effective.wrongCount >= CUMULATIVE_WRONG_PROMPT_THRESHOLD,
        nextDueAt: effective.dueAt,
        stage: effective.stage,
        weight: effective.weight,
        frequency: toFrequencyView(frequencyLookup, validated.wordId),
      };
    },

    async finishSession(input: { sessionId: string; now: Date }): Promise<SessionSummary> {
      const validated = parseOrThrow(finishSessionInputSchema, input, '结束学习');
      const session = await context.repos.learning.getSession(validated.sessionId);
      if (session === null) {
        throw new ServiceNotFoundError('session', validated.sessionId);
      }

      const events = await context.repos.learning.listEventsBySession(validated.sessionId);
      // 口径来自**事件事实**：`stageBefore === -1` 说明这次作答前该词从未进入复习阶段。
      // 不能用会话行上的 `new_count`（那是“开始时的队列长度”，中途删卡/跳过就会失真）。
      let newCount = 0;
      let correctCount = 0;
      let activeDurationMs = 0;
      for (const event of events) {
        if (event.stageBefore === STAGE_NEVER_REVIEWED) {
          newCount += 1;
        }
        if (event.isCorrect) {
          correctCount += 1;
        }
        activeDurationMs += event.durationMs ?? 0;
      }
      const totalAnswers = events.length;
      const reviewCount = totalAnswers - newCount;
      const endedAt = toIsoInstant(validated.now);

      // 中断的会话（`endedAt === null`）也能结束：会话行其余字段原样写回，
      // 因此 `planSnapshotJson` / `startedAt` / `localDate` 不会被“当前设置”覆盖。
      await context.repos.learning.upsertSession({
        ...session,
        endedAt,
        newCount,
        reviewCount,
        activeDurationMs,
        revision: session.revision,
      });

      return {
        sessionId: session.sessionId,
        deckId: session.deckId,
        startedAt: session.startedAt,
        endedAt,
        localDate: session.localDate,
        timeZone: session.timeZone,
        newCount,
        reviewCount,
        totalAnswers,
        correctCount,
        activeDurationMs,
      };
    },

    async suppressWord(input: { deckId: string; wordId: string; now: Date }): Promise<void> {
      const validated = parseOrThrow(wordRefInputSchema, input, '设置不再出现');
      await requireWordInDeck(validated.deckId, validated.wordId);
      const userWordId = makeUserWordId(validated.deckId, validated.wordId);
      const existing = await context.repos.learning.getState(userWordId);
      // 抑制是**状态变更**、不是一次作答：走 `updateState`（只写状态 + 一条发件箱），
      // 不会凭空造出一条假事件去污染正确率与时长统计。
      const next: LearningState =
        existing === null
          ? createInitialLearningState({
              userWordId,
              deckId: validated.deckId,
              wordId: validated.wordId,
              dueAt: toIsoInstant(validated.now),
            })
          : existing;
      await context.repos.learning.updateState(
        { ...next, suppressedAt: toIsoInstant(validated.now) },
        context.device.deviceId(),
        validated.now,
      );
    },

    async restoreWord(input: { deckId: string; wordId: string; now: Date }): Promise<void> {
      const validated = parseOrThrow(wordRefInputSchema, input, '取消不再出现');
      const userWordId = makeUserWordId(validated.deckId, validated.wordId);
      const existing = await context.repos.learning.getState(userWordId);
      if (existing === null) {
        // 没有状态 = 从来没被抑制过；此时该词本来就在新词池里，什么都不用做。
        return;
      }
      if (existing.suppressedAt === null) {
        return;
      }
      await context.repos.learning.updateState(
        { ...existing, suppressedAt: null },
        context.device.deviceId(),
        validated.now,
      );
    },
  };

  /**
   * 确认词库存在且词条在库内（否则外键失败会以一句 SQL 错误的形式冒到 UI）。
   *
   * @param deckId 词库 id。
   * @param wordId 词条 id。
   * @throws {ServiceNotFoundError} 词库或词条不存在，或词条不在该词库内。
   */
  async function requireWordInDeck(deckId: string, wordId: string): Promise<void> {
    const deck = await context.repos.words.getDeckById(deckId);
    if (deck === null) {
      throw new ServiceNotFoundError('deck', deckId);
    }
    const word = await context.repos.words.getWordById(wordId);
    if (word === null) {
      throw new ServiceNotFoundError('word', wordId);
    }
    const deckWordIds = await context.repos.words.listDeckWordIds(deckId);
    if (!deckWordIds.includes(wordId)) {
      throw new ServiceNotFoundError('deckWord', `${deckId}/${wordId}`);
    }
  }
}
