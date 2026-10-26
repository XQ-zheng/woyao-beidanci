/**
 * 可注入时钟与 ISO 时间工具。
 *
 * 约定：核心调度**绝不**调用 `Date.now()`。所有时间点都由调用方以 `now: Date`
 * 参数或 `Clock` 注入，这样测试能在固定时钟下断言到期时间，跨端行为也完全一致。
 * `createSystemClock()` 是唯一允许读取系统时间的工厂，仅供外壳/应用服务层使用。
 */

/** 可注入时钟。 */
export interface Clock {
  /** 返回当前时刻的副本。 */
  now(): Date;
}

/** 时间戳解析/格式化失败时抛出的类型化错误。 */
export class InvalidInstantError extends Error {
  /** 错误码，便于应用服务映射为 `{ ok: false, error }` 结果。 */
  readonly code = 'INVALID_INSTANT';

  /** 出错的字段名。 */
  readonly field: string;

  /**
   * @param field 出错的字段名。
   * @param message 面向开发者的错误说明。
   */
  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidInstantError';
    this.field = field;
  }
}

/**
 * 断言传入值是有效的 `Date`。
 *
 * @param instant 待校验值。
 * @param field 出错的字段名。
 */
export function assertValidInstant(instant: Date, field: string): void {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new InvalidInstantError(field, `${field} 必须是有效的 Date`);
  }
}

/**
 * 解析 ISO 时间字符串，失败时抛出类型化错误（绝不静默回退到当前时间）。
 *
 * @param value ISO 8601 时间字符串。
 * @param field 出错的字段名。
 * @returns 解析后的 `Date`。
 */
export function parseIsoInstant(value: string, field: string): Date {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidInstantError(field, `${field} 必须是非空 ISO 8601 时间字符串`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidInstantError(field, `${field} 不是合法的 ISO 8601 时间：${value}`);
  }
  return parsed;
}

/**
 * 宽松解析：用于处理来自数据库的历史数据，非法值返回 `null` 而不是抛错。
 *
 * @param value ISO 8601 时间字符串。
 * @returns 解析结果或 `null`。
 */
export function tryParseInstant(value: string | null | undefined): Date | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * 格式化为 UTC ISO 8601 毫秒字符串（全库统一的时间表示）。
 *
 * @param instant 待格式化的时刻。
 * @returns ISO 8601 字符串。
 */
export function toIsoInstant(instant: Date): string {
  assertValidInstant(instant, 'instant');
  return instant.toISOString();
}

/**
 * 返回偏移若干毫秒后的新 `Date`（用于 10 分钟短练习这类固定间隔）。
 *
 * @param instant 基准时刻。
 * @param milliseconds 偏移毫秒数，可为负。
 * @returns 新的 `Date`。
 */
export function addMilliseconds(instant: Date, milliseconds: number): Date {
  assertValidInstant(instant, 'instant');
  return new Date(instant.getTime() + milliseconds);
}

/**
 * 固定时钟：每次 `now()` 都返回同一时刻的副本，用于测试与可重放场景。
 *
 * @param instant 固定时刻或其 ISO 字符串。
 * @returns 固定时钟。
 */
export function createFixedClock(instant: Date | string): Clock {
  const fixed = typeof instant === 'string' ? parseIsoInstant(instant, 'clock') : new Date(instant.getTime());
  assertValidInstant(fixed, 'clock');
  const epochMilliseconds = fixed.getTime();
  return {
    now: (): Date => new Date(epochMilliseconds),
  };
}

/**
 * 系统时钟：核心之外（外壳/应用服务层）读取真实时间的唯一入口。
 *
 * @returns 系统时钟。
 */
export function createSystemClock(): Clock {
  return {
    now: (): Date => new Date(),
  };
}
