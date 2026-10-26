/**
 * 可解释的学习调度器。
 *
 * 全部规则来自系统设计 5.1，逐字对应：
 * - 新词 `stage=-1`；答对且“认识”`-1 → 0` 并使用 `intervalsDays[0]`；
 * - 答对且“认识”先升 stage（上限 `intervalsDays.length-1`）再用新 stage 的间隔；
 * - 答错 `stage=max(stage-1,-1)`、连对清零、错次 +1、权重 ×1.75、10 分钟后重练；
 * - 答对但“不认识”阶段不升、权重**原样不变**、安排次日；
 * - 权重乘数 0.8 / 1.75，钳制到 `[0.25, 4.0]`；
 * - 到期时刻 = 作答时间 + N 天，换算到 `plan.timeZone` 的目标本地日 09:00 再转回 UTC。
 *
 * 两条不变量：
 * 1. 时间是注入的：函数不读系统时钟，也不使用宿主机本地时区；
 * 2. 永远以 `answer.answeredAt` 为准计算并写入 `lastReviewedAt`：绝不改写作答时间。
 *    若作答时间明显晚于 `now`，抛 `ClockSkewError`，由应用服务层决定如何提示/校正。
 */

import {
  addDaysToCivilDate,
  addMilliseconds,
  isValidTimeZone,
  localWallTimeToInstant,
  parseIsoInstant,
  toIsoInstant,
  zonedDateTimeParts,
} from './clock';
import type { CivilDate } from './clock';
import type { AnswerInput, LearningState, ReviewPlan } from './models';
import {
  DAILY_LIMIT_MAX,
  DAILY_LIMIT_MIN,
  INTERVAL_DAYS_MAX,
  INTERVAL_DAYS_MIN,
  INTERVAL_NODE_COUNT_MAX,
  INTERVAL_NODE_COUNT_MIN,
  MAX_ANSWERED_AT_CLOCK_SKEW_MS,
  RECOGNITION_UNKNOWN_INTERVAL_DAYS,
  RETRY_AFTER_WRONG_MS,
  STAGE_NEVER_REVIEWED,
  STUDY_WINDOW_START_HOUR,
  WEIGHT_MULTIPLIER_ON_CORRECT_KNOWN,
  WEIGHT_MULTIPLIER_ON_WRONG,
  clampWeight,
  normalizeWeight,
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

/** 复习计划非法时抛出的类型化错误。 */
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

/** 作答输入非法时抛出的类型化错误（字段名记录在 `field` 上）。 */
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

/** 学习状态数据结构非法时抛出的类型化错误。 */
export class InvalidLearningStateError extends Error {
  /** 错误码，便于应用服务映射。 */
  readonly code = 'INVALID_LEARNING_STATE';

  /** 出错的字段名。 */
  readonly field: string;

  /**
   * @param field 出错的字段名。
   * @param message 错误说明。
   */
  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidLearningStateError';
    this.field = field;
  }
}

/**
 * 时钟异常：作答时间明显晚于注入的当前时刻。
 *
 * 核心层**不**改写 `answeredAt`（否则状态快照会与不可变事件不一致），
 * 只把事实抛给应用服务层：提示用户校准时钟、按事件重放或交由同步冲突处理。
 */
export class ClockSkewError extends Error {
  /** 错误码。 */
  readonly code = 'CLOCK_SKEW';

  /** 作答时间。 */
  readonly answeredAt: string;

  /** 注入的当前时刻。 */
  readonly now: string;

  /** 作答时间超前注入时钟的毫秒数。 */
  readonly skewMilliseconds: number;

  /**
   * @param answeredAt 作答时间（ISO 字符串）。
   * @param now 注入的当前时刻（ISO 字符串）。
   * @param skewMilliseconds 超前毫秒数。
   */
  constructor(answeredAt: string, now: string, skewMilliseconds: number) {
    super(
      `作答时间 ${answeredAt} 晚于当前时刻 ${now} 达 ${String(skewMilliseconds)} 毫秒，超出允许的时钟偏差 ${String(
        MAX_ANSWERED_AT_CLOCK_SKEW_MS,
      )} 毫秒`,
    );
    this.name = 'ClockSkewError';
    this.answeredAt = answeredAt;
    this.now = now;
    this.skewMilliseconds = skewMilliseconds;
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

  if (
    intervalsDays.length < INTERVAL_NODE_COUNT_MIN ||
    intervalsDays.length > INTERVAL_NODE_COUNT_MAX
  ) {
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
 * 校验每日数量：必须为整数、落在 `0..500`。
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
  if (plan === null || typeof plan !== 'object') {
    return {
      ok: false,
      issues: [{ field: 'plan', message: '复习计划不能为空' }],
    };
  }

  const issues: ReviewPlanValidationIssue[] = [];

  if (typeof plan.timeZone !== 'string' || plan.timeZone.trim() === '') {
    issues.push({ field: 'timeZone', message: '必须填写计划时区（IANA 标识，例如 Asia/Shanghai）' });
  } else if (!isValidTimeZone(plan.timeZone)) {
    issues.push({ field: 'timeZone', message: `不是运行时认识的 IANA 时区：${plan.timeZone}` });
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
 * @returns 通过校验的计划（便于链式使用）。
 */
export function assertValidReviewPlan(plan: ReviewPlan): ReviewPlan {
  const result = validateReviewPlan(plan);
  if (!result.ok) {
    throw new InvalidReviewPlanError(result.issues);
  }
  return plan;
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
 * 计算“作答时间 + N 天”在计划时区内的目标本地日 09:00，并转换为 UTC 时刻。
 *
 * 设计 5.1：到期时刻由目标本地日与学习窗口开始时刻决定；
 * 若所得时刻不晚于作答时刻（DST 空洞顺延、或调用方传入 0 天），顺延到下一个有效窗口，
 * 避免当天提前作答后立刻再次到期。
 *
 * @param answerInstant 作答时刻。
 * @param intervalDays 间隔天数，必须是 `1..365` 的整数。
 * @param timeZone 计划时区（IANA 标识）。
 * @returns 到期时刻（UTC）。
 */
export function nextDueInStudyWindow(
  answerInstant: Date,
  intervalDays: number,
  timeZone: string,
): Date {
  if (Number.isNaN(answerInstant.getTime())) {
    throw new InvalidAnswerError('answeredAt', '作答时间无效，无法计算到期时间');
  }
  if (
    !Number.isInteger(intervalDays) ||
    intervalDays < INTERVAL_DAYS_MIN ||
    intervalDays > INTERVAL_DAYS_MAX
  ) {
    throw new RangeError(
      `到期间隔必须是 ${INTERVAL_DAYS_MIN}..${INTERVAL_DAYS_MAX} 的整数天，收到 ${String(intervalDays)}`,
    );
  }

  const answerParts = zonedDateTimeParts(answerInstant, timeZone);
  const answerMilliseconds = answerInstant.getTime();
  const answerDate: CivilDate = {
    year: answerParts.year,
    month: answerParts.month,
    day: answerParts.day,
  };

  let dayOffset = intervalDays;
  let candidate = windowStartOf(addDaysToCivilDate(answerDate, dayOffset), timeZone);
  while (candidate.getTime() <= answerMilliseconds) {
    dayOffset += 1;
    if (dayOffset > intervalDays + INTERVAL_DAYS_MAX) {
      throw new RangeError('无法计算出晚于作答时刻的学习窗口');
    }
    candidate = windowStartOf(addDaysToCivilDate(answerDate, dayOffset), timeZone);
  }

  return candidate;
}

/**
 * 取某个公历日在指定时区的学习窗口开始时刻（09:00 墙上时间 → UTC 时刻）。
 *
 * @param date 公历日。
 * @param timeZone 计划时区。
 * @returns 该日窗口开始的 UTC 时刻。
 */
function windowStartOf(date: CivilDate, timeZone: string): Date {
  return localWallTimeToInstant(
    {
      year: date.year,
      month: date.month,
      day: date.day,
      hour: STUDY_WINDOW_START_HOUR,
      minute: 0,
      second: 0,
    },
    timeZone,
  );
}

/**
 * 校验学习状态的数据结构，非法时抛 `InvalidLearningStateError`。
 *
 * 目的是把“库里读到脏数据”变成可识别的类型化错误，而不是抛出裸 `TypeError`
 * 或静默把未知值当成某个默认值。
 *
 * @param state 待校验的学习状态。
 */
export function assertValidLearningState(state: LearningState): void {
  if (state === null || typeof state !== 'object') {
    throw new InvalidLearningStateError('state', '学习状态不能为空');
  }

  const identifiers: ReadonlyArray<keyof Pick<LearningState, 'userWordId' | 'deckId' | 'wordId'>> = [
    'userWordId',
    'deckId',
    'wordId',
  ];
  for (const field of identifiers) {
    const value = state[field];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new InvalidLearningStateError(field, `学习状态的 ${field} 必须是非空字符串`);
    }
  }

  const numbers: ReadonlyArray<
    keyof Pick<LearningState, 'stage' | 'correctCount' | 'wrongCount' | 'streakCorrect' | 'weight'>
  > = ['stage', 'correctCount', 'wrongCount', 'streakCorrect', 'weight'];
  for (const field of numbers) {
    const value = state[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InvalidLearningStateError(field, `学习状态的 ${field} 必须是有限数字，当前 ${String(value)}`);
    }
  }

  parseIsoInstantSafe(state.dueAt, 'dueAt');
  if (state.lastReviewedAt !== null) {
    parseIsoInstantSafe(state.lastReviewedAt, 'lastReviewedAt');
  }
  if (state.suppressedAt !== null) {
    parseIsoInstantSafe(state.suppressedAt, 'suppressedAt');
  }
}

/**
 * 解析学习状态里的时间字段，失败时抛 `InvalidLearningStateError`。
 *
 * @param value 时间字符串。
 * @param field 字段名。
 */
function parseIsoInstantSafe(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidLearningStateError(field, `学习状态的 ${field} 必须是非空 ISO 8601 时间字符串`);
  }
  try {
    parseIsoInstant(value, field);
  } catch {
    throw new InvalidLearningStateError(field, `学习状态的 ${field} 不是合法时间：${value}`);
  }
}

/**
 * 解析作答时刻：**始终以 `answeredAt` 为准**。
 *
 * 若作答时间晚于注入时钟超过 `MAX_ANSWERED_AT_CLOCK_SKEW_MS`，
 * 抛 `ClockSkewError`（不改写时间、不修改任何状态）；
 * 小于容差的超前视为正常延迟，照样按 `answeredAt` 计算。
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

  const skewMilliseconds = parsed.getTime() - now.getTime();
  if (skewMilliseconds > MAX_ANSWERED_AT_CLOCK_SKEW_MS) {
    throw new ClockSkewError(toIsoInstant(parsed), toIsoInstant(now), skewMilliseconds);
  }

  return parsed;
}

/**
 * 校验作答输入：`recognition` 只能是 `KNOWN` / `UNKNOWN`。
 *
 * @param answer 作答输入。
 */
function assertValidAnswer(answer: AnswerInput): void {
  if (answer === null || typeof answer !== 'object') {
    throw new InvalidAnswerError('answer', '作答输入不能为空');
  }
  if (answer.recognition !== 'KNOWN' && answer.recognition !== 'UNKNOWN') {
    throw new InvalidAnswerError(
      'recognition',
      `recognition 只能是 KNOWN 或 UNKNOWN，收到 ${String(answer.recognition)}`,
    );
  }
  if (typeof answer.isCorrect !== 'boolean') {
    throw new InvalidAnswerError('isCorrect', 'isCorrect 必须是布尔值');
  }
}

/**
 * 把已有状态迁移到当前计划允许的阶段区间 `[-1, lastStage]`（计划缩短后不越界）。
 *
 * @param stage 历史阶段值。
 * @param lastStage 当前计划最高阶段。
 * @returns 合法阶段值。
 */
function normalizeStage(stage: number, lastStage: number): number {
  return Math.min(Math.max(Math.trunc(stage), STAGE_NEVER_REVIEWED), lastStage);
}

/**
 * 根据一次作答计算新的学习状态（纯函数，不修改入参）。
 *
 * @param state 作答前的学习状态。
 * @param answer 作答输入。
 * @param plan 当前生效的复习计划。
 * @param now 注入的当前时刻（仅用于时钟偏差检查，不参与到期时间基准）。
 * @returns 作答后的新学习状态。
 * @throws {InvalidReviewPlanError} 计划参数非法。
 * @throws {InvalidAnswerError} 作答输入非法。
 * @throws {InvalidLearningStateError} 学习状态数据结构非法。
 * @throws {ClockSkewError} 作答时间明显晚于注入时钟。
 */
export function nextLearningState(
  state: LearningState,
  answer: AnswerInput,
  plan: ReviewPlan,
  now: Date,
): LearningState {
  assertValidReviewPlan(plan);
  assertValidLearningState(state);
  assertValidAnswer(answer);

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
      weight: clampWeight(normalizeWeight(state.weight) * WEIGHT_MULTIPLIER_ON_WRONG),
    };
  }

  // 答对且“认识”：先升阶段，再用新阶段的间隔；权重 ×0.8。
  if (answer.recognition === 'KNOWN') {
    const stage = Math.min(stageBefore + 1, lastStage);
    const dueAt = nextDueInStudyWindow(
      answerInstant,
      intervalDaysForStage(plan, stage),
      plan.timeZone,
    );

    return {
      ...state,
      stage,
      dueAt: toIsoInstant(dueAt),
      lastReviewedAt: answeredAtIso,
      correctCount: state.correctCount + 1,
      wrongCount: state.wrongCount,
      streakCorrect: state.streakCorrect + 1,
      weight: clampWeight(normalizeWeight(state.weight) * WEIGHT_MULTIPLIER_ON_CORRECT_KNOWN),
    };
  }

  // 答对但“不认识”：阶段不升、权重**原样不变**（设计 5.1），安排次日。
  const dueAt = nextDueInStudyWindow(
    answerInstant,
    RECOGNITION_UNKNOWN_INTERVAL_DAYS,
    plan.timeZone,
  );

  return {
    ...state,
    stage: stageBefore,
    dueAt: toIsoInstant(dueAt),
    lastReviewedAt: answeredAtIso,
    correctCount: state.correctCount + 1,
    wrongCount: state.wrongCount,
    streakCorrect: state.streakCorrect + 1,
    weight: state.weight,
  };
}
