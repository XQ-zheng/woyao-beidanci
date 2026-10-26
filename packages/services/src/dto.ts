/**
 * 服务层 DTO：对外视图类型 + 入参校验。
 *
 * 两条约定：
 * 1. **入参一律经过 zod 校验**，失败时抛 `ServiceValidationError`（带逐条 `issues`），
 *    绝不把 `ZodError` 漏给上层——IPC 边界上的 `ZodError` 会被序列化成一坨
 *    `{ issues: [...], name: 'ZodError' }`，UI 拿到也没法用。
 * 2. **时间字段对外一律是 UTC ISO-8601 毫秒字符串**（`YYYY-MM-DDTHH:mm:ss.sssZ`）。
 *    理由不是美观：IPC 的 `structuredClone` 会把 `Date` 反序列化成同类型，但
 *    JSON 通道（云同步、导出、日志）不会；只留一种表示，跨端才不会出现“同一时刻两种写法”。
 *    数据层已经用 `requireIsoInstant` 拒绝其它格式，服务层**不再造兼容层**。
 */

import type { TrainingMode } from '@woyao/core';
import type { DeckKind } from '@woyao/data';
import { z } from 'zod';

import { ServiceValidationError, type ServiceValidationIssue } from './errors';

/** 对外的 UTC ISO-8601 毫秒时间格式（与数据层同一条正则）。 */
export const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** 本地日 `YYYY-MM-DD`（学习时段、日统计用的“用户日历日”）。 */
export const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * 用户自建内容的来源 id。
 *
 * `word_senses.source_id` 有外键，所以自建词也必须挂在某个来源上；
 * 这里统一用这个“本地来源”。
 *
 * **语义变更（5B）**：这个来源由 `LibraryService.createWord` 在写词之前
 * `upsertSource` 保证存在（`type: 'USER'`、`redistributionAllowed: false`），
 * 不再依赖导入脚本/首次启动引导先建好——否则第一次自建词一定撞外键，
 * “把不会的单词收入单词本”这条需求等于不可用。
 */
export const LOCAL_USER_SOURCE_ID = 'local-user';

/** 本地自建内容来源的展示名（设置页/关于页里给用户看）。 */
export const USER_SOURCE_NAME = '本地自建内容';

/** 生词本词库的默认名字。 */
export const NOTEBOOK_DECK_NAME = '生词本';

/** 音量允许范围。 */
export const VOLUME_MIN = 0;
/** 音量允许范围。 */
export const VOLUME_MAX = 1;
/** 界面字号缩放允许范围（过小不可读，过大布局会碎）。 */
export const FONT_SCALE_MIN = 0.5;
/** 界面字号缩放允许范围。 */
export const FONT_SCALE_MAX = 2;

/** 设置快照：全部设置项，缺省值已补齐。 */
export interface SettingsSnapshot {
  dailyNewLimit: number;
  dailyReviewLimit: number;
  intervalsDays: number[];
  timeZone: string;
  trainingMode: TrainingMode;
  questionStyle: 'CHOICE' | 'REVEAL';
  accent: 'uk' | 'us';
  volume: number;
  fontScale: number;
  autoStart: boolean;
  minimizeToTray: boolean;
}

/**
 * 设置局部更新。
 *
 * 用 `Partial` 而不是 `Record<string, unknown>`：未知键要在**类型层**就被拒掉，
 * 运行时再被 zod 的 strict 拦一次（防止 JS 调用方绕过类型）。
 */
export type SettingsPatch = Partial<SettingsSnapshot>;

/** 词库摘要（列表页用）。 */
export interface DeckSummary {
  readonly deckId: string;
  readonly name: string;
  readonly kind: DeckKind;
  readonly wordCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 词频视图（UI 展示“重要性 + 原始频次 + 来源”）。 */
export interface FrequencyView {
  readonly importance: 'HIGH' | 'MEDIUM' | 'BASIC' | 'UNKNOWN';
  readonly frequency: number | null;
  readonly rank: number | null;
  /**
   * 语料总词数（`frequency_entries.total_tokens`，语料级字段）。
   *
   * 5B 起由数据层的 `getFrequencyCorpusMeta` 提供真值。仍可能为 `null` 的两种情况：
   * 1. 调用方没给 `exam`/`corpusVersion`（没有语料上下文）；
   * 2. 该词不在语料里（整份视图按“未知”处理，不拿别的词的语料规模冒充）；
   * 3. 导入方本身没给出总词数。
   * 三种情况都**不编造数字**——UI 的“统计口径”宁可空着，也不能虚报。
   */
  readonly totalTokens: number | null;
  readonly corpusVersion: string | null;
  readonly sourceId: string | null;
}

/** 词库内的一个词（含义项与词频）。 */
export interface DeckWordView {
  readonly wordId: string;
  readonly lemma: string;
  readonly phoneticUk: string | null;
  readonly phoneticUs: string | null;
  readonly senses: {
    readonly senseNo: number;
    readonly pos: string;
    readonly simpleZh: string;
    readonly detailedZh: string | null;
    readonly contextText: string | null;
  }[];
  readonly frequency: FrequencyView;
}

/**
 * 自建词的返回值。
 *
 * 比 brief 的 `Promise<DeckWordView>` 多一个 `created`：需求要求“重复词返回既有记录，
 * 且要能区分新建还是命中旧的”。这是**超集**（`CreatedWordView` 可赋给 `DeckWordView`），
 * 所以按 brief 写的调用方无需改动。
 */
export interface CreatedWordView extends DeckWordView {
  readonly created: boolean;
}

/** 学习时段输入。`windowId` 省略时由服务层生成（保存后 id 会变，用于“新加一条”）。 */
export interface StudyWindowInput {
  readonly windowId?: string;
  readonly effectiveLocalDate: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly timeZone: string;
}

/** 学习时段视图。 */
export interface StudyWindowView {
  readonly windowId: string;
  readonly effectiveLocalDate: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly timeZone: string;
}

/** 自建词的一个义项（不含 sourceId：由 `CreateWordInput.sourceId` 统一提供）。 */
export interface CreateSenseInput {
  /** 义项序号，从 1 开始；缺省按数组序 1..n。**重复会抛 `VALIDATION_FAILED`**（不许静默覆盖）。 */
  readonly senseNo?: number;
  readonly pos: string;
  readonly simpleZh: string;
  readonly detailedZh?: string | null;
  readonly contextText?: string | null;
}

/** 自建词的输入。 */
export interface CreateWordInput {
  /** 缺省用服务配置的 ownerScope。 */
  readonly ownerScope?: string;
  readonly id?: string;
  readonly lemma: string;
  readonly language?: string;
  readonly phoneticUk?: string | null;
  readonly phoneticUs?: string | null;
  /**
   * 义项来源 id。
   *
   * 缺省为 `LOCAL_USER_SOURCE_ID`，此时服务层会在写词前自动确保该来源存在。
   * **显式给出时**要求它已存在（导入/脚本场景），否则抛 `CONFLICT`。
   */
  readonly sourceId?: string;
  readonly senses: readonly CreateSenseInput[];
  /** 给了 exam + corpusVersion 才查词频；否则返回 `UNKNOWN`。 */
  readonly exam?: string;
  readonly corpusVersion?: string;
}

/**
 * 最小可解析 schema 的结构类型。
 *
 * 刻意不写 `z.ZodType<T>`：zod v3/v4 的泛型参数个数不同，用结构类型可以让
 * `parseOrThrow` 在两个大版本下都编译通过，也便于单测里塞假 schema。
 */
interface ParseableSchema<T> {
  safeParse(
    value: unknown,
  ): { readonly success: true; readonly data: T } | { readonly success: false; readonly error: z.ZodError };
}

/** zod issue → 服务层 issue（`path` 拼成点号路径，空路径写作 `(root)`）。 */
export function toValidationIssues(error: z.ZodError): ServiceValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? '(root)' : issue.path.map((segment) => String(segment)).join('.'),
    message: issue.message,
  }));
}

/**
 * 按 schema 校验，失败时抛 `ServiceValidationError`。
 *
 * @param schema zod schema（或任何 `safeParse` 兼容对象）。
 * @param value 待校验值。
 * @param label 出错时用在 message 前面的标签（例如 `settingsPatch`）。
 * @returns 校验后的值（已去掉多余键、已应用默认值）。
 * @throws {ServiceValidationError} 校验失败时。
 */
export function parseOrThrow<T>(schema: ParseableSchema<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ServiceValidationError(toValidationIssues(result.error), `${label} 校验未通过`);
  }
  return result.data;
}

/** 对外时间字符串。 */
export const isoInstantSchema = z
  .string()
  .regex(ISO_INSTANT_PATTERN, '必须是 UTC ISO-8601 毫秒格式（YYYY-MM-DDTHH:mm:ss.sssZ）');

/** 本地日字符串。 */
export const localDateSchema = z.string().regex(LOCAL_DATE_PATTERN, '必须是本地日 YYYY-MM-DD');

/** 训练模式。 */
export const trainingModeSchema = z.enum(['EN_TO_ZH', 'ZH_TO_EN', 'MIXED']);

/** 题型。 */
export const questionStyleSchema = z.enum(['CHOICE', 'REVEAL']);

/** 发音口音。 */
export const accentSchema = z.enum(['uk', 'us']);

/** 复习计划（只校验形状与类型，范围与交叉约束交给 `core.validateReviewPlan`）。 */
export const reviewPlanSchema = z.strictObject({
  timeZone: z.string().min(1, '必须填写计划时区'),
  intervalsDays: z.array(z.number().int('天数必须是整数')),
  dailyNewLimit: z.number().int('每日新词数必须是整数'),
  dailyReviewLimit: z.number().int('每日复习数必须是整数'),
});

/**
 * 设置局部更新。
 *
 * `strictObject`：多传一个键就报错。这条是需求的硬要求——静默忽略未知键会让用户
 * 以为设置保存成功了，而实际上写进了一个没人读的键。
 */
export const settingsPatchSchema = z.strictObject({
  dailyNewLimit: z.number().int('每日新词数必须是整数').optional(),
  dailyReviewLimit: z.number().int('每日复习数必须是整数').optional(),
  intervalsDays: z.array(z.number().int('天数必须是整数')).optional(),
  timeZone: z.string().min(1, '必须填写计划时区').optional(),
  trainingMode: trainingModeSchema.optional(),
  questionStyle: questionStyleSchema.optional(),
  accent: accentSchema.optional(),
  volume: z
    .number()
    .min(VOLUME_MIN, `音量不能小于 ${VOLUME_MIN}`)
    .max(VOLUME_MAX, `音量不能大于 ${VOLUME_MAX}`)
    .optional(),
  fontScale: z
    .number()
    .min(FONT_SCALE_MIN, `字号缩放不能小于 ${FONT_SCALE_MIN}`)
    .max(FONT_SCALE_MAX, `字号缩放不能大于 ${FONT_SCALE_MAX}`)
    .optional(),
  autoStart: z.boolean().optional(),
  minimizeToTray: z.boolean().optional(),
});

/** 学习时段输入。 */
export const studyWindowInputSchema = z.strictObject({
  windowId: z.string().min(1, '时段 id 不能为空').optional(),
  effectiveLocalDate: localDateSchema,
  startMinute: z.number().int('起始分钟必须是整数').min(0, '起始分钟不能小于 0').max(1439, '起始分钟不能大于 1439'),
  endMinute: z.number().int('结束分钟必须是整数').min(1, '结束分钟不能小于 1').max(1440, '结束分钟不能大于 1440'),
  timeZone: z.string().min(1, '必须填写时区'),
});

/** 建库入参。 */
export const createDeckInputSchema = z.strictObject({
  name: z.string().trim().min(1, '词库名不能为空'),
  kind: z.enum(['CUSTOM', 'NOTEBOOK']).optional(),
});

/** 改名入参。 */
export const renameDeckInputSchema = z.strictObject({
  deckId: z.string().min(1, '词库 id 不能为空'),
  name: z.string().trim().min(1, '词库名不能为空'),
});

/** `listDeckWords` 入参。 */
export const listDeckWordsInputSchema = z.strictObject({
  deckId: z.string().min(1, '词库 id 不能为空'),
  exam: z.string().min(1, '考试标签不能为空').optional(),
  corpusVersion: z.string().min(1, '语料版本不能为空').optional(),
});

/** `getFrequency` 入参。 */
export const getFrequencyInputSchema = z.strictObject({
  wordId: z.string().min(1, '词条 id 不能为空'),
  exam: z.string().min(1, '考试标签不能为空'),
  corpusVersion: z.string().min(1, '语料版本不能为空'),
});

/** 自建词的义项。 */
export const createSenseInputSchema = z.strictObject({
  senseNo: z.number().int('义项序号必须是整数').min(1, '义项序号从 1 开始').optional(),
  pos: z.string().max(32, '词性过长'),
  simpleZh: z.string().trim().min(1, '简明释义不能为空'),
  detailedZh: z.string().nullish(),
  contextText: z.string().nullish(),
});

/** 自建词入参。 */
export const createWordInputSchema = z.strictObject({
  ownerScope: z.string().min(1, '归属范围不能为空').optional(),
  id: z.string().min(1, '词条 id 不能为空').optional(),
  lemma: z.string().trim().min(1, '词形不能为空'),
  language: z.string().min(2, '语言代码不能为空').optional(),
  phoneticUk: z.string().nullish(),
  phoneticUs: z.string().nullish(),
  sourceId: z.string().min(1, '来源 id 不能为空').optional(),
  senses: z.array(createSenseInputSchema).min(1, '至少需要一个义项'),
  exam: z.string().min(1, '考试标签不能为空').optional(),
  corpusVersion: z.string().min(1, '语料版本不能为空').optional(),
});
