/**
 * 设置与复习计划服务。
 *
 * 数据层把设置存成 **扁平 key + JSON 字符串**（`settings.value_json`），这对同步非常友好
 * （按 key 合并，两端各改不同键互不影响），但对业务代码很危险：到处 `get('plan.dailyNewLimit')`
 * 一旦拼错就是“永远读默认值”。所以这一层只暴露**强类型访问器**，键名集中在本文件的
 * `SETTING_KEYS` 里，外面拿不到裸字符串。
 *
 * 三条硬规则：
 * 1. **不静默回退**：库里存着非法 JSON 或类型不符时抛错，而不是悄悄用默认值——
 *    否则用户以为设置保存成功了，实际每次启动都被覆盖回去。
 * 2. **范围的唯一真相在 `@woyao/core`**：每日数量、间隔节点、时区合法性都走
 *    `validateReviewPlan`，本层不复制一份边界常量（复制就会漂移）。
 * 3. **校验先于写入**：局部更新的所有校验都在任何 `settings.set` 之前完成，
 *    因此“非法 patch”不会留下“改了一半”的设置。
 */

import {
  DEFAULT_DAILY_NEW_LIMIT,
  DEFAULT_DAILY_REVIEW_LIMIT,
  DEFAULT_INTERVALS_DAYS,
  toIsoInstant,
  validateReviewPlan,
  type ReviewPlan,
} from '@woyao/core';
import type { PlanWindowRecord } from '@woyao/data';
import { z } from 'zod';

import {
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  VOLUME_MAX,
  VOLUME_MIN,
  parseOrThrow,
  reviewPlanSchema,
  settingsPatchSchema,
  studyWindowInputSchema,
  trainingModeSchema,
  questionStyleSchema,
  rotationOrderSchema,
  accentSchema,
  type SettingsPatch,
  type SettingsSnapshot,
  type StudyWindowInput,
  type StudyWindowView,
} from './dto';
import { ServiceValidationError, type ServiceValidationIssue } from './errors';
import type { ServiceContext } from './ports';

/**
 * 设置键名表。
 *
 * 加 `satisfies` 是为了让“快照里加了一个字段但忘了给它一个存储键”变成编译错误，
 * 而不是上线后才发现这个设置根本存不下来。
 */
const SETTING_KEYS = {
  dailyNewLimit: 'plan.dailyNewLimit',
  dailyReviewLimit: 'plan.dailyReviewLimit',
  intervalsDays: 'plan.intervalsDays',
  timeZone: 'plan.timeZone',
  trainingMode: 'study.trainingMode',
  questionStyle: 'study.questionStyle',
  rotationOrder: 'study.rotationOrder',
  accent: 'audio.accent',
  volume: 'audio.volume',
  fontScale: 'ui.fontScale',
  autoStart: 'app.autoStart',
  minimizeToTray: 'app.minimizeToTray',
  wallpaper: 'ui.wallpaper',
  fontFamily: 'ui.fontFamily',
} as const satisfies Record<keyof SettingsSnapshot, string>;

/** 设置服务契约。 */
export interface SettingsService {
  /** 返回全部设置，缺省值已补齐。 */
  getSnapshot(): Promise<SettingsSnapshot>;
  /** 局部更新，返回更新后的快照。 */
  update(patch: SettingsPatch): Promise<SettingsSnapshot>;
  /** 读取复习计划（供 5B 的学习服务使用）；库内计划非法时抛错而不是回退默认。 */
  loadReviewPlan(): Promise<ReviewPlan>;
  /** 保存复习计划；校验失败抛 `ServiceValidationError`，且一个键都不写。 */
  saveReviewPlan(plan: ReviewPlan): Promise<ReviewPlan>;
  /** 列出学习时段（按生效日、起始分钟升序）。 */
  listStudyWindows(): Promise<StudyWindowView[]>;
  /** 全量替换学习时段（跨午夜不允许，由调用方拆成两条）。 */
  replaceStudyWindows(windows: readonly StudyWindowInput[]): Promise<StudyWindowView[]>;
}

/** 构造参数。 */
export interface SettingsServiceOptions {
  readonly context: ServiceContext;
  /**
   * 计划时区的缺省值，由外壳传 `Intl.DateTimeFormat().resolvedOptions().timeZone`。
   *
   * 服务层**不自己探测**系统时区：那是平台 API（Node 侧与 WebView 侧行为不同），
   * 而且探测结果不可注入，会让测试依赖跑测试的机器。
   */
  readonly defaultTimeZone: string;
}

/** 存储值的 schema（与 patch 的区别：这些不允许 `undefined`）。 */
const storedIntSchema = z.number().int();
const storedDayListSchema = z.array(z.number().int());
const storedStringSchema = z.string().min(1);
const storedBooleanSchema = z.boolean();
const storedVolumeSchema = z.number().min(VOLUME_MIN).max(VOLUME_MAX);
const storedFontScaleSchema = z.number().min(FONT_SCALE_MIN).max(FONT_SCALE_MAX);

/**
 * 读取并校验一个设置项。
 *
 * @param stored 全部已存设置（`key → JSON 字符串`）。
 * @param key 存储键。
 * @param schema 该键的 schema。
 * @param fallback 键不存在时的缺省值。
 * @returns 解析后的值。
 * @throws {ServiceValidationError} JSON 非法或类型不符时（**不**回退默认值）。
 */
function readStored<T>(
  stored: Readonly<Record<string, string>>,
  key: string,
  schema: { safeParse(value: unknown): { readonly success: boolean; readonly data?: T; readonly error?: z.ZodError } },
  fallback: T,
): T {
  if (!Object.prototype.hasOwnProperty.call(stored, key)) {
    return fallback;
  }
  const text = stored[key];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ServiceValidationError(
      [{ path: key, message: '设置值不是合法 JSON（库被写坏了，不能静默回退默认值）' }],
      '设置读取失败',
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues: ServiceValidationIssue[] = (result.error?.issues ?? []).map((issue) => ({
      path: [key, ...issue.path.map((segment) => String(segment))].join('.'),
      message: issue.message,
    }));
    throw new ServiceValidationError(
      issues.length === 0 ? [{ path: key, message: '设置值类型不符' }] : issues,
      '设置读取失败',
    );
  }
  return result.data as T;
}

/**
 * 把 `core` 的校验结果转成服务层错误。
 *
 * @param issues `validateReviewPlan` 给出的问题（字段名 + 说明）。
 * @param label 错误前缀。
 * @throws {ServiceValidationError} 总是抛（调用方只在 `!ok` 时调用）。
 */
function throwPlanIssues(
  issues: readonly { readonly field: string; readonly message: string }[],
  label: string,
): never {
  throw new ServiceValidationError(
    issues.map((issue) => ({ path: issue.field, message: issue.message })),
    label,
  );
}

/**
 * 创建设置服务。
 *
 * @param options 上下文与缺省时区。
 * @returns 设置服务实例。
 * @throws {ServiceValidationError} 缺省时区本身不是合法 IANA 时区时（启动期就该炸）。
 */
export function createSettingsService(options: SettingsServiceOptions): SettingsService {
  const { context, defaultTimeZone } = options;

  // 缺省时区也要过一遍 core 的校验：外壳传错时区（例如 `UTC+8`）必须在这里就失败，
  // 而不是等到第一次排期算出错误的 dueAt。
  const defaultPlanCheck = validateReviewPlan({
    timeZone: defaultTimeZone,
    intervalsDays: [...DEFAULT_INTERVALS_DAYS],
    dailyNewLimit: DEFAULT_DAILY_NEW_LIMIT,
    dailyReviewLimit: DEFAULT_DAILY_REVIEW_LIMIT,
  });
  if (!defaultPlanCheck.ok) {
    throwPlanIssues(defaultPlanCheck.issues, '缺省时区不可用');
  }

  /** 读取全部设置。 */
  async function getSnapshot(): Promise<SettingsSnapshot> {
    const stored = await context.repos.settings.getAll();
    return {
      dailyNewLimit: readStored(stored, SETTING_KEYS.dailyNewLimit, storedIntSchema, DEFAULT_DAILY_NEW_LIMIT),
      dailyReviewLimit: readStored(
        stored,
        SETTING_KEYS.dailyReviewLimit,
        storedIntSchema,
        DEFAULT_DAILY_REVIEW_LIMIT,
      ),
      intervalsDays: readStored<number[]>(
        stored,
        SETTING_KEYS.intervalsDays,
        storedDayListSchema,
        [...DEFAULT_INTERVALS_DAYS],
      ),
      timeZone: readStored(stored, SETTING_KEYS.timeZone, storedStringSchema, defaultTimeZone),
      trainingMode: readStored(stored, SETTING_KEYS.trainingMode, trainingModeSchema, 'EN_TO_ZH'),
      questionStyle: readStored(stored, SETTING_KEYS.questionStyle, questionStyleSchema, 'CHOICE'),
      rotationOrder: readStored(stored, SETTING_KEYS.rotationOrder, rotationOrderSchema, 'SEQUENTIAL'),
      accent: readStored(stored, SETTING_KEYS.accent, accentSchema, 'uk'),
      volume: readStored(stored, SETTING_KEYS.volume, storedVolumeSchema, 1),
      fontScale: readStored(stored, SETTING_KEYS.fontScale, storedFontScaleSchema, 1),
      // 需求明确要求这两项默认**不勾选**：开机自启与最小化到托盘都属于“用户主动开启”的能力。
      autoStart: readStored(stored, SETTING_KEYS.autoStart, storedBooleanSchema, false),
      minimizeToTray: readStored(stored, SETTING_KEYS.minimizeToTray, storedBooleanSchema, false),
      wallpaper: readStored(stored, SETTING_KEYS.wallpaper, storedStringSchema, ''),
      fontFamily: readStored(stored, SETTING_KEYS.fontFamily, storedStringSchema, 'system'),
    };
  }

  /** 读取学习时段。 */
  async function listStudyWindows(): Promise<StudyWindowView[]> {
    const records = await context.repos.settings.listPlanWindows();
    return records.map((record) => ({
      windowId: record.id,
      effectiveLocalDate: record.effectiveLocalDate,
      startMinute: record.startMinute,
      endMinute: record.endMinute,
      timeZone: record.timeZone,
    }));
  }

  return {
    getSnapshot,

    async update(patch: SettingsPatch): Promise<SettingsSnapshot> {
      const validated = parseOrThrow(settingsPatchSchema, patch, '设置更新');
      const current = await getSnapshot();
      // 合并后再校验：单看 patch 无法判断“dailyNewLimit 改成 0 而 dailyReviewLimit 也是 0”，
      // 那条约束是**交叉**的，只有合并后的整体才说得清。
      const next: SettingsSnapshot = {
        dailyNewLimit: validated.dailyNewLimit ?? current.dailyNewLimit,
        dailyReviewLimit: validated.dailyReviewLimit ?? current.dailyReviewLimit,
        intervalsDays: validated.intervalsDays ?? current.intervalsDays,
        timeZone: validated.timeZone ?? current.timeZone,
        trainingMode: validated.trainingMode ?? current.trainingMode,
        questionStyle: validated.questionStyle ?? current.questionStyle,
        rotationOrder: validated.rotationOrder ?? current.rotationOrder,
        accent: validated.accent ?? current.accent,
        volume: validated.volume ?? current.volume,
        fontScale: validated.fontScale ?? current.fontScale,
        autoStart: validated.autoStart ?? current.autoStart,
        minimizeToTray: validated.minimizeToTray ?? current.minimizeToTray,
        wallpaper: validated.wallpaper ?? current.wallpaper,
        fontFamily: validated.fontFamily ?? current.fontFamily,
      };

      const planCheck = validateReviewPlan({
        timeZone: next.timeZone,
        intervalsDays: next.intervalsDays,
        dailyNewLimit: next.dailyNewLimit,
        dailyReviewLimit: next.dailyReviewLimit,
      });
      if (!planCheck.ok) {
        throwPlanIssues(planCheck.issues, '设置更新未通过校验');
      }

      // 全部校验通过后才动写：任何一条非法都不会留下“改了一半”的设置。
      const now = context.clock.now();
      const deviceId = context.device.deviceId();
      const writes: Promise<void>[] = [];
      if (validated.dailyNewLimit !== undefined) {
        writes.push(context.repos.settings.set(SETTING_KEYS.dailyNewLimit, JSON.stringify(next.dailyNewLimit), deviceId, now));
      }
      if (validated.dailyReviewLimit !== undefined) {
        writes.push(
          context.repos.settings.set(SETTING_KEYS.dailyReviewLimit, JSON.stringify(next.dailyReviewLimit), deviceId, now),
        );
      }
      if (validated.intervalsDays !== undefined) {
        writes.push(context.repos.settings.set(SETTING_KEYS.intervalsDays, JSON.stringify(next.intervalsDays), deviceId, now));
      }
      if (validated.timeZone !== undefined) {
        writes.push(context.repos.settings.set(SETTING_KEYS.timeZone, JSON.stringify(next.timeZone), deviceId, now));
      }
      if (validated.trainingMode !== undefined) {
        writes.push(context.repos.settings.set(SETTING_KEYS.trainingMode, JSON.stringify(next.trainingMode), deviceId, now));
      }
      if (validated.questionStyle !== undefined) {
        writes.push(
          context.repos.settings.set(SETTING_KEYS.questionStyle, JSON.stringify(next.questionStyle), deviceId, now),
        );
      }
      if (validated.rotationOrder !== undefined) {
        writes.push(
          context.repos.settings.set(SETTING_KEYS.rotationOrder, JSON.stringify(next.rotationOrder), deviceId, now),
        );
      }
      if (validated.wallpaper !== undefined) {
        writes.push(
          context.repos.settings.set(SETTING_KEYS.wallpaper, JSON.stringify(next.wallpaper), deviceId, now),
        );
      }
      if (validated.fontFamily !== undefined) {
        writes.push(
          context.repos.settings.set(SETTING_KEYS.fontFamily, JSON.stringify(next.fontFamily), deviceId, now),
        );
      }
      if (validated.accent !== undefined) {
        writes.push(context.repos.settings.set(SETTING_KEYS.accent, JSON.stringify(next.accent), deviceId, now));
      }
      if (validated.volume !== undefined) {
        writes.push(context.repos.settings.set(SETTING_KEYS.volume, JSON.stringify(next.volume), deviceId, now));
      }
      if (validated.fontScale !== undefined) {
        writes.push(context.repos.settings.set(SETTING_KEYS.fontScale, JSON.stringify(next.fontScale), deviceId, now));
      }
      if (validated.autoStart !== undefined) {
        writes.push(context.repos.settings.set(SETTING_KEYS.autoStart, JSON.stringify(next.autoStart), deviceId, now));
      }
      if (validated.minimizeToTray !== undefined) {
        writes.push(
          context.repos.settings.set(SETTING_KEYS.minimizeToTray, JSON.stringify(next.minimizeToTray), deviceId, now),
        );
      }
      await Promise.all(writes);

      return getSnapshot();
    },

    async loadReviewPlan(): Promise<ReviewPlan> {
      const snapshot = await getSnapshot();
      const plan: ReviewPlan = {
        timeZone: snapshot.timeZone,
        intervalsDays: [...snapshot.intervalsDays],
        dailyNewLimit: snapshot.dailyNewLimit,
        dailyReviewLimit: snapshot.dailyReviewLimit,
      };
      // 库里存着的组合可能已经不再合法（例如旧版本允许 13 个节点）：宁可让上层看到错误，
      // 也不要用一个“看起来正常”的默认计划去排期（那会静默改动用户的学习节奏）。
      const check = validateReviewPlan(plan);
      if (!check.ok) {
        throwPlanIssues(check.issues, '已保存的复习计划不再合法');
      }
      return plan;
    },

    async saveReviewPlan(plan: ReviewPlan): Promise<ReviewPlan> {
      const validated = parseOrThrow(reviewPlanSchema, plan, '复习计划');
      const check = validateReviewPlan(validated);
      if (!check.ok) {
        throwPlanIssues(check.issues, '复习计划校验未通过');
      }
      const now = context.clock.now();
      const deviceId = context.device.deviceId();
      await context.repos.settings.set(SETTING_KEYS.timeZone, JSON.stringify(validated.timeZone), deviceId, now);
      await context.repos.settings.set(
        SETTING_KEYS.intervalsDays,
        JSON.stringify([...validated.intervalsDays]),
        deviceId,
        now,
      );
      await context.repos.settings.set(
        SETTING_KEYS.dailyNewLimit,
        JSON.stringify(validated.dailyNewLimit),
        deviceId,
        now,
      );
      await context.repos.settings.set(
        SETTING_KEYS.dailyReviewLimit,
        JSON.stringify(validated.dailyReviewLimit),
        deviceId,
        now,
      );
      return {
        timeZone: validated.timeZone,
        intervalsDays: [...validated.intervalsDays],
        dailyNewLimit: validated.dailyNewLimit,
        dailyReviewLimit: validated.dailyReviewLimit,
      };
    },

    listStudyWindows,

    async replaceStudyWindows(windows: readonly StudyWindowInput[]): Promise<StudyWindowView[]> {
      if (!Array.isArray(windows)) {
        throw new ServiceValidationError([{ path: 'windows', message: '学习时段必须是数组' }]);
      }
      const validated = windows.map((window, index) => {
        const parsed = parseOrThrow(studyWindowInputSchema, window, `studyWindows[${index}]`);
        if (parsed.endMinute <= parsed.startMinute) {
          // 跨午夜（例如 22:00–02:00）在数据层就是非法状态（`end_minute > start_minute` 的 CHECK），
          // 这里提前给出可解释的错误，而不是让 SQLite 抛一句 CHECK constraint failed。
          throw new ServiceValidationError(
            [
              {
                path: `studyWindows[${index}].endMinute`,
                message: `结束分钟必须大于起始分钟；跨午夜请拆成两条时段（收到 ${parsed.startMinute} → ${parsed.endMinute}）`,
              },
            ],
            '学习时段校验未通过',
          );
        }
        return parsed;
      });

      const usedIds = new Set<string>();
      const now = context.clock.now();
      const nowIso = toIsoInstant(now);
      const deviceId = context.device.deviceId();
      const records: PlanWindowRecord[] = validated.map((window, index) => {
        const id = window.windowId ?? context.ids.nextId();
        if (usedIds.has(id)) {
          throw new ServiceValidationError(
            [{ path: `studyWindows[${index}].windowId`, message: `时段 id 重复：${id}` }],
            '学习时段校验未通过',
          );
        }
        usedIds.add(id);
        return {
          id,
          effectiveLocalDate: window.effectiveLocalDate,
          startMinute: window.startMinute,
          endMinute: window.endMinute,
          timeZone: window.timeZone,
          // 下面三个字段由数据层的 upsert 覆盖（updatedAt/deviceId 用本次注入值，revision 由 SQL 自增），
          // 这里必须给值只是因为 `PlanWindowRecord` 是“读模型”，没有单独的写模型。
          updatedAt: nowIso,
          deviceId,
          revision: 0,
          deletedAt: null,
        };
      });

      await context.repos.settings.replacePlanWindows(records, deviceId, now);
      return listStudyWindows();
    },
  };
}
