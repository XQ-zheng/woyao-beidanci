/**
 * 图词联想仓储（`associations` 表）。
 *
 * 这张表此前**没有任何读写入口**，5C1 的 `associationService` 全靠它：
 * - `MEANING`（联想义）、`HOMOPHONE`（谐音）、`PICTOGRAPH`（象形/图记）；
 * - 软删：删除后 `listAssociations` 不再返回，但历史行还在（与词库/词条同一套同步语义）；
 * - `asset_uri` 只存**本机缓存地址**，绝不进入同步 payload（见 `docs/architecture.md` §11.3）；
 *   `origin_url` 才是可核验的来源地址，同步只发它。
 *
 * 时间一律注入（`now: Date`）、id 用 `globalThis.crypto.randomUUID()`：本包零 `node:*`、
 * 零 `new Date()`。
 */

import type { SqliteDatabase } from './connection';
import { InvalidRepositoryInputError } from './errors';
import { runInTransaction } from './transaction';

/** 联想类型。 */
export type AssociationKind = 'MEANING' | 'HOMOPHONE' | 'PICTOGRAPH';

/** 联想来源（谁生成的这条联想）。 */
export type AssociationGenerator = 'BUILTIN' | 'USER' | 'ONLINE';

/** 创建/更新一条联想的输入。 */
export interface AssociationInput {
  /** 联想 id；缺省时自动生成（导入脚本可传稳定 id 便于复现）。 */
  readonly id?: string;
  /** 词条 id（`words.id`，外键）。 */
  readonly wordId: string;
  readonly kind: AssociationKind;
  /** 联想文本（例如“abandon → 阿爸，别抛弃我”）。 */
  readonly text: string;
  /**
   * 本机缓存地址（例如 `file:///.../images/abandon.png`）。
   *
   * **只存本机路径、绝不进入同步 payload**：隐私红线，见文件头。
   */
  readonly assetUri?: string | null;
  /** 可核验来源地址（例如词典词条 URL），同步只发它。 */
  readonly originUrl?: string | null;
  /** 内容来源 id（`sources.id`）。 */
  readonly sourceId: string;
  readonly generatedBy: AssociationGenerator;
  readonly deviceId: string;
  readonly now: Date;
}

/** 联想记录（camelCase，对应 `associations` 一行）。 */
export interface AssociationRecord {
  readonly id: string;
  readonly wordId: string;
  readonly kind: AssociationKind;
  readonly text: string;
  readonly assetUri: string | null;
  readonly originUrl: string | null;
  readonly sourceId: string;
  readonly generatedBy: AssociationGenerator;
  readonly reviewedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly deviceId: string;
  readonly revision: number;
}

/** 联想仓储契约。 */
export interface AssociationRepository {
  /** 列出某词未软删的全部联想，按 kind、createdAt 升序。 */
  listAssociations(wordId: string): AssociationRecord[];
  /** 按 id 创建/更新一条联想（幂等）。 */
  upsertAssociation(input: AssociationInput): AssociationRecord;
  /** 软删一条联想（对不存在/已删 id 是空操作）。 */
  deleteAssociation(id: string, deviceId: string, now: Date): void;
}

/** 校验非空字符串。 */
function requireNonEmptyString(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidRepositoryInputError(field, '必须是非空字符串');
  }
  return value;
}

/** 校验注入的时间并转 UTC ISO-8601。 */
function toIsoInstant(now: Date, field = 'now'): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new InvalidRepositoryInputError(field, `${field} 必须是有效 Date`);
  }
  return now.toISOString();
}

/** 生成一个新 uuid（不依赖 `node:crypto`）。 */
function newId(): string {
  return globalThis.crypto.randomUUID();
}

/** 可空字符串字段：`null` / `undefined` / 空串都归一成 `null`，否则保留原值。 */
function nullableText(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  return value;
}

/** `associations` 行的 snake_case 形状。 */
interface AssociationRow {
  id: string;
  word_id: string;
  kind: AssociationKind;
  text: string;
  asset_uri: string | null;
  origin_url: string | null;
  source_id: string;
  generated_by: AssociationGenerator;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  device_id: string;
  revision: number;
}

/** 行 → 领域对象。 */
function toRecord(row: AssociationRow): AssociationRecord {
  return {
    id: row.id,
    wordId: row.word_id,
    kind: row.kind,
    text: row.text,
    assetUri: row.asset_uri,
    originUrl: row.origin_url,
    sourceId: row.source_id,
    generatedBy: row.generated_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    deviceId: row.device_id,
    revision: row.revision,
  };
}

/**
 * 创建图词联想仓储。
 *
 * @param db 已迁移的连接。
 * @returns 仓储实例。
 */
export function createAssociationRepository(db: SqliteDatabase): AssociationRepository {
  const ASSOCIATION_COLUMNS = `id, word_id, kind, text, asset_uri, origin_url, source_id,
                                generated_by, reviewed_at, created_at, updated_at, deleted_at,
                                device_id, revision`;
  const selectByWord = db.prepare(
    `SELECT ${ASSOCIATION_COLUMNS} FROM associations
      WHERE word_id = ? AND deleted_at IS NULL
      ORDER BY kind ASC, created_at ASC, id ASC`,
  );
  const selectById = db.prepare(`SELECT ${ASSOCIATION_COLUMNS} FROM associations WHERE id = ?`);
  const upsert = db.prepare(
    `INSERT INTO associations
       (id, word_id, kind, text, asset_uri, origin_url, source_id, generated_by,
        reviewed_at, created_at, updated_at, deleted_at, device_id, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, 0)
     ON CONFLICT (id) DO UPDATE SET
       word_id = excluded.word_id,
       kind = excluded.kind,
       text = excluded.text,
       asset_uri = excluded.asset_uri,
       origin_url = excluded.origin_url,
       source_id = excluded.source_id,
       generated_by = excluded.generated_by,
       updated_at = excluded.updated_at,
       deleted_at = NULL,
       device_id = excluded.device_id,
       revision = associations.revision + 1`,
  );
  const softDelete = db.prepare(
    `UPDATE associations
        SET deleted_at = ?, updated_at = ?, device_id = ?, revision = revision + 1
      WHERE id = ? AND deleted_at IS NULL`,
  );

  return {
    listAssociations(wordId: string): AssociationRecord[] {
      requireNonEmptyString(wordId, 'wordId');
      const rows = selectByWord.all(wordId) as AssociationRow[];
      return rows.map(toRecord);
    },

    upsertAssociation(input: AssociationInput): AssociationRecord {
      if (input === null || typeof input !== 'object') {
        throw new InvalidRepositoryInputError('input', '联想输入不能为空');
      }
      const wordId = requireNonEmptyString(input.wordId, 'wordId');
      if (input.kind !== 'MEANING' && input.kind !== 'HOMOPHONE' && input.kind !== 'PICTOGRAPH') {
        throw new InvalidRepositoryInputError('kind', `未知联想类型：${String(input.kind)}`);
      }
      const text = requireNonEmptyString(input.text, 'text').trim();
      if (
        input.generatedBy !== 'BUILTIN' &&
        input.generatedBy !== 'USER' &&
        input.generatedBy !== 'ONLINE'
      ) {
        throw new InvalidRepositoryInputError('generatedBy', `未知生成来源：${String(input.generatedBy)}`);
      }
      const sourceId = requireNonEmptyString(input.sourceId, 'sourceId');
      const deviceId = requireNonEmptyString(input.deviceId, 'deviceId');
      const nowIso = toIsoInstant(input.now);
      const assetUri = nullableText(input.assetUri);
      const originUrl = nullableText(input.originUrl);
      const id = input.id ?? newId();

      runInTransaction(
        db,
        () => {
          upsert.run(
            id,
            wordId,
            input.kind,
            text,
            assetUri,
            originUrl,
            sourceId,
            input.generatedBy,
            nowIso,
            nowIso,
            deviceId,
          );
        },
        { mode: 'IMMEDIATE' },
      );

      const stored = selectById.get(id) as AssociationRow | undefined;
      if (stored === undefined) {
        throw new InvalidRepositoryInputError('id', `联想写入后回读失败（id=${id}）`);
      }
      return toRecord(stored);
    },

    deleteAssociation(id: string, deviceId: string, now: Date): void {
      const associationId = requireNonEmptyString(id, 'id');
      const device = requireNonEmptyString(deviceId, 'deviceId');
      const nowIso = toIsoInstant(now);
      // 软删对不存在/已删的 id 是空操作（幂等），需要区分“找不到”的调用方自己先查。
      softDelete.run(nowIso, nowIso, device, associationId);
    },
  };
}
