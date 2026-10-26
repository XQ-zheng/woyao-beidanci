/**
 * 领域核心的数据模型与公开可解释参数。
 *
 * 本文件只描述数据结构、常量与纯值规则，不包含任何时间计算或随机行为：
 * 调度（scheduler.ts）与队列（queue.ts）都通过显式参数拿到 `now` / `seed`，
 * 时间一律按 `ReviewPlan.timeZone` 指定的 IANA 时区换算，
 * 因此同一份输入在任何端、任何宿主机时区下都会得到完全一致的结果。
 */

/** 用户对某个单词的自我认识判断。 */
export type Recognition = 'KNOWN' | 'UNKNOWN';

/** 训练模式。调度规则与模式无关，但作答事件需要记录模式。 */
export type TrainingMode = 'EN_TO_ZH' | 'ZH_TO_EN' | 'MIXED';

/**
 * 单个词在某个词库内的学习状态（对应 SQLite `learning_state` 的一行）。
 *
 * `stage` 语义（见系统设计 5.1）：
 * - `-1` 表示从未成功进入复习阶段，它不是 `intervalsDays` 的下标；
 * - `>= 0` 表示当前已到达的阶段，本次到期时间由 `intervalsDays[stage]` 决定。
 */
export interface LearningState {
  /** 学习状态主键（每词每词库一条）。 */
  userWordId: string;
  /** 所属词库。 */
  deckId: string;
  /** 词条 ID。 */
  wordId: string;
  /** 已到达的复习阶段，`-1` 表示尚未进入复习阶段。 */
  stage: number;
  /** 下一次到期时间（UTC ISO 8601 毫秒）。 */
  dueAt: string;
  /** 最近一次作答时间（UTC ISO 8601 毫秒），从未作答为 `null`。 */
  lastReviewedAt: string | null;
  /** 累计答对次数。 */
  correctCount: number;
  /** 累计答错次数。 */
  wrongCount: number;
  /** 连续答对次数，答错清零。 */
  streakCorrect: number;
  /** 队列排序权重，范围 `[WEIGHT_MIN, WEIGHT_MAX]`。 */
  weight: number;
  /** 用户设置“不再出现”的时间（UTC ISO 8601 毫秒），未屏蔽为 `null`。 */
  suppressedAt: string | null;
}

/**
 * 复习计划中**用户可配置**的部分。
 *
 * 按设计 5.1 的已决边界，V1.0 只开放整数天数节点与每日数量；
 * 权重与升降级规则由系统管理，因此不在此结构中。
 */
export interface ReviewPlan {
  /**
   * 计划生效的 IANA 时区（例如 `Asia/Shanghai`）。
   *
   * 到期时间与“逾期天数”都以该时区的本地日历计算，而不是宿主机的本地时区，
   * 否则同一份学习数据在不同设备上会得到不同的 `dueAt`。
   */
  timeZone: string;
  /** 严格递增的整数天数节点，取值 `1..365`，数量 `1..12`。 */
  intervalsDays: number[];
  /** 每日新词上限，整数 `0..500`。 */
  dailyNewLimit: number;
  /** 每日复习上限，整数 `0..500`。 */
  dailyReviewLimit: number;
}

/** 一次作答的输入。 */
export interface AnswerInput {
  /** 本次作答是否正确。 */
  isCorrect: boolean;
  /** 本次作答后的自我认识判断。 */
  recognition: Recognition;
  /** 本次作答使用的训练模式。 */
  mode: TrainingMode;
  /** 作答发生时间（UTC ISO 8601 毫秒）。 */
  answeredAt: string;
}

/** 从未进入复习阶段的阶段值。 */
export const STAGE_NEVER_REVIEWED = -1;

/** 默认可解释间隔序列（天）。 */
export const DEFAULT_INTERVALS_DAYS: readonly number[] = [1, 2, 4, 7, 15, 30];

/** 默认每日新词上限（用户可在 `0..500` 内修改）。 */
export const DEFAULT_DAILY_NEW_LIMIT = 20;

/** 默认每日复习上限（用户可在 `0..500` 内修改）。 */
export const DEFAULT_DAILY_REVIEW_LIMIT = 100;

/** 自定义间隔节点允许的最小天数。 */
export const INTERVAL_DAYS_MIN = 1;

/** 自定义间隔节点允许的最大天数。 */
export const INTERVAL_DAYS_MAX = 365;

/** 自定义间隔节点允许的最少数量。 */
export const INTERVAL_NODE_COUNT_MIN = 1;

/** 自定义间隔节点允许的最多数量。 */
export const INTERVAL_NODE_COUNT_MAX = 12;

/** 每日数量允许的最小值。 */
export const DAILY_LIMIT_MIN = 0;

/** 每日数量允许的最大值。 */
export const DAILY_LIMIT_MAX = 500;

/** 权重下限：高正确率降权有下限，避免“永远不再复习”。 */
export const WEIGHT_MIN = 0.25;

/** 权重上限。 */
export const WEIGHT_MAX = 4;

/** 答错时的权重乘数。 */
export const WEIGHT_MULTIPLIER_ON_WRONG = 1.75;

/** 答对且“认识”时的权重乘数。 */
export const WEIGHT_MULTIPLIER_ON_CORRECT_KNOWN = 0.8;

/** 新建学习状态时的初始权重。 */
export const INITIAL_WEIGHT = 1;

/** 答错后的短练习间隔：10 分钟后重练。 */
export const RETRY_AFTER_WRONG_MS = 10 * 60 * 1000;

/** 答对但“不认识”时安排的间隔天数：次日。 */
export const RECOGNITION_UNKNOWN_INTERVAL_DAYS = 1;

/** 学习窗口开始时刻（计划时区内的本地小时）。没有配置学习时段时使用 09:00。 */
export const STUDY_WINDOW_START_HOUR = 9;

/** 一天的毫秒数（仅用于日历天数换算，不参与本地时间加法）。 */
export const MS_PER_DAY = 86_400_000;

/**
 * 允许的作答时间“未来偏差”上限。
 *
 * 超过该值的 `answeredAt`（作答时间明显晚于注入时钟）属于时钟异常，
 * 由 `nextLearningState` 抛出 `ClockSkewError`，由应用服务层决定如何提示/校正；
 * 核心层绝不改写作答时间。1 分钟足以容纳正常的网络/持久化延迟。
 */
export const MAX_ANSWERED_AT_CLOCK_SKEW_MS = 60 * 1000;

/** 创建新学习状态所需的最小输入。 */
export interface InitialLearningStateInput {
  /** 学习状态主键。 */
  userWordId: string;
  /** 所属词库。 */
  deckId: string;
  /** 词条 ID。 */
  wordId: string;
  /** 首次到期时间（UTC ISO 8601 毫秒），由调用方按计划窗口计算后传入。 */
  dueAt: string;
}

/**
 * 把权重钳制到 `[0.25, 4.0]`。
 *
 * @param weight 待钳制的权重。
 * @returns 合法权重。
 */
export function clampWeight(weight: number): number {
  return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, weight));
}

/**
 * 归一化**历史数据中的**权重：非法值（`NaN` / `Infinity` / 非数字）回退到初始权重，
 * 其余钳制到 `[WEIGHT_MIN, WEIGHT_MAX]`。
 *
 * 调度与队列共用这一条规则，避免“乘法前”和“排序时”对脏数据给出不同解释。
 *
 * @param weight 历史权重值。
 * @returns 可参与乘法与排序的权重。
 */
export function normalizeWeight(weight: number): number {
  if (typeof weight !== 'number' || !Number.isFinite(weight)) {
    return INITIAL_WEIGHT;
  }
  return clampWeight(weight);
}

/**
 * 创建一个尚未学习过的学习状态。
 *
 * 新词初始 `stage=-1`、权重为 1、计数为 0、未被屏蔽；
 * 这里不读取系统时间，`dueAt` 由调用方（应用服务）按学习窗口算好后传入。
 *
 * @param input 主键与首次到期时间。
 * @returns 全新的学习状态对象。
 */
export function createInitialLearningState(input: InitialLearningStateInput): LearningState {
  return {
    userWordId: input.userWordId,
    deckId: input.deckId,
    wordId: input.wordId,
    stage: STAGE_NEVER_REVIEWED,
    dueAt: input.dueAt,
    lastReviewedAt: null,
    correctCount: 0,
    wrongCount: 0,
    streakCorrect: 0,
    weight: INITIAL_WEIGHT,
    suppressedAt: null,
  };
}

/**
 * 创建默认复习计划；传入的覆盖项会被复制，避免调用方后续修改数组影响已保存的计划快照。
 *
 * @param timeZone 计划生效的 IANA 时区，必填，确保同一数据在不同设备上结果一致。
 * @param overrides 需要覆盖的字段。
 * @returns 新的复习计划对象。
 */
export function createDefaultReviewPlan(timeZone: string, overrides: Partial<ReviewPlan> = {}): ReviewPlan {
  return {
    timeZone: overrides.timeZone ?? timeZone,
    intervalsDays:
      overrides.intervalsDays === undefined
        ? [...DEFAULT_INTERVALS_DAYS]
        : [...overrides.intervalsDays],
    dailyNewLimit: overrides.dailyNewLimit ?? DEFAULT_DAILY_NEW_LIMIT,
    dailyReviewLimit: overrides.dailyReviewLimit ?? DEFAULT_DAILY_REVIEW_LIMIT,
  };
}
