/**
 * 每日队列构建与确定性交错。
 *
 * 规则来自系统设计 5.2：
 * - 复习池：`lastReviewedAt != null` 且 `dueAt <= now`，并按
 *   `逾期天数 DESC → 权重 DESC → 到期时间 ASC → wordId ASC` 排序；
 *   逾期天数按 **`plan.timeZone` 下的本地日历日** 差值计算（不是毫秒除法，也不用宿主机时区），
 *   因此“昨天 23:59 到期、今天 00:01 作答”算逾期 1 天。
 * - 新词池：只取“未见过”的词 —— 既包括调用方给出的 `unseenWordIds`（保持词库顺序），
 *   也包括**已建状态但从未作答**（`lastReviewedAt == null`）的词，避免这些词在两个池里都消失。
 *   不用未知词频伪造优先级。
 * - “不再出现”（`suppressedAt != null`）的词在复习与新词池中都被过滤。
 * - 交错规则：按剩余池比例做**有种子的加权穿插**，并保证不再产生可避免的相邻重复。
 */

import { tryParseInstant, zonedDayNumber } from './clock';
import type { LearningState, ReviewPlan } from './models';
import { normalizeWeight } from './models';
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
  /** 词条 ID。 */
  readonly wordId: string;
  /** 到期时刻毫秒。 */
  readonly dueMilliseconds: number;
  /** 逾期本地日历日数，`>= 0`。 */
  readonly overdueDays: number;
  /** 已归一化的权重（非法历史值视为初始权重，与调度规则保持一致）。 */
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
 * 交替穿插复习与新词，并保证**不产生可避免的相邻重复**。
 *
 * 交错规则（确定性，可测试）：每一步按“剩余新词数 / 剩余总数”计算新词占比 `p`，
 * 从注入种子的 PRNG 取一个 `u ∈ [0,1)`，`u < p` 时预取新词、否则预取复习词；
 * 某一池耗尽后只取另一池。若预取的元素与上一个已输出元素相同，
 * 则改取另一池（另一池可用且不重复时）；两池都给不出不同元素时，
 * 丢弃该重复副本（推进指针、不写入结果）。因此当入参数组存在重叠或内部重复时，
 * 输出仍然不会出现相邻重复，且不会凭空造出新的词。
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
      takeNew = random() < newRemaining / (reviewRemaining + newRemaining);
    }

    const reviewHead = reviewRemaining > 0 ? reviews[reviewIndex] : null;
    const newHead = newRemaining > 0 ? news[newIndex] : null;
    const lastEmitted = result.length > 0 ? result[result.length - 1] : null;

    let candidate = takeNew ? newHead : reviewHead;
    if (candidate === null) {
      break;
    }

    if (candidate === lastEmitted) {
      const alternative = takeNew ? reviewHead : newHead;
      if (alternative !== null && alternative !== candidate) {
        takeNew = !takeNew;
        candidate = alternative;
      } else {
        // 两池的下一个元素都与上一个输出重复：丢弃该副本，避免相邻重复。
        if (takeNew) {
          newIndex += 1;
        } else {
          reviewIndex += 1;
        }
        continue;
      }
    }

    if (takeNew) {
      newIndex += 1;
    } else {
      reviewIndex += 1;
    }
    result.push(candidate);
  }

  return result;
}

/**
 * 构建某个词库的今日学习队列。
 *
 * @param states 该词库内全部学习状态（可包含未到期、未作答与已屏蔽的词）。
 * @param unseenWordIds 尚未学习过的词，按词库顺序给出。
 * @param plan 当前生效的复习计划（含 `timeZone`，逾期天数按该时区的本地日历计算）。
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
  options: { rotation?: 'SEQUENTIAL' | 'RANDOM' } = {},
): DailyQueue {
  assertValidReviewPlan(plan);
  // 随机轮换：新词池按种子确定性洗牌（同一天同一词库重开会话顺序一致）；
  // 默认 SEQUENTIAL 保持词库顺序（用户可感知的「按顺序背」）。
  const unseenOrder: readonly string[] =
    options.rotation === 'RANDOM' ? seededShuffle(unseenWordIds, 'rotation:' + seed) : unseenWordIds;

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError('buildDailyQueue 需要有效的 now 时刻');
  }

  const nowMilliseconds = now.getTime();
  const todayNumber = zonedDayNumber(now, plan.timeZone);

  // 第一遍：屏蔽词、已作答过的词、已建状态但从未作答的词。
  const suppressedWordIds = new Set<string>();
  const reviewedWordIds = new Set<string>();
  for (const state of states) {
    if (state.suppressedAt !== null) {
      suppressedWordIds.add(state.wordId);
    }
    if (state.lastReviewedAt !== null) {
      reviewedWordIds.add(state.wordId);
    }
  }

  // 第二遍：收集复习候选（已屏蔽、未作答过、未到期的一律排除）。
  const candidates: ReviewCandidate[] = [];
  for (const state of states) {
    if (state.suppressedAt !== null) {
      continue;
    }
    if (state.lastReviewedAt === null) {
      continue;
    }
    const due = tryParseInstant(state.dueAt);
    if (due === null) {
      // 时间戳损坏的行不应“立刻到期”，否则脏数据会全部涌进今日队列。
      continue;
    }
    const dueMilliseconds = due.getTime();
    if (dueMilliseconds > nowMilliseconds) {
      continue;
    }
    candidates.push({
      wordId: state.wordId,
      dueMilliseconds,
      overdueDays: Math.max(0, todayNumber - zonedDayNumber(due, plan.timeZone)),
      weight: normalizeWeight(state.weight),
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

  // 新词池：未学习过的词（保持词库顺序）→ 其次是“已建状态但从未作答”的词（保持传入顺序）。
  const newWordIds: string[] = [];
  const queuedNewWordIds = new Set<string>();
  for (const wordId of unseenOrder) {
    if (newWordIds.length >= plan.dailyNewLimit) {
      break;
    }
    if (
      reviewedWordIds.has(wordId) ||
      suppressedWordIds.has(wordId) ||
      queuedNewWordIds.has(wordId)
    ) {
      continue;
    }
    queuedNewWordIds.add(wordId);
    newWordIds.push(wordId);
  }
  for (const state of states) {
    if (newWordIds.length >= plan.dailyNewLimit) {
      break;
    }
    const wordId = state.wordId;
    if (
      state.lastReviewedAt !== null ||
      suppressedWordIds.has(wordId) ||
      queuedNewWordIds.has(wordId)
    ) {
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
