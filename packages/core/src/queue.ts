/**
 * 每日队列构建与确定性交错。
 *
 * 规则来自系统设计 5.2：
 * - 复习池：`lastReviewedAt != null` 且 `dueAt <= now`，并按
 *   `逾期天数 DESC → 权重 DESC → 到期时间 ASC → wordId ASC` 排序；
 *   逾期天数按**本地日历日**差值计算（不是毫秒除法），因此“昨天 23:59 到期、
 *   今天 00:01 作答”算逾期 1 天，符合“逾期天数”的直觉。
 * - 新词池：只取“未见过”的词（传入的 `unseenWordIds` 去掉已有学习状态的词），
 *   并保持调用方给出的词库顺序（`deckOrder`），不用未知词频伪造优先级。
 * - “不再出现”（`suppressedAt != null`）的词在复习与新词池中都被过滤。
 * - 交错规则：按剩余池比例做**有种子的加权穿插**，并保证相邻不重复。
 */

import { tryParseInstant } from './clock';
import type { LearningState, ReviewPlan } from './models';
import { MS_PER_DAY } from './models';
import { assertValidReviewPlan } from './scheduler';

/** 每日队列结果。 */
export interface DailyQueue {
  /** 今日到期复习词（已排序、已按上限截断）。 */
  reviewWordIds: string[];
  /** 今日新词（词库顺序、已按上限截断）。 */
  newWordIds: string[];
  /** 复习与新词交错后的今日学习序列。 */
  interleavedWordIds: string[];
}

/** 复习候选项（内部使用，携带排序所需的预计算值）。 */
interface ReviewCandidate {
  readonly wordId: string;
  /** 到期时刻毫秒。 */
  readonly dueMilliseconds: number;
  /** 逾期本地日历日数，`>= 0`。 */
  readonly overdueDays: number;
  /** 权重（非法值按 0 处理会破坏排序语义，因此按传入原值参与比较）。 */
  readonly weight: number;
}

/** 32 位 FNV-1a 字符串哈希，用作 PRNG 种子。 */
function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * 创建确定性伪随机数发生器（mulberry32 + FNV-1a 种子）。
 *
 * 同一 `seed` 在任何端、任何时刻都产出同一序列，因此队列顺序可重放、可测试。
 *
 * @param seed 字符串种子。
 * @returns 返回 `[0, 1)` 随机数的函数。
 */
export function createSeededRandom(seed: string): () => number {
  let state = hashSeed(seed);
  if (state === 0) {
    state = 0x9e3779b9;
  }
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 确定性 Fisher–Yates 洗牌（不修改入参，供干扰项生成等后续任务复用）。
 *
 * @param items 待洗牌数组。
 * @param seed 字符串种子。
 * @returns 新数组。
 */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const result = [...items];
  const random = createSeededRandom(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = result[index];
    result[index] = result[swapIndex];
    result[swapIndex] = current;
  }
  return result;
}

/**
 * 把本地日历日折算为可比较的整数天序号。
 *
 * @param instant 时刻。
 * @returns 天数序号（本地日历日）。
 */
function localDayNumber(instant: Date): number {
  return Math.floor(
    Date.UTC(instant.getFullYear(), instant.getMonth(), instant.getDate()) / MS_PER_DAY,
  );
}

/**
 * 复习池排序比较器：逾期天数降序 → 权重降序 → 到期时间升序 → wordId 升序。
 *
 * @param left 左候选。
 * @param right 右候选。
 * @returns 比较结果。
 */
function compareReviewCandidates(left: ReviewCandidate, right: ReviewCandidate): number {
  if (left.overdueDays !== right.overdueDays) {
    return right.overdueDays - left.overdueDays;
  }
  if (left.weight !== right.weight) {
    return right.weight - left.weight;
  }
  if (left.dueMilliseconds !== right.dueMilliseconds) {
    return left.dueMilliseconds - right.dueMilliseconds;
  }
  if (left.wordId === right.wordId) {
    return 0;
  }
  return left.wordId < right.wordId ? -1 : 1;
}

/**
 * 交替穿插复习与新词，保证相邻元素不重复。
 *
 * 交错规则（确定性，可测试）：每一步按“剩余新词数 / 剩余总数”计算新词占比 `p`，
 * 从注入种子的 PRNG 取一个 `u ∈ [0,1)`，`u < p` 时取新词、否则取复习词；
 * 某一池耗尽后只取另一池。若本次选择会与上一个元素重复，则改取另一池（另一池可用时）。
 * 因为比较次数只由输入长度决定，所以同一 `(reviews, news, seed)` 永远得到同一结果。
 *
 * @param reviewWordIds 复习序列（已按优先级排序）。
 * @param newWordIds 新词序列（词库顺序）。
 * @param seed 字符串种子。
 * @returns 交错后的序列。
 */
export function interleaveWordIds(
  reviewWordIds: readonly string[],
  newWordIds: readonly string[],
  seed: string,
): string[] {
  const reviews = [...reviewWordIds];
  const news = [...newWordIds];

  if (reviews.length === 0) {
    return news;
  }
  if (news.length === 0) {
    return reviews;
  }

  const random = createSeededRandom(seed);
  const result: string[] = [];
  let reviewIndex = 0;
  let newIndex = 0;

  while (reviewIndex < reviews.length || newIndex < news.length) {
    const reviewRemaining = reviews.length - reviewIndex;
    const newRemaining = news.length - newIndex;

    let takeNew: boolean;
    if (reviewRemaining === 0) {
      takeNew = true;
    } else if (newRemaining === 0) {
      takeNew = false;
    } else {
      const newShare = newRemaining / (reviewRemaining + newRemaining);
      takeNew = random() < newShare;
    }

    let wordId = takeNew ? news[newIndex] : reviews[reviewIndex];
    const previousWordId = result.length > 0 ? result[result.length - 1] : null;

    if (previousWordId !== null && wordId === previousWordId) {
      const otherPoolAvailable = takeNew ? reviewRemaining > 0 : newRemaining > 0;
      if (otherPoolAvailable) {
        takeNew = !takeNew;
        wordId = takeNew ? news[newIndex] : reviews[reviewIndex];
      }
    }

    if (takeNew) {
      newIndex += 1;
    } else {
      reviewIndex += 1;
    }
    result.push(wordId);
  }

  return result;
}

/**
 * 构建某个词库的今日学习队列。
 *
 * @param states 该词库内全部学习状态（可包含未到期与已屏蔽的词）。
 * @param unseenWordIds 尚未学习过的词，按词库顺序给出。
 * @param plan 当前生效的复习计划。
 * @param now 注入的当前时刻。
 * @param seed 交错用字符串种子（同一 seed 结果可重放）。
 * @returns 复习序列、新词序列与交错序列。
 * @throws {InvalidReviewPlanError} 计划参数非法。
 */
export function buildDailyQueue(
  states: readonly LearningState[],
  unseenWordIds: readonly string[],
  plan: ReviewPlan,
  now: Date,
  seed: string,
): DailyQueue {
  assertValidReviewPlan(plan);

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError('buildDailyQueue 需要有效的 now 时刻');
  }

  const nowMilliseconds = now.getTime();
  const todayNumber = localDayNumber(now);

  // 第一遍：确定被“不再出现”屏蔽的词与已有学习记录的词。
  const suppressedWordIds = new Set<string>();
  const learnedWordIds = new Set<string>();
  for (const state of states) {
    learnedWordIds.add(state.wordId);
    if (state.suppressedAt !== null) {
      suppressedWordIds.add(state.wordId);
    }
  }

  // 第二遍：收集复习候选（已屏蔽、未作答过、未到期的一律排除）。
  const candidates: ReviewCandidate[] = [];
  for (const state of states) {
    if (state.suppressedAt !== null || suppressedWordIds.has(state.wordId)) {
      continue;
    }
    if (state.lastReviewedAt === null) {
      continue;
    }
    const due = tryParseInstant(state.dueAt);
    if (due === null) {
      // 时间戳损坏的行不应“立刻到期”，否则会把脏数据全部塞进今日队列。
      continue;
    }
    const dueMilliseconds = due.getTime();
    if (dueMilliseconds > nowMilliseconds) {
      continue;
    }
    candidates.push({
      wordId: state.wordId,
      dueMilliseconds,
      overdueDays: Math.max(0, todayNumber - localDayNumber(due)),
      weight: Number.isFinite(state.weight) ? state.weight : 0,
    });
  }

  candidates.sort(compareReviewCandidates);

  const reviewWordIds: string[] = [];
  const takenWordIds = new Set<string>();
  for (const candidate of candidates) {
    if (reviewWordIds.length >= plan.dailyReviewLimit) {
      break;
    }
    if (takenWordIds.has(candidate.wordId)) {
      // 同一词可能在不同词库各有一条状态；队列以 wordId 为单位，只保留优先级最高的一条。
      continue;
    }
    takenWordIds.add(candidate.wordId);
    reviewWordIds.push(candidate.wordId);
  }

  const newWordIds: string[] = [];
  const queuedNewWordIds = new Set<string>();
  for (const wordId of unseenWordIds) {
    if (newWordIds.length >= plan.dailyNewLimit) {
      break;
    }
    if (learnedWordIds.has(wordId) || suppressedWordIds.has(wordId) || queuedNewWordIds.has(wordId)) {
      continue;
    }
    queuedNewWordIds.add(wordId);
    newWordIds.push(wordId);
  }

  return {
    reviewWordIds,
    newWordIds,
    interleavedWordIds: interleaveWordIds(reviewWordIds, newWordIds, seed),
  };
}
