/**
 * 可解释的水平评估（设计 9）。
 *
 * 口径：**所选词库内的学习表现参考**，不是 CEFR / 雅思 / 考研分数。
 * 只统计最近 90 天、且作答时间不晚于 `now` 的事件；未来事件（时钟回拨）不计入。
 *
 * ```text
 * A = 最近 90 天加权正确率（最近 30 天权重 0.6，其余 0.4）
 * R = “认识”次数 / 有效作答次数
 * M = 到期复习中，在到期后 48 小时内答对的比例（无样本时取中性值 0.5 并明确标注）
 * E = exp(-wrongEvents / max(distinctAttemptedWords, 1))
 * S = 100 * clamp(0.50*A + 0.15*R + 0.25*M + 0.10*E, 0, 1)
 * coverage   = 至少答对一次的不同词数 / 当前词库词数
 * confidence = min(1, distinctWords/100) * min(1, validAnswers/200)
 * ```
 *
 * 样本门槛：至少 30 个不同词且至少 60 次有效作答，否则等级为 `INSUFFICIENT_SAMPLE`。
 *
 * 可追溯性（设计 §9）：结果同时带 `algorithmVersion`（口径版本号）、`generatedAt`
 * （= 注入的 `now`）与 `windowStart`/`windowEnd`（本次统计的 90 天闭区间），
 * 因此“这个分数是哪一版口径、算的是哪段时间”都能被复核。
 */

import { parseIsoInstant, toIsoInstant } from './clock';
import type { Recognition } from './models';
import { MS_PER_DAY } from './models';

/** 一条用于评估的作答事件（对应 `learning_events` 的投影）。 */
export interface AssessmentEvent {
  /** 词条 ID。 */
  wordId: string;
  /** 本次作答是否正确。 */
  isCorrect: boolean;
  /** 本次作答后的自我认识判断。 */
  recognition: Recognition;
  /** 作答时间（UTC ISO 8601 毫秒）。 */
  answeredAt: string;
  /** 本次作答对应的到期时间（UTC ISO 8601 毫秒），用于计算 M；非到期复习可省略。 */
  dueAt?: string;
}

/** 评估等级。 */
export type AssessmentLevel =
  | 'STABLE'
  | 'SOLID'
  | 'BUILDING'
  | 'NEEDS_WORK'
  | 'INSUFFICIENT_SAMPLE';

/**
 * 评估算法版本标识。
 *
 * 写进每次结果，便于解释“同一个分数是用哪一版口径算出来的”：
 * 权重/窗口/门槛任一口径变化都必须提升此版本号（设计 §9 的可追溯性要求）。
 */
export const ASSESSMENT_ALGORITHM_VERSION = '1.0.0';

/** 评估结果（字段与任务契约一致，另加 4 个可追溯字段）。 */
export interface AssessmentResult {
  /** 0–100 的综合得分；样本为空时为 0。 */
  score: number;
  /** 等级；样本不达标时恒为 `INSUFFICIENT_SAMPLE`。 */
  level: AssessmentLevel;
  /** 词库覆盖率：至少答对一次的不同词数 / 词库词数。 */
  coverage: number;
  /** 置信度：`min(1, distinctWords/100) * min(1, validAnswers/200)`。 */
  confidence: number;
  /** 窗口内作答过的不同词数（阈值与置信度用）。 */
  distinctWords: number;
  /** 窗口内有效作答次数。 */
  validAnswers: number;
  /** 面向用户的中文建议/说明（含“复习样本不足”等提示）。 */
  suggestions: string[];
  /** 评分算法版本（`ASSESSMENT_ALGORITHM_VERSION`）。 */
  algorithmVersion: string;
  /** 本次评估的生成时刻（UTC ISO 8601 毫秒），恒等于调用方注入的 `now`。 */
  generatedAt: string;
  /** 分析窗口起点（闭区间，UTC ISO 8601 毫秒）= `now - 90 天`。 */
  windowStart: string;
  /** 分析窗口终点（闭区间，UTC ISO 8601 毫秒）= `now`。 */
  windowEnd: string;
}

/**
 * 评估各分项（供 UI 展示“各分项”，不改变 `AssessmentResult` 契约）。
 */
export interface AssessmentComponents {
  /** A：加权正确率。 */
  accuracy: number;
  /** R：“认识”占比。 */
  recognitionRate: number;
  /** M：到期复习 48 小时内答对率（无样本时为中性值）。 */
  dueReviewScore: number;
  /** E：错误惩罚因子。 */
  errorPenalty: number;
  /** 窗口内有效作答次数。 */
  validAnswers: number;
  /** 窗口内答对次数。 */
  correctAnswers: number;
  /** 窗口内答错次数。 */
  wrongAnswers: number;
  /** 窗口内作答过的不同词数。 */
  distinctWords: number;
  /** 窗口内至少答对一次的不同词数。 */
  distinctCorrectWords: number;
  /** 窗口内“认识”次数。 */
  knownAnswers: number;
  /** 最近 30 天的作答次数。 */
  recentAnswers: number;
  /** 到期复习且在 48 小时内作答的样本数。 */
  dueReviewSamples: number;
  /** 上述样本中答对的次数。 */
  dueReviewCorrect: number;
  /** 是否存在到期复习样本（`false` 表示 M 用了中性值）。 */
  hasDueReviewSamples: boolean;
}

/** 评估窗口：最近 90 天。 */
export const ASSESSMENT_WINDOW_DAYS = 90;

/** 近期子窗口：最近 30 天。 */
export const ASSESSMENT_RECENT_WINDOW_DAYS = 30;

/** 近期子窗口权重。 */
export const RECENT_ACCURACY_WEIGHT = 0.6;

/** 较早子窗口权重。 */
export const EARLIER_ACCURACY_WEIGHT = 0.4;

/** A 项权重。 */
export const ACCURACY_SCORE_WEIGHT = 0.5;

/** R 项权重。 */
export const RECOGNITION_SCORE_WEIGHT = 0.15;

/** M 项权重。 */
export const DUE_REVIEW_SCORE_WEIGHT = 0.25;

/** E 项权重。 */
export const ERROR_PENALTY_SCORE_WEIGHT = 0.1;

/** 到期复习的“及时”窗口：48 小时。 */
export const DUE_REVIEW_ON_TIME_HOURS = 48;

/** 无到期复习样本时 M 的中性值。 */
export const NEUTRAL_DUE_REVIEW_SCORE = 0.5;

/** 达到等级所需的最少不同词数。 */
export const MIN_DISTINCT_WORDS = 30;

/** 达到等级所需的最少有效作答次数。 */
export const MIN_VALID_ANSWERS = 60;

/** “稳定掌握”分数线。 */
export const STABLE_SCORE_THRESHOLD = 85;

/** “较稳固”分数线。 */
export const SOLID_SCORE_THRESHOLD = 70;

/** “建设中”分数线。 */
export const BUILDING_SCORE_THRESHOLD = 50;

/** 置信度达到 1 所需的不同词数。 */
export const CONFIDENCE_WORD_SCALE = 100;

/** 置信度达到 1 所需的作答次数。 */
export const CONFIDENCE_ANSWER_SCALE = 200;

/** 评估输入非法时抛出的类型化错误。 */
export class InvalidAssessmentInputError extends Error {
  /** 错误码。 */
  readonly code = 'INVALID_ASSESSMENT_INPUT';

  /** 出错的字段名。 */
  readonly field: string;

  /**
   * @param field 出错字段。
   * @param message 错误说明。
   */
  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidAssessmentInputError';
    this.field = field;
  }
}

/**
 * 把数值钳制到 `[0, 1]`。
 *
 * @param value 原始值。
 * @returns 钳制结果。
 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * 宽松解析时间戳为毫秒；无法解析时返回 `null`。
 *
 * 单条事件的到期时间损坏只影响 M 的样本量，不应让整次评估失败。
 *
 * @param value ISO 8601 时间字符串。
 * @returns 毫秒数或 `null`。
 */
function tryParseMilliseconds(value: string): number | null {
  try {
    return parseIsoInstant(value, 'dueAt').getTime();
  } catch {
    return null;
  }
}

/**
 * 计算评估窗口内的各分项指标。
 *
 * @param events 该词库的作答事件（可包含窗口外事件，内部会过滤）。
 * @param now 注入的当前时刻。
 * @returns 各分项与计数。
 */
export function computeAssessmentComponents(
  events: readonly AssessmentEvent[],
  now: Date,
): AssessmentComponents {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new InvalidAssessmentInputError('now', '评估需要有效的当前时刻');
  }

  const nowMilliseconds = now.getTime();
  const windowStartMilliseconds = nowMilliseconds - ASSESSMENT_WINDOW_DAYS * MS_PER_DAY;
  const recentStartMilliseconds = nowMilliseconds - ASSESSMENT_RECENT_WINDOW_DAYS * MS_PER_DAY;
  const dueReviewWindowMilliseconds = DUE_REVIEW_ON_TIME_HOURS * 60 * 60 * 1000;

  const distinctWordIds = new Set<string>();
  const distinctCorrectWordIds = new Set<string>();

  let validAnswers = 0;
  let correctAnswers = 0;
  let wrongAnswers = 0;
  let knownAnswers = 0;
  let recentAnswers = 0;
  let recentCorrectAnswers = 0;
  let dueReviewSamples = 0;
  let dueReviewCorrect = 0;

  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object') {
      throw new InvalidAssessmentInputError('events', '作答事件不能为空');
    }
    if (typeof event.wordId !== 'string' || event.wordId.trim() === '') {
      throw new InvalidAssessmentInputError('wordId', '作答事件的 wordId 必须是非空字符串');
    }
    if (typeof event.isCorrect !== 'boolean') {
      throw new InvalidAssessmentInputError('isCorrect', '作答事件的 isCorrect 必须是布尔值');
    }
    if (event.recognition !== 'KNOWN' && event.recognition !== 'UNKNOWN') {
      throw new InvalidAssessmentInputError(
        'recognition',
        `作答事件的 recognition 只能是 KNOWN 或 UNKNOWN，收到 ${String(event.recognition)}`,
      );
    }

    let answeredAtMilliseconds: number;
    try {
      answeredAtMilliseconds = parseIsoInstant(event.answeredAt, 'answeredAt').getTime();
    } catch {
      throw new InvalidAssessmentInputError(
        'answeredAt',
        `无法解析作答时间：${String(event.answeredAt)}`,
      );
    }

    // 未来事件（时钟回拨/跨端偏差）与窗口外事件都不参与评估。
    if (answeredAtMilliseconds > nowMilliseconds || answeredAtMilliseconds < windowStartMilliseconds) {
      continue;
    }

    validAnswers += 1;
    distinctWordIds.add(event.wordId);
    if (event.isCorrect) {
      correctAnswers += 1;
      distinctCorrectWordIds.add(event.wordId);
    } else {
      wrongAnswers += 1;
    }
    if (event.recognition === 'KNOWN') {
      knownAnswers += 1;
    }
    if (answeredAtMilliseconds >= recentStartMilliseconds) {
      recentAnswers += 1;
      if (event.isCorrect) {
        recentCorrectAnswers += 1;
      }
    }

    const dueAtMilliseconds =
      typeof event.dueAt === 'string' && event.dueAt.trim() !== ''
        ? tryParseMilliseconds(event.dueAt)
        : null;
    if (
      dueAtMilliseconds !== null &&
      answeredAtMilliseconds >= dueAtMilliseconds &&
      answeredAtMilliseconds - dueAtMilliseconds <= dueReviewWindowMilliseconds
    ) {
      dueReviewSamples += 1;
      if (event.isCorrect) {
        dueReviewCorrect += 1;
      }
    }
  }

  const earlierAnswers = validAnswers - recentAnswers;
  const earlierCorrectAnswers = correctAnswers - recentCorrectAnswers;
  const recentAccuracy = recentAnswers > 0 ? recentCorrectAnswers / recentAnswers : null;
  const earlierAccuracy = earlierAnswers > 0 ? earlierCorrectAnswers / earlierAnswers : null;

  let accuracy = 0;
  if (recentAccuracy !== null && earlierAccuracy !== null) {
    // 归一化权重：避免某个子窗口为空时把人为的 0 掺进平均。
    accuracy =
      (RECENT_ACCURACY_WEIGHT * recentAccuracy + EARLIER_ACCURACY_WEIGHT * earlierAccuracy) /
      (RECENT_ACCURACY_WEIGHT + EARLIER_ACCURACY_WEIGHT);
  } else if (recentAccuracy !== null) {
    accuracy = recentAccuracy;
  } else if (earlierAccuracy !== null) {
    accuracy = earlierAccuracy;
  }

  const recognitionRate = validAnswers > 0 ? knownAnswers / validAnswers : 0;
  const dueReviewScore =
    dueReviewSamples > 0 ? dueReviewCorrect / dueReviewSamples : NEUTRAL_DUE_REVIEW_SCORE;
  const errorPenalty = Math.exp(-wrongAnswers / Math.max(distinctWordIds.size, 1));

  return {
    accuracy: clamp01(accuracy),
    recognitionRate: clamp01(recognitionRate),
    dueReviewScore: clamp01(dueReviewScore),
    errorPenalty: clamp01(errorPenalty),
    validAnswers,
    correctAnswers,
    wrongAnswers,
    distinctWords: distinctWordIds.size,
    distinctCorrectWords: distinctCorrectWordIds.size,
    knownAnswers,
    recentAnswers,
    dueReviewSamples,
    dueReviewCorrect,
    hasDueReviewSamples: dueReviewSamples > 0,
  };
}

/**
 * 等级判定的浮点容差：`0.5A+0.15R+0.25M+0.1E` 在恰好 0.85/0.70/0.50 时
 * 可能因二进制浮点误差落到下一档（例如 84.99999999999999），这里用极小容差兜住。
 */
const LEVEL_THRESHOLD_EPSILON = 1e-9;

/**
 * 按分数线给出等级（不含样本门槛）。
 *
 * @param score 0–100 的得分。
 * @returns 等级。
 */
export function levelFromScore(score: number): Exclude<AssessmentLevel, 'INSUFFICIENT_SAMPLE'> {
  if (!Number.isFinite(score)) {
    throw new InvalidAssessmentInputError('score', '得分必须是有限数字');
  }
  if (score + LEVEL_THRESHOLD_EPSILON >= STABLE_SCORE_THRESHOLD) {
    return 'STABLE';
  }
  if (score + LEVEL_THRESHOLD_EPSILON >= SOLID_SCORE_THRESHOLD) {
    return 'SOLID';
  }
  if (score + LEVEL_THRESHOLD_EPSILON >= BUILDING_SCORE_THRESHOLD) {
    return 'BUILDING';
  }
  return 'NEEDS_WORK';
}

/**
 * 把比例格式化为整数百分比文案。
 *
 * @param value `[0, 1]` 的比例。
 * @returns 例如 `42%`。
 */
function formatPercent(value: number): string {
  return `${Math.round(clamp01(value) * 100)}%`;
}

/**
 * 计算所选词库的水平评估。
 *
 * 两点口径说明（UI 需与之一致）：
 * 1. `validAnswers === 0` 时 `score` 直接为 0（不套公式，避免“0 次作答也有 22.5 分”的误导），
 *    等级仍为 `INSUFFICIENT_SAMPLE`；
 * 2. `A` 只在**有样本的子窗口**内加权（近 30 天 0.6 / 其余 0.4 按实际窗口归一），
 *    因此“只在今天做过题且全对”的用户 A 会是 100%，展示时应同时给出样本量。
 *
 * 窗口按 `90 × 24h` 固定毫秒计算（不按本地日历日），与实例时区无关；
 * 结果里回写 `windowStart`/`windowEnd`/`generatedAt`/`algorithmVersion`，
 * 让“这个分数是哪一版口径、算的是哪段时间”可被追溯（设计 §9）。
 *
 * @param events 该词库的作答事件。
 * @param deckSize 当前词库词数（用于 coverage）。
 * @param now 注入的当前时刻。
 * @returns 评估结果（含面向用户的建议与可追溯元信息）。
 */
export function evaluateAssessment(
  events: readonly AssessmentEvent[],
  deckSize: number,
  now: Date,
): AssessmentResult {
  if (typeof deckSize !== 'number' || !Number.isInteger(deckSize) || deckSize < 0) {
    throw new InvalidAssessmentInputError('deckSize', `词库词数必须是非负整数，收到 ${String(deckSize)}`);
  }

  const components = computeAssessmentComponents(events, now);
  const hasEnoughSamples =
    components.distinctWords >= MIN_DISTINCT_WORDS && components.validAnswers >= MIN_VALID_ANSWERS;

  const weightedScore =
    ACCURACY_SCORE_WEIGHT * components.accuracy +
    RECOGNITION_SCORE_WEIGHT * components.recognitionRate +
    DUE_REVIEW_SCORE_WEIGHT * components.dueReviewScore +
    ERROR_PENALTY_SCORE_WEIGHT * components.errorPenalty;
  // 没有任何有效作答时不给分数（避免“0 次作答却得 22.5 分”的误导）。
  const score = components.validAnswers === 0 ? 0 : 100 * clamp01(weightedScore);

  const coverage = deckSize > 0 ? clamp01(components.distinctCorrectWords / deckSize) : 0;
  const confidence =
    Math.min(1, components.distinctWords / CONFIDENCE_WORD_SCALE) *
    Math.min(1, components.validAnswers / CONFIDENCE_ANSWER_SCALE);

  const suggestions: string[] = [];
  if (!hasEnoughSamples) {
    suggestions.push(
      `样本不足：评估至少需要 ${MIN_DISTINCT_WORDS} 个不同词与 ${MIN_VALID_ANSWERS} 次有效作答` +
        `（当前 ${components.distinctWords} 个词 / ${components.validAnswers} 次作答），暂不评定等级。`,
    );
  }
  if (!components.hasDueReviewSamples) {
    // “说明型”提示，不是短板：必须在任何建议之前如实交代 M 用了中性值。
    suggestions.push(
      `复习样本不足：M（到期复习 ${DUE_REVIEW_ON_TIME_HOURS} 小时内答对率）按中性值 ${NEUTRAL_DUE_REVIEW_SCORE} 计算。`,
    );
  }

  // 建议由**最大短板**决定（设计 9）：先量化各维度缺口，再按缺口降序输出，首条标“首要短板”。
  const shortfalls: { gap: number; message: string }[] = [];
  if (components.validAnswers > 0 && components.accuracy < 0.6) {
    shortfalls.push({
      gap: 1 - components.accuracy,
      message: '正确率偏低：建议优先复习错词，并在错词本集中练习。',
    });
  }
  if (components.hasDueReviewSamples && components.dueReviewScore < 0.6) {
    shortfalls.push({
      gap: 1 - components.dueReviewScore,
      message: '到期复习完成度偏低：建议减少每日新词，先清理逾期复习。',
    });
  }
  if (components.validAnswers > 0 && coverage < 0.3) {
    // 零作答时不算“覆盖偏低”：没有样本就没有短板，否则首屏会出现
    // “首要短板：词库覆盖偏低（0%）”这种把「还没开始」说成「做得差」的误导（复审 U1）。
    shortfalls.push({
      gap: 1 - coverage,
      message: `词库覆盖偏低（${formatPercent(coverage)}）：建议适当增加新词，扩大已掌握范围。`,
    });
  }
  if (components.validAnswers > 0 && Math.abs(components.recognitionRate - components.accuracy) >= 0.25) {
    shortfalls.push({
      gap: Math.abs(components.recognitionRate - components.accuracy),
      message: '自评“认识”与实际正确率差异较大：建议减少猜测，增加语境练习。',
    });
  }

  // Array.prototype.sort 稳定：缺口相同时保持上面的固定定义顺序，结果可复现。
  shortfalls.sort((left, right) => right.gap - left.gap);
  shortfalls.forEach((shortfall, index) => {
    suggestions.push(index === 0 ? `首要短板：${shortfall.message}` : `次要短板：${shortfall.message}`);
  });

  if (suggestions.length === 0) {
    suggestions.push('各项指标均衡，保持当前节奏即可。');
  }

  return {
    score,
    level: hasEnoughSamples ? levelFromScore(score) : 'INSUFFICIENT_SAMPLE',
    coverage,
    confidence,
    distinctWords: components.distinctWords,
    validAnswers: components.validAnswers,
    suggestions,
    algorithmVersion: ASSESSMENT_ALGORITHM_VERSION,
    // 两者都从注入的 `now` 派生（绝不调用 `Date.now()`），因此结果可重放、可对账。
    generatedAt: toIsoInstant(now),
    windowStart: toIsoInstant(new Date(now.getTime() - ASSESSMENT_WINDOW_DAYS * MS_PER_DAY)),
    windowEnd: toIsoInstant(now),
  };
}
