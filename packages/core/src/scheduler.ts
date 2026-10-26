/**
 * 可解释的学习调度器。
 *
 * 全部规则来自系统设计 5.1，逐字对应：
 * - 新词 `stage=-1`；答对且“认识”`-1 → 0` 并使用 `intervalsDays[0]`；
 * - 答对且“认识”先升 stage（上限 `intervalsDays.length-1`）再用新 stage 的间隔；
 * - 答错 `stage=max(stage-1,-1)`、连对清零、错次 +1、权重 ×1.75、10 分钟后重练；
 * - 答对但“不认识”阶段不升、权重不变、安排次日；
 * - 权重乘数 0.8 / 1.75，钳制到 `[0.25, 4.0]`；
 * - 到期时刻 = 作答时间 + N 天的目标本地日 09:00（无学习时段时的默认窗口）。
 *
 * 时间全部由参数 `now` / `answer.answeredAt` 注入，函数是纯函数：不读系统时钟、不改入参。
 */

import { addMilliseconds, parseIsoInstant, toIsoInstant } from './clock';
import type { AnswerInput, LearningState, ReviewPlan } from './models';
import {
  DAILY_LIMIT_MAX,
  DAILY_LIMIT_MIN,
  INITIAL_WEIGHT,
  INTERVAL_DAYS_MAX,
  INTERVAL_DAYS_MIN,
  INTERVAL_NODE_COUNT_MAX,
  INTERVAL_NODE_COUNT_MIN,
  RECOGNITION_UNKNOWN_INTERVAL_DAYS,
  RETRY_AFTER_WRONG_MS,
  STAGE_NEVER_REVIEWED,
  STUDY_WINDOW_START_HOUR,
  WEIGHT_MAX,
  WEIGHT_MIN,
  WEIGHT_MULTIPLIER_ON_CORRECT_KNOWN,
  WEIGHT_MULTIPLIER_ON_WRONG,
} from './models';

/** 一条复习计划参数的问题描述。 */
export interface ReviewPlanValidationIssue {
  /** 出问题的字段名，例如 `intervalsDays[2]`。 */
  readonly field: string;
  /** 面向用户的中文说明。 */
  readonly message: string;
}

/** 复习计划校验结果（不抛错的写法，便于设置页直接展示字段级错误）。 */
export type ReviewPlanValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly ReviewPlanValidationIssue[] };

/**
 * 复习计划非法时抛出的类型化错误。
 *
 * 设计 5.1 明确要求“拒绝保存并指出字段”，因此这里绝不静默回退到默认间隔。
 */
export class InvalidReviewPlanError extends Error {
  /** 错误码，便于应用服务映射。 */
  readonly code = 'INVALID_REVIEW_PLAN';

  /** 全部字段级问题。 */
  readonly issues: readonly ReviewPlanValidationIssue[];

  /**
   * @param issues 字段级问题列表。
   */
  constructor(issues: readonly ReviewPlanValidationIssue[]) {
    super(`复习计划参数非法：${issues.map((issue) => `${issue.field} ${issue.message}`).join('；')}`);
    this.name = 'InvalidReviewPlanError';
    this.issues = issues;
  }
}

/** 作答时间非法时抛出的类型化错误（字段名记录在 `field` 上）。 */
export class InvalidAnswerError extends Error {
  /** 错误码，便于应用服务映射。 */
  readonly code = 'INVALID_ANSWER';

  /** 出错的字段名。 */
  readonly field: string;

  /**
   * @param field 出错的字段名。
   * @param message 错误说明。
   */
  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidAnswerError';
    this.field = field;
  }
}

/**
 * 校验整数天数节点：必须为整数、落在 `1..365`、严格递增、去重。
 *
 * @param intervalsDays 待校验的天数节点数组。
 * @returns 字段级问题列表，空数组表示通过。
 */
function collectIntervalIssues(intervalsDays: readonly number[]): ReviewPlanValidationIssue[] {
  const issues: ReviewPlanValidationIssue[] = [];

  if (intervalsDays.length < INTERVAL_NODE_COUNT_MIN || intervalsDays.length > INTERVAL_NODE_COUNT_MAX) {
    issues.push({
      field: 'intervalsDays',
      message: `节点数量必须是 ${INTERVAL_NODE_COUNT_MIN}..${INTERVAL_NODE_COUNT_MAX} 个，当前 ${intervalsDays.length} 个`,
    });
  }

  const seen = new Set<number>();
  let previousValue = Number.NEGATIVE_INFINITY;

  intervalsDays.forEach((value, index) => {
    const field = `intervalsDays[${index}]`;

    if (typeof value !== 'number' || !Number.isInteger(value)) {
      issues.push({ field, message: `必须是整数天数，当前 ${String(value)}` });
      return;
    }
    if (value < INTERVAL_DAYS_MIN || value > INTERVAL_DAYS_MAX) {
      issues.push({
        field,
        message: `必须在 ${INTERVAL_DAYS_MIN}..${INTERVAL_DAYS_MAX} 天之间，当前 ${value}`,
      });
      return;
    }
    if (seen.has(value)) {
      issues.push({ field, message: `节点重复：${value}` });
      return;
    }
    if (value <= previousValue) {
      issues.push({ field, message: `必须严格递增，${value} 不大于前一个节点 ${previousValue}` });
      return;
    }
    seen.add(value);
    previousValue = value;
  });

  return issues;
}

/**
 * 校验每日数量：必须为整数、落在 `0..500`，且新词与复习不能同时为 0。
 *
 * @param field 字段名。
 * @param value 待校验的数量。
 * @returns 字段级问题列表。
 */
function collectDailyLimitIssues(field: string, value: number): ReviewPlanValidationIssue[] {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return [{ field, message: `必须是整数，当前 ${String(value)}` }];
  }
  if (value < DAILY_LIMIT_MIN || value > DAILY_LIMIT_MAX) {
    return [
      {
        field,
        message: `必须在 ${DAILY_LIMIT_MIN}..${DAILY_LIMIT_MAX} 之间，当前 ${value}`,
      },
    ];
  }
  return [];
}

/**
 * 校验复习计划（返回结果对象，不抛错）。
 *
 * @param plan 待校验的计划。
 * @returns 校验结果。
 */
export function validateReviewPlan(plan: ReviewPlan): ReviewPlanValidationResult {
  const issues: ReviewPlanValidationIssue[] = [];

  if (plan === null || typeof plan !== 'object') {
    return {
      ok: false,
      issues: [{ field: 'plan', message: '复习计划不能为空' }],
    };
  }

  if (!Array.isArray(plan.intervalsDays)) {
    issues.push({ field: 'intervalsDays', message: '必须是天数数组' });
  } else {
    issues.push(...collectIntervalIssues(plan.intervalsDays));
  }

  issues.push(...collectDailyLimitIssues('dailyNewLimit', plan.dailyNewLimit));
  issues.push(...collectDailyLimitIssues('dailyReviewLimit', plan.dailyReviewLimit));

  const bothZero = plan.dailyNewLimit === 0 && plan.dailyReviewLimit === 0;
  if (bothZero) {
    issues.push({
      field: 'dailyNewLimit',
      message: '每日新词数与复习数不能同时为 0，至少一项需大于 0',
    });
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/**
 * 校验复习计划，非法时抛出 `InvalidReviewPlanError`。
 *
 * @param plan 待校验的计划。
 */
export function assertValidReviewPlan(plan: ReviewPlan): void {
  const result = validateReviewPlan(plan);
  if (!result.ok) {
    throw new InvalidReviewPlanError(result.issues);
  }
}

/**
 * 计划的最高阶段下标：`intervalsDays.length - 1`。
 *
 * @param plan 已校验的复习计划。
 * @returns 最高阶段下标。
 */
export function lastStageOf(plan: ReviewPlan): number {
  return plan.intervalsDays.length - 1;
}

/**
 * 取某个阶段对应的间隔天数。
 *
 * @param plan 已校验的复习计划。
 * @param stage 非负阶段值，超出范围时钳制到合法区间。
 * @returns 间隔天数。
 */
export function intervalDaysForStage(plan: ReviewPlan, stage: number): number {
  const lastStage = lastStageOf(plan);
  const safeStage = Math.min(Math.max(Math.trunc(stage), 0), lastStage);
  return plan.intervalsDays[safeStage];
}

/**
 * 把权重钳制到 `[0.25, 4.0]`；历史数据里的非法值回退到初始权重。
 *
 * @param weight 待钳制的权重。
 * @returns 合法权重。
 */
export function clampWeight(weight: number): number {
  if (typeof weight !== 'number' || !Number.isFinite(weight)) {
    return INITIAL_WEIGHT;
  }
  return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, weight));
}

/**
 * 计算“作答时间 + N 天”的目标本地日学习窗口开始时刻（默认本地 09:00）。
 *
 * 按设计 5.1：到期时刻由目标本地日与学习窗口开始时刻决定；
 * 若所得时刻不晚于作答时刻（例如 DST 折返或调用方传 0 天），顺延到下一个有效窗口，
 * 避免当天提前作答后立刻再次到期。
 *
 * @param answerInstant 作答时刻。
 * @param intervalDays 间隔天数，必须是 `1..365` 的整数。
 * @returns 到期时刻。
 */
export function nextDueInStudyWindow(answerInstant: Date, intervalDays: number): Date {
  if (Number.isNaN(answerInstant.getTime())) {
    throw new InvalidAnswerError('answeredAt', '作答时间无效，无法计算到期时间');
  }
  if (!Number.isInteger(intervalDays) || intervalDays < INTERVAL_DAYS_MIN || intervalDays > INTERVAL_DAYS_MAX) {
    throw new RangeError(
      `到期间隔必须是 ${INTERVAL_DAYS_MIN}..${INTERVAL_DAYS_MAX} 的整数天，收到 ${String(intervalDays)}`,
    );
  }

  const answerMilliseconds = answerInstant.getTime();
  let dayOffset = intervalDays;
  let candidate = startOfStudyDay(answerInstant, dayOffset);

  while (candidate.getTime() <= answerMilliseconds) {
    dayOffset += 1;
    if (dayOffset > intervalDays + INTERVAL_DAYS_MAX) {
      throw new RangeError('无法计算出晚于作答时刻的学习窗口');
    }
    candidate = startOfStudyDay(answerInstant, dayOffset);
  }

  return candidate;
}

/**
 * 以 `reference` 的本地日历日 + `dayOffset` 天、`STUDY_WINDOW_START_HOUR` 点构造时刻。
 *
 * 使用年/月/日分量加法而不是毫秒加法，跨 DST 时依然落在“目标本地日”的窗口开始时刻。
 *
 * @param reference 参考时刻。
 * @param dayOffset 本地日历日偏移。
 * @returns 目标时刻。
 */
function startOfStudyDay(reference: Date, dayOffset: number): Date {
  return new Date(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate() + dayOffset,
    STUDY_WINDOW_START_HOUR,
    0,
    0,
    0,
  );
}

/**
 * 解析作答时刻：`answeredAt` 为准；若晚于注入时钟 `now`（时钟回拨/偏差），
 * 以 `now` 为准，避免生成落在未来的到期时间。
 *
 * @param answeredAt 作答时间字符串。
 * @param now 注入的当前时刻。
 * @returns 用于计算的作答时刻。
 */
function resolveAnswerInstant(answeredAt: string, now: Date): Date {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new InvalidAnswerError('now', '注入的当前时刻无效');
  }

  let parsed: Date;
  try {
    parsed = parseIsoInstant(answeredAt, 'answeredAt');
  } catch {
    throw new InvalidAnswerError('answeredAt', `无法解析作答时间：${String(answeredAt)}`);
  }

  return parsed.getTime() > now.getTime() ? new Date(now.getTime()) : parsed;
}

/**
 * 把已有状态迁移到当前计划允许的阶段区间 `[-1, lastStage]`（计划缩短后不越界）。
 *
 * @param stage 历史阶段值。
 * @param lastStage 当前计划最高阶段。
 * @returns 合法阶段值。
 */
function normalizeStage(stage: number, lastStage: number): number {
  if (!Number.isFinite(stage)) {
    return STAGE_NEVER_REVIEWED;
  }
  return Math.min(Math.max(Math.trunc(stage), STAGE_NEVER_REVIEWED), lastStage);
}

/**
 * 根据一次作答计算新的学习状态（纯函数，不修改入参）。
 *
 * @param state 作答前的学习状态。
 * @param answer 作答输入。
 * @param plan 当前生效的复习计划。
 * @param now 注入的当前时刻（用于校验/兜底作答时间）。
 * @returns 作答后的新学习状态。
 * @throws {InvalidReviewPlanError} 计划参数非法。
 * @throws {InvalidAnswerError} 作答时间非法。
 */
export function nextLearningState(
  state: LearningState,
  answer: AnswerInput,
  plan: ReviewPlan,
  now: Date,
): LearningState {
  assertValidReviewPlan(plan);

  const answerInstant = resolveAnswerInstant(answer.answeredAt, now);
  const answeredAtIso = toIsoInstant(answerInstant);
  const lastStage = lastStageOf(plan);
  const stageBefore = normalizeStage(state.stage, lastStage);

  // 答错：退级、连对清零、错次 +1、权重 ×1.75，10 分钟后短练习。
  if (!answer.isCorrect) {
    return {
      ...state,
      stage: Math.max(stageBefore - 1, STAGE_NEVER_REVIEWED),
      dueAt: toIsoInstant(addMilliseconds(answerInstant, RETRY_AFTER_WRONG_MS)),
      lastReviewedAt: answeredAtIso,
      correctCount: state.correctCount,
      wrongCount: state.wrongCount + 1,
      streakCorrect: 0,
      weight: clampWeight(safeWeight(state.weight) * WEIGHT_MULTIPLIER_ON_WRONG),
    };
  }

  // 答对且“认识”：先升阶段，再用新阶段的间隔；权重 ×0.8。
  if (answer.recognition === 'KNOWN') {
    const stage = Math.min(stageBefore + 1, lastStage);
    const dueAt = nextDueInStudyWindow(answerInstant, intervalDaysForStage(plan, stage));

    return {
      ...state,
      stage,
      dueAt: toIsoInstant(dueAt),
      lastReviewedAt: answeredAtIso,
      correctCount: state.correctCount + 1,
      wrongCount: state.wrongCount,
      streakCorrect: state.streakCorrect + 1,
      weight: clampWeight(safeWeight(state.weight) * WEIGHT_MULTIPLIER_ON_CORRECT_KNOWN),
    };
  }

  // 答对但“不认识”：阶段不升、权重不变，安排次日。
  const dueAt = nextDueInStudyWindow(answerInstant, RECOGNITION_UNKNOWN_INTERVAL_DAYS);

  return {
    ...state,
    stage: stageBefore,
    dueAt: toIsoInstant(dueAt),
    lastReviewedAt: answeredAtIso,
    correctCount: state.correctCount + 1,
    wrongCount: state.wrongCount,
    streakCorrect: state.streakCorrect + 1,
    weight: clampWeight(safeWeight(state.weight)),
  };
}

/**
 * 读取状态的权重，非法时回退到初始权重（不修改入参）。
 *
 * @param weight 历史权重值。
 * @returns 可参与乘法的权重。
 */
function safeWeight(weight: number): number {
  if (typeof weight !== 'number' || !Number.isFinite(weight)) {
    return INITIAL_WEIGHT;
  }
  return weight;
}
