/**
 * 测试与本地开发用的服务装配器。
 *
 * 作用：把**真实的**数据层（内存 SQLite + 已执行迁移）装成 `ServiceContext`，
 * 让服务层测试跑在真表真约束上，而不是一堆 mock。理由很实在：
 * 服务层最容易出错的恰恰是“和仓储的契约没对齐”（字段名、空值、幂等语义），
 * 用 mock 这些错误全都测不出来。
 *
 * 时间与 id 全部可注入：`createFixedClock` + 自增 id 让断言稳定可复现。
 */

import { createFixedClock, parseIsoInstant } from '@woyao/core';
import {
  closeDatabase,
  createLearningRepository,
  createSettingsRepository,
  createSyncRepository,
  createWordRepository,
  migrate,
  openDatabase,
  type DeckKind,
  type SqliteDatabase,
  type SyncRepository,
  type LearningRepository,
  type SettingsRepository,
  type WordRepository,
} from '@woyao/data';

import { asyncifyRepositories, type ServiceContext } from './ports';

/** 默认定时钟点（任何固定值都行，只要不是“读系统时间”）。 */
const DEFAULT_NOW = '2025-03-01T08:00:00.000Z';

/** 默认设备号。 */
const DEFAULT_DEVICE_ID = 'test-device';

/** 装配结果。 */
export interface ServiceTestHarness {
  /** 底层连接（测试需要直接验证表状态时用）。 */
  readonly db: SqliteDatabase;
  /** 同步仓储（播种数据、断言副作用用）。 */
  readonly sync: {
    readonly words: WordRepository;
    readonly learning: LearningRepository;
    readonly sync: SyncRepository;
    readonly settings: SettingsRepository;
  };
  /** 服务上下文（异步仓储 + 时钟 + id + 设备号）。 */
  readonly context: ServiceContext;
  /** 注入的设备号。 */
  readonly deviceId: string;
  /** 注入时钟的 ISO 字符串。 */
  readonly nowIso: string;
  /** 播种一个来源行（`sources`），返回 id。 */
  seedSource(sourceId?: string): string;
  /** 播种一个词条（可带义项），返回 id。 */
  seedWord(input: {
    id: string;
    lemma: string;
    ownerScope?: string;
    senses?: readonly SeedSense[];
  }): string;
  /** 播种一个词库，可顺手把词塞进去，返回 id。 */
  seedDeck(input: {
    id: string;
    name: string;
    kind?: DeckKind;
    ownerScope?: string;
    wordIds?: readonly string[];
  }): string;
  /** 关闭连接。 */
  close(): void;
}

/** 播种义项时用到的字段（`sourceId` 由装配器统一补 `local-user`）。 */
export interface SeedSense {
  readonly pos: string;
  readonly simpleZh: string;
  readonly detailedZh?: string | null;
  readonly contextText?: string | null;
}

/** 装配参数。 */
export interface ServiceTestHarnessOptions {
  /** 固定时钟的时刻（UTC ISO 毫秒）。 */
  readonly now?: string;
  /** 注入的设备号。 */
  readonly deviceId?: string;
}

/**
 * 创建一个内存数据库并把四个仓储装成服务上下文。
 *
 * @param options 时钟与设备号。
 * @returns 装配结果。
 */
export function createServiceTestHarness(options: ServiceTestHarnessOptions = {}): ServiceTestHarness {
  const nowIso = options.now ?? DEFAULT_NOW;
  const deviceId = options.deviceId ?? DEFAULT_DEVICE_ID;
  const db = openDatabase(':memory:');
  migrate(db);

  const sync = {
    words: createWordRepository(db),
    learning: createLearningRepository(db),
    sync: createSyncRepository(db),
    settings: createSettingsRepository(db),
  } as const;

  let idCounter = 0;
  const context: ServiceContext = {
    repos: asyncifyRepositories(sync),
    clock: createFixedClock(nowIso),
    ids: {
      nextId: (): string => {
        idCounter += 1;
        return `test-id-${String(idCounter)}`;
      },
    },
    device: {
      deviceId: (): string => deviceId,
    },
    log: {
      warn: (): void => {
        // 测试里默认静默；需要断言告警时在用例里替换 `context.log`。
      },
    },
  };

  const insertSource = db.prepare(
    `INSERT INTO sources (id, owner_scope, type, name, created_at, updated_at)
     VALUES (?, 'LOCAL', 'DICTIONARY', ?, ?, ?)`,
  );

  /** 义项需要一个来源（`word_senses.source_id` 有外键），播种时用 `local-user` 兜住。 */
  const ensureSeedSource = (): string => {
    const existing = db.prepare('SELECT id FROM sources WHERE id = ?').get('local-user') as
      | { id: string }
      | undefined;
    if (existing !== undefined) {
      return existing.id;
    }
    insertSource.run('local-user', '播种来源', nowIso, nowIso);
    return 'local-user';
  };

  return {
    db,
    sync,
    context,
    deviceId,
    nowIso,

    seedSource(sourceId = 'local-user'): string {
      insertSource.run(sourceId, `来源-${sourceId}`, nowIso, nowIso);
      return sourceId;
    },

    seedWord(input: {
      id: string;
      lemma: string;
      ownerScope?: string;
      senses?: readonly SeedSense[];
    }): string {
      const senses = input.senses ?? [];
      const sourceId = senses.length > 0 ? ensureSeedSource() : 'local-user';
      sync.words.createWord({
        id: input.id,
        ownerScope: input.ownerScope ?? 'LOCAL',
        lemma: input.lemma,
        senses: senses.map((sense) => ({
          pos: sense.pos,
          simpleZh: sense.simpleZh,
          detailedZh: sense.detailedZh ?? null,
          contextText: sense.contextText ?? null,
          sourceId,
        })),
        deviceId,
        now: parseIsoInstant(nowIso, 'now'),
      });
      return input.id;
    },

    seedDeck(input: {
      id: string;
      name: string;
      kind?: DeckKind;
      ownerScope?: string;
      wordIds?: readonly string[];
    }): string {
      sync.words.upsertDeck({
        id: input.id,
        ownerScope: input.ownerScope ?? 'LOCAL',
        name: input.name,
        kind: input.kind ?? 'CUSTOM',
        deviceId,
        now: parseIsoInstant(nowIso, 'now'),
      });
      for (const wordId of input.wordIds ?? []) {
        sync.words.addDeckWord(input.id, wordId, deviceId, parseIsoInstant(nowIso, 'now'));
      }
      return input.id;
    },

    close(): void {
      closeDatabase(db);
    },
  };
}
