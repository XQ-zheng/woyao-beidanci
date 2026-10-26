/**
 * 设置与学习时段仓储。
 *
 * 设置按 **key 粒度**同步（而不是整表覆盖）：两端各改不同键时不会互相覆盖，
 * 同一个键冲突才需要用户裁决。因此主键就是 `key`，`value_json` 存序列化后的字符串，
 * JSON 解析交给上层（数据层不猜业务结构）。
 *
 * 删除是**软删除**：删除本身也要同步，直接 `DELETE` 会让其他设备永远不知道该删这个键。
 */

import type { SqliteDatabase } from './connection';
import { InvalidRepositoryInputError } from './errors';
import { runInTransaction } from './transaction';

/** 一段学习时段（对应 `plan_windows` 一行）。 */
export interface PlanWindowRecord {
  readonly id: string;
  /** 生效的本地日 `YYYY-MM-DD`。 */
  readonly effectiveLocalDate: string;
  /** 起始分钟（0–1439）。 */
  readonly startMinute: number;
  /** 结束分钟（1–1440，必须大于起始）。 */
  readonly endMinute: number;
  /** IANA 时区名。 */
  readonly timeZone: string;
  readonly updatedAt: string;
  readonly deviceId: string;
  readonly revision: number;
  readonly deletedAt: string | null;
}

/** 设置仓储契约（Task 5 直接消费）。 */
export interface SettingsRepository {
  get(key: string): string | null;
  set(key: string, value: string, deviceId: string, now: Date): void;
  getAll(): Record<string, string>;
  remove(key: string, deviceId: string, now: Date): void;
  listPlanWindows(): PlanWindowRecord[];
  replacePlanWindows(
    windows: readonly PlanWindowRecord[],
    deviceId: string,
    now: Date,
  ): void;
}

/** `plan_windows` 行的 snake_case 形状。 */
interface PlanWindowRow {
  id: string;
  effective_local_date: string;
  start_minute: number;
  end_minute: number;
  time_zone: string;
  updated_at: string;
  device_id: string;
  revision: number;
  deleted_at: string | null;
}

/**
 * 校验非空字符串字段。
 *
 * @param value 待校验值。
 * @param field 字段名。
 * @returns 原值。
 * @throws {InvalidRepositoryInputError} 不是非空字符串时。
 */
function requireNonEmptyString(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidRepositoryInputError(field, '必须是非空字符串');
  }
  return value;
}

/**
 * 校验注入的时间。
 *
 * @param now 时间。
 * @param field 字段名。
 * @returns UTC ISO-8601 字符串。
 * @throws {InvalidRepositoryInputError} 不是有效 Date 时。
 */
function toIsoInstant(now: Date, field = 'now'): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new InvalidRepositoryInputError(field, `${field} 必须是有效 Date`);
  }
  return now.toISOString();
}

/**
 * 校验一个学习时段。
 *
 * @param window 时段。
 * @throws {InvalidRepositoryInputError} 任一字段非法时。
 */
function assertValidWindow(window: PlanWindowRecord): void {
  if (window === null || typeof window !== 'object') {
    throw new InvalidRepositoryInputError('windows', '学习时段不能为空');
  }
  requireNonEmptyString(window.id, 'windows.id');
  if (
    typeof window.effectiveLocalDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(window.effectiveLocalDate)
  ) {
    throw new InvalidRepositoryInputError(
      'windows.effectiveLocalDate',
      `生效日期必须是 YYYY-MM-DD，收到 ${String(window.effectiveLocalDate)}`,
    );
  }
  if (!Number.isInteger(window.startMinute) || window.startMinute < 0 || window.startMinute > 1439) {
    throw new InvalidRepositoryInputError(
      'windows.startMinute',
      `起始分钟必须是 0–1439 的整数，收到 ${String(window.startMinute)}`,
    );
  }
  if (!Number.isInteger(window.endMinute) || window.endMinute < 1 || window.endMinute > 1440) {
    throw new InvalidRepositoryInputError(
      'windows.endMinute',
      `结束分钟必须是 1–1440 的整数，收到 ${String(window.endMinute)}`,
    );
  }
  if (window.endMinute <= window.startMinute) {
    throw new InvalidRepositoryInputError(
      'windows.endMinute',
      `结束分钟必须大于起始分钟（${window.startMinute} → ${window.endMinute}）`,
    );
  }
  requireNonEmptyString(window.timeZone, 'windows.timeZone');
}

/** 行 → 时段记录。 */
function toPlanWindowRecord(row: PlanWindowRow): PlanWindowRecord {
  return {
    id: row.id,
    effectiveLocalDate: row.effective_local_date,
    startMinute: row.start_minute,
    endMinute: row.end_minute,
    timeZone: row.time_zone,
    updatedAt: row.updated_at,
    deviceId: row.device_id,
    revision: row.revision,
    deletedAt: row.deleted_at,
  };
}

/**
 * 创建设置仓储。
 *
 * @param db 已迁移的连接。
 * @returns 仓储实例。
 */
export function createSettingsRepository(db: SqliteDatabase): SettingsRepository {
  const selectValue = db.prepare('SELECT value_json FROM settings WHERE key = ? AND deleted_at IS NULL');
  const selectAll = db.prepare(
    'SELECT key, value_json FROM settings WHERE deleted_at IS NULL ORDER BY key ASC',
  );
  const upsertValue = db.prepare(
    `INSERT INTO settings (key, value_json, updated_at, device_id, revision, deleted_at)
     VALUES (?, ?, ?, ?, 0, NULL)
     ON CONFLICT (key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at,
       device_id = excluded.device_id,
       deleted_at = NULL,
       revision = settings.revision + 1`,
  );
  const softDeleteValue = db.prepare(
    `UPDATE settings
        SET deleted_at = ?, updated_at = ?, device_id = ?, revision = revision + 1
      WHERE key = ? AND deleted_at IS NULL`,
  );
  const selectWindows = db.prepare(
    `SELECT id, effective_local_date, start_minute, end_minute, time_zone, updated_at,
            device_id, revision, deleted_at
       FROM plan_windows
      WHERE deleted_at IS NULL
      ORDER BY effective_local_date ASC, start_minute ASC, id ASC`,
  );
  const softDeleteAllWindows = db.prepare(
    `UPDATE plan_windows
        SET deleted_at = ?, updated_at = ?, device_id = ?, revision = revision + 1
      WHERE deleted_at IS NULL`,
  );
  const upsertWindow = db.prepare(
    `INSERT INTO plan_windows
       (id, effective_local_date, start_minute, end_minute, time_zone, updated_at, device_id, revision, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)
     ON CONFLICT (id) DO UPDATE SET
       effective_local_date = excluded.effective_local_date,
       start_minute = excluded.start_minute,
       end_minute = excluded.end_minute,
       time_zone = excluded.time_zone,
       updated_at = excluded.updated_at,
       device_id = excluded.device_id,
       deleted_at = NULL,
       revision = plan_windows.revision + 1`,
  );

  return {
    get(key: string): string | null {
      const normalizedKey = requireNonEmptyString(key, 'key');
      const row = selectValue.get(normalizedKey) as { value_json: string } | undefined;
      return row === undefined ? null : row.value_json;
    },

    set(key: string, value: string, deviceId: string, now: Date): void {
      const normalizedKey = requireNonEmptyString(key, 'key');
      if (typeof value !== 'string') {
        throw new InvalidRepositoryInputError('value', '设置值必须是字符串（JSON 序列化由调用方负责）');
      }
      const device = requireNonEmptyString(deviceId, 'deviceId');
      const nowIso = toIsoInstant(now);
      runInTransaction(
        db,
        () => {
          upsertValue.run(normalizedKey, value, nowIso, device);
        },
        { mode: 'IMMEDIATE' },
      );
    },

    getAll(): Record<string, string> {
      const rows = selectAll.all() as { key: string; value_json: string }[];
      const result: Record<string, string> = {};
      for (const row of rows) {
        result[row.key] = row.value_json;
      }
      return result;
    },

    remove(key: string, deviceId: string, now: Date): void {
      const normalizedKey = requireNonEmptyString(key, 'key');
      const device = requireNonEmptyString(deviceId, 'deviceId');
      const nowIso = toIsoInstant(now);
      runInTransaction(
        db,
        () => {
          softDeleteValue.run(nowIso, nowIso, device, normalizedKey);
        },
        { mode: 'IMMEDIATE' },
      );
    },

    listPlanWindows(): PlanWindowRecord[] {
      const rows = selectWindows.all() as PlanWindowRow[];
      return rows.map(toPlanWindowRecord);
    },

    replacePlanWindows(
      windows: readonly PlanWindowRecord[],
      deviceId: string,
      now: Date,
    ): void {
      if (!Array.isArray(windows)) {
        throw new InvalidRepositoryInputError('windows', 'windows 必须是数组');
      }
      const device = requireNonEmptyString(deviceId, 'deviceId');
      const nowIso = toIsoInstant(now);
      for (const window of windows) {
        assertValidWindow(window);
      }

      runInTransaction(
        db,
        () => {
          // 全量替换 = 旧行全部软删 + 新行 upsert（同 id 的行在同一事务里被复活）。
          softDeleteAllWindows.run(nowIso, nowIso, device);
          for (const window of windows) {
            upsertWindow.run(
              window.id,
              window.effectiveLocalDate,
              window.startMinute,
              window.endMinute,
              window.timeZone,
              nowIso,
              device,
            );
          }
        },
        { mode: 'IMMEDIATE' },
      );
    },
  };
}
