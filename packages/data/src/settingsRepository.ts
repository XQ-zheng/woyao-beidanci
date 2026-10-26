/**
 * 设置仓储。
 *
 * 设置按 **key 粒度**同步（而不是整表覆盖）：两端各改不同键时不会互相覆盖，
 * 同一个键冲突才需要用户裁决。因此主键就是 `key`，`value_json` 存序列化后的值。
 */

import type { SqliteDatabase } from './connection';
import { InvalidRepositoryInputError } from './errors';

/** 设置仓储契约（Task 5 直接消费）。 */
export interface SettingsRepository {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** 校验键名。 */
function requireKey(key: string): string {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new InvalidRepositoryInputError('key', '设置键必须是非空字符串');
  }
  return key;
}

/**
 * 创建设置仓储。
 *
 * @param db 已迁移的连接。
 * @returns 仓储实例。
 */
export function createSettingsRepository(db: SqliteDatabase): SettingsRepository {
  const selectValue = db.prepare('SELECT value_json FROM settings WHERE key = ?');
  const upsertValue = db.prepare(
    `INSERT INTO settings (key, value_json, updated_at, device_id, revision)
     VALUES (?, ?, ?, '', 0)
     ON CONFLICT (key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at,
       revision = settings.revision + 1`,
  );

  return {
    get(key: string): string | null {
      const normalizedKey = requireKey(key);
      const row = selectValue.get(normalizedKey) as { value_json: string } | undefined;
      return row === undefined ? null : row.value_json;
    },

    set(key: string, value: string): void {
      const normalizedKey = requireKey(key);
      if (typeof value !== 'string') {
        throw new InvalidRepositoryInputError('value', '设置值必须是字符串（由调用方负责 JSON 序列化）');
      }
      upsertValue.run(normalizedKey, value, new Date().toISOString());
    },
  };
}
