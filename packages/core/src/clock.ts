/**
 * 可注入时钟与**时区感知**的时间工具。
 *
 * 两条不可违反的约定：
 * 1. 核心调度**绝不**调用 `Date.now()`：时间点一律由调用方以 `now: Date` 参数或 `Clock` 注入；
 *    `createSystemClock()` 是唯一允许读取系统时间的工厂，仅供外壳/应用服务层使用。
 * 2. 核心**绝不**使用宿主机的本地时区（`getFullYear` / `getMonth` / `getDate` / `getHours`）：
 *    本地日历一律通过 `Intl.DateTimeFormat` 指定的 IANA 时区换算，
 *    否则同一份学习数据在 UTC 与 Asia/Shanghai 的设备上会得到不同的到期时间。
 */

/** 可注入时钟。 */
export interface Clock {
  /** 返回当前时刻的副本。 */
  now(): Date;
}

/** 某个时区内的公历日期时间分量（不含毫秒）。 */
export interface ZonedDateTimeParts {
  /** 年。 */
  readonly year: number;
  /** 月，`1..12`。 */
  readonly month: number;
  /** 日，`1..31`。 */
  readonly day: number;
  /** 时，`0..23`。 */
  readonly hour: number;
  /** 分，`0..59`。 */
  readonly minute: number;
  /** 秒，`0..59`。 */
  readonly second: number;
}

/** 公历日期（仅年月日）。 */
export interface CivilDate {
  /** 年。 */
  readonly year: number;
  /** 月，`1..12`。 */
  readonly month: number;
  /** 日，`1..31`。 */
  readonly day: number;
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

/** IANA 时区标识非法时抛出的类型化错误。 */
export class InvalidTimeZoneError extends Error {
  /** 错误码。 */
  readonly code = 'INVALID_TIME_ZONE';

  /** 非法的时区标识。 */
  readonly timeZone: string;

  /**
   * @param timeZone 非法的时区标识。
   */
  constructor(timeZone: string) {
    super(`无法识别的 IANA 时区：${String(timeZone)}`);
    this.name = 'InvalidTimeZoneError';
    this.timeZone = String(timeZone);
  }
}

/** `Intl.DateTimeFormat` 构造开销较大，按时区缓存。 */
const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * 纯 UTC 偏移写法（例如 `+08:00`、`-0500`、`+08`）。
 *
 * 这类标识虽然被新版 `Intl` 接受，但它没有 DST 规则、也不是计划要落库的标识，
 * 一旦存进 `ReviewPlan.timeZone` 会让跨端结果随实现细节漂移，因此明确拒绝。
 */
const UTC_OFFSET_TIME_ZONE_PATTERN = /^[+-]\d{2}(?::?\d{2})?$/u;

/**
 * 允许的时区名形态：`UTC`、`Etc/UTC`、`America/Argentina/Buenos_Aires` 等
 * IANA 名称（字母开头，可含数字、`_`、`+`、`-` 与 `/`）。
 */
const IANA_TIME_ZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/u;

/**
 * 取（并缓存）某个时区的分量格式化器；非法时区会抛 `InvalidTimeZoneError`。
 *
 * 校验顺序：先按形态拒绝纯偏移写法，再交给 `Intl` 判断时区数据库里是否存在。
 *
 * @param timeZone IANA 时区标识。
 * @returns 分量格式化器。
 */
function partsFormatterOf(timeZone: string): Intl.DateTimeFormat {
  const cached = partsFormatterCache.get(timeZone);
  if (cached !== undefined) {
    return cached;
  }
  if (typeof timeZone !== 'string') {
    throw new InvalidTimeZoneError(timeZone);
  }
  const trimmed = timeZone.trim();
  if (trimmed === '' || UTC_OFFSET_TIME_ZONE_PATTERN.test(trimmed) || !IANA_TIME_ZONE_PATTERN.test(trimmed)) {
    throw new InvalidTimeZoneError(timeZone);
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: trimmed,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    throw new InvalidTimeZoneError(timeZone);
  }
  partsFormatterCache.set(timeZone, formatter);
  return formatter;
}

/**
 * 判断字符串是否是运行时认识、且不是纯偏移写法的 IANA 时区。
 *
 * @param timeZone 待校验的时区标识。
 * @returns 是否合法。
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    partsFormatterOf(timeZone);
    return true;
  } catch {
    return false;
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
 * 取某个时刻在指定时区内的日历分量（完全不受宿主机时区影响）。
 *
 * @param instant 时刻。
 * @param timeZone IANA 时区标识。
 * @returns 该时区内的年月日时分秒。
 */
export function zonedDateTimeParts(instant: Date, timeZone: string): ZonedDateTimeParts {
  assertValidInstant(instant, 'instant');
  const parts = partsFormatterOf(timeZone).formatToParts(instant);
  let year = Number.NaN;
  let month = Number.NaN;
  let day = Number.NaN;
  let hour = Number.NaN;
  let minute = Number.NaN;
  let second = Number.NaN;

  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number(part.value);
        break;
      case 'month':
        month = Number(part.value);
        break;
      case 'day':
        day = Number(part.value);
        break;
      case 'hour':
        hour = Number(part.value);
        break;
      case 'minute':
        minute = Number(part.value);
        break;
      case 'second':
        second = Number(part.value);
        break;
      default:
        break;
    }
  }

  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) {
    throw new InvalidInstantError('instant', `无法在时区 ${timeZone} 内解析时刻分量`);
  }

  return {
    year,
    month,
    day,
    // 个别 ICU 版本在午夜返回 24，这里统一折回 0。
    hour: Number.isNaN(hour) ? 0 : hour % 24,
    minute: Number.isNaN(minute) ? 0 : minute,
    second: Number.isNaN(second) ? 0 : second,
  };
}

/**
 * 把时刻折算为指定时区下的日历日序号（用于“逾期天数”等日历日差值）。
 *
 * 用 `Date.UTC` 而非宿主机本地方法做归一，因此结果与宿主时区无关。
 *
 * @param instant 时刻。
 * @param timeZone IANA 时区标识。
 * @returns 日历日序号（同一时区内每天 +1）。
 */
export function zonedDayNumber(instant: Date, timeZone: string): number {
  const parts = zonedDateTimeParts(instant, timeZone);
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000);
}

/**
 * 计算某时刻在指定时区的 UTC 偏移毫秒数（东为正）。
 *
 * @param instantMilliseconds 时刻毫秒。
 * @param timeZone IANA 时区标识。
 * @returns 偏移毫秒（整分钟）。
 */
function offsetMillisecondsAt(instantMilliseconds: number, timeZone: string): number {
  const truncated = Math.floor(instantMilliseconds / 1000) * 1000;
  const parts = zonedDateTimeParts(new Date(truncated), timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - truncated;
}

/**
 * 判断两个分量是否表示同一面墙上时间（只比较年月日时分秒）。
 *
 * @param left 左分量。
 * @param right 右分量。
 * @returns 是否相同。
 */
function isSameWallTime(left: ZonedDateTimeParts, right: ZonedDateTimeParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

/**
 * 把“某时区的本地墙上时间”换算成 UTC 时刻，确定性处理 DST。
 *
 * - 正常时间：唯一解。
 * - **重复时间**（秋季回拨，同一墙上时间出现两次）：取**第一次**出现（较早的时刻）。
 * - **不存在的时间**（春季前拨造成的空洞，含整日被跳过的极端情况）：
 *   取“下一个有效时刻”，即按空洞长度顺延（例如 02:30 不存在 → 03:30）。
 *
 * 全程只用 `Intl` 提供的时区数据与 `Date.UTC`，不依赖宿主机本地时区。
 *
 * @param parts 目标墙上时间分量。
 * @param timeZone IANA 时区标识。
 * @returns 对应的 UTC 时刻。
 */
export function localWallTimeToInstant(parts: ZonedDateTimeParts, timeZone: string): Date {
  const wallMilliseconds = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  const firstGuess = wallMilliseconds - offsetMillisecondsAt(wallMilliseconds, timeZone);
  const secondGuess = wallMilliseconds - offsetMillisecondsAt(firstGuess, timeZone);
  const candidates =
    firstGuess === secondGuess ? [firstGuess] : [firstGuess, secondGuess];

  const matchingCandidates = candidates.filter((candidate) =>
    isSameWallTime(zonedDateTimeParts(new Date(candidate), timeZone), parts),
  );

  if (matchingCandidates.length > 0) {
    // 重复时间可能出现两个合法解，取较早者 = 第一次出现。
    return new Date(Math.min(...matchingCandidates));
  }

  // 墙上时间落在 DST 空洞里：取空洞之后的第一个有效时刻。
  return new Date(Math.max(...candidates));
}

/**
 * 公历日期加减天数（只做日历运算，不涉及时区与 DST）。
 *
 * @param date 基准日期。
 * @param days 天数偏移，可为负。
 * @returns 新的公历日期。
 */
export function addDaysToCivilDate(date: CivilDate, days: number): CivilDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
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
