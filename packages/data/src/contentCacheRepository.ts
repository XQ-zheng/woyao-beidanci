/**
 * 内容缓存仓储（`content_cache` 表）。
 *
 * 用途：缓存**在线内容**（词典释义、发音元数据、AI 翻译结果）。关键语义：
 * - `get` 即使条目已过期也**返回**——TTL 只决定“要不要刷新”，不决定“能不能用”；
 *   “能否用”由服务层结合在线可用性判断（离线时过期缓存反而更有价值）。
 * - `payload` 在库里是 `payload_json` 字符串，仓储负责序列化/反序列化；
 *   反序列化失败（脏数据）时 `get` 返回 `null`，不把坏缓存当成功。
 * - `evict(provider)` 清空某个 provider 的全部缓存（例如 provider 配置变更后强制重取）。
 *
 * 时间一律注入（`fetchedAt`/`expiresAt` 是 ISO 字符串，由服务层用 `clock` 生成）；
 * 本包零 `node:*`、零 `new Date()`。
 */

import type { SqliteDatabase } from './connection';
import { InvalidRepositoryInputError } from './errors';
import { runInTransaction } from './transaction';

/** 一条内容缓存（payload 是任意 JSON 值）。 */
export interface ContentCacheEntry {
  /** 缓存键，例如 `content:word:abandon`。 */
  readonly cacheKey: string;
  /** provider 名，例如 `dictionaryapi` / `llm`。 */
  readonly provider: string;
  /** 被缓存的 JSON 内容。 */
  readonly payload: unknown;
  /** 抓取时间（UTC ISO-8601）。 */
  readonly fetchedAt: string;
  /** 过期时间（UTC ISO-8601）；`null` 表示永不过期。 */
  readonly expiresAt: string | null;
  /** 内容来源 id（`sources.id`）；本地合成内容可为 `null`。 */
  readonly sourceId: string | null;
}

/** 内容缓存仓储契约。 */
export interface ContentCacheRepository {
  /** 读一条缓存；命中但已过期仍返回（由服务层判断是否可用）。 */
  get(cacheKey: string): ContentCacheEntry | null;
  /** 写/覆盖一条缓存（按 `cacheKey` upsert）。 */
  set(entry: ContentCacheEntry): void;
  /** 清空某个 provider 的全部缓存。 */
  evict(provider: string): void;
}

/** UTC ISO-8601 毫秒格式（与数据层其它时间字段同一套）。 */
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** 校验非空字符串。 */
function requireNonEmptyString(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidRepositoryInputError(field, '必须是非空字符串');
  }
  return value;
}

/** 校验严格 ISO-8601 毫秒时间字符串。 */
function requireIsoInstant(value: string, field: string): string {
  requireNonEmptyString(value, field);
  if (!ISO_INSTANT_PATTERN.test(value)) {
    throw new InvalidRepositoryInputError(field, `必须是 UTC ISO-8601 毫秒格式（收到 ${value}）`);
  }
  return value;
}

/** `content_cache` 行的 snake_case 形状。 */
interface ContentCacheRow {
  cache_key: string;
  provider: string;
  payload_json: string;
  fetched_at: string;
  expires_at: string | null;
  source_id: string | null;
}

/**
 * 创建内容缓存仓储。
 *
 * @param db 已迁移的连接。
 * @returns 仓储实例。
 */
export function createContentCacheRepository(db: SqliteDatabase): ContentCacheRepository {
  const selectByKey = db.prepare(
    `SELECT cache_key, provider, payload_json, fetched_at, expires_at, source_id
       FROM content_cache WHERE cache_key = ?`,
  );
  const upsert = db.prepare(
    `INSERT INTO content_cache (cache_key, provider, payload_json, fetched_at, expires_at, source_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (cache_key) DO UPDATE SET
       provider = excluded.provider,
       payload_json = excluded.payload_json,
       fetched_at = excluded.fetched_at,
       expires_at = excluded.expires_at,
       source_id = excluded.source_id`,
  );
  const deleteByProvider = db.prepare(`DELETE FROM content_cache WHERE provider = ?`);

  return {
    get(cacheKey: string): ContentCacheEntry | null {
      requireNonEmptyString(cacheKey, 'cacheKey');
      const row = selectByKey.get(cacheKey) as ContentCacheRow | undefined;
      if (row === undefined) {
        return null;
      }
      // 脏缓存（payload_json 不是合法 JSON）不抛错、不当成功：按未命中处理。
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload_json) as unknown;
      } catch {
        return null;
      }
      return {
        cacheKey: row.cache_key,
        provider: row.provider,
        payload,
        fetchedAt: row.fetched_at,
        expiresAt: row.expires_at,
        sourceId: row.source_id,
      };
    },

    set(entry: ContentCacheEntry): void {
      if (entry === null || typeof entry !== 'object') {
        throw new InvalidRepositoryInputError('entry', '缓存条目不能为空');
      }
      const cacheKey = requireNonEmptyString(entry.cacheKey, 'cacheKey');
      const provider = requireNonEmptyString(entry.provider, 'provider');
      const fetchedAt = requireIsoInstant(entry.fetchedAt, 'fetchedAt');
      const expiresAt = entry.expiresAt === null ? null : requireIsoInstant(entry.expiresAt, 'expiresAt');
      const sourceId = entry.sourceId ?? null;

      // `payload` 必须是可 JSON 序列化的值；序列化失败（循环引用等）是入参错误，
      // 不能塞进库里再在 `get` 时才发现。
      let payloadJson: string;
      try {
        payloadJson = JSON.stringify(entry.payload ?? null);
      } catch {
        throw new InvalidRepositoryInputError('payload', '缓存内容无法 JSON 序列化');
      }

      runInTransaction(
        db,
        () => {
          upsert.run(cacheKey, provider, payloadJson, fetchedAt, expiresAt, sourceId);
        },
        { mode: 'IMMEDIATE' },
      );
    },

    evict(provider: string): void {
      requireNonEmptyString(provider, 'provider');
      runInTransaction(db, () => {
        deleteByProvider.run(provider);
      });
    },
  };
}
