import { afterEach, describe, expect, it } from 'vitest';

import type { SqliteDatabase } from './connection';
import { closeDatabase, listAppliedMigrations, migrate, openDatabase } from './connection';
import { InvalidDatabasePathError, MigrationError } from './errors';

/** 本文件创建的连接，`afterEach` 统一关闭（内存库不关会随测试进程一起泄漏）。 */
const openDatabases: SqliteDatabase[] = [];

/** 建一个已迁移过的内存库。 */
function createMigratedDatabase(): SqliteDatabase {
  const db = openDatabase(':memory:');
  migrate(db);
  openDatabases.push(db);
  return db;
}

/** 读出一张表的所有列名。 */
function columnsOf(db: SqliteDatabase, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((row) => row.name);
}

/** 读出一张表的建表 SQL 文本。 */
function createSqlOf(db: SqliteDatabase, table: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined;
  return row?.sql ?? '';
}

/** 读出库里所有索引名。 */
function indexNamesOf(db: SqliteDatabase): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

/** `better-sqlite3` 约束错误的 `code` 取值（比正则匹配 message 稳定得多）。 */
type SqliteConstraintCode =
  | 'SQLITE_CONSTRAINT_UNIQUE'
  | 'SQLITE_CONSTRAINT_CHECK'
  | 'SQLITE_CONSTRAINT_FOREIGNKEY'
  | 'SQLITE_CONSTRAINT_NOTNULL';

/**
 * 断言某个写操作被**指定的**数据库约束拦下。
 *
 * 为什么不用 `toThrow(/CHECK/i)`：message 文本随 SQLite 版本/语言环境变，
 * 而且 `CHECK` 子串对 `FOREIGN KEY`、`NOT NULL` 的失败也可能偶然命中，
 * 于是“约束没生效”和“约束生效了但错了”分不开。`code` 是稳定且互斥的。
 *
 * @param run 待执行并应失败的写操作。
 * @param expectedCode 期望的约束错误码。
 */
function expectSqliteConstraint(run: () => void, expectedCode: SqliteConstraintCode): void {
  try {
    run();
  } catch (error) {
    const sqliteError = error as { code?: string; message?: string };
    expect(sqliteError.code).toBe(expectedCode);
    return;
  }
  throw new Error(`期望被 ${expectedCode} 拦下，但写操作成功了（约束没生效）`);
}

afterEach(() => {
  while (openDatabases.length > 0) {
    const db = openDatabases.pop();
    if (db !== undefined) {
      closeDatabase(db);
    }
  }
});

describe('migrate：建表与幂等', () => {
  it('创建全部领域表与同步表（17 张，含 schema_migrations）', () => {
    const db = createMigratedDatabase();

    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const tables = rows.map((row) => row.name);

    expect(tables).toEqual(
      [
        'associations',
        'content_cache',
        'deck_words',
        'decks',
        'frequency_entries',
        'learning_events',
        'learning_state',
        'plan_windows',
        'schema_migrations',
        'settings',
        'sources',
        'study_sessions',
        'sync_conflicts',
        'sync_outbox',
        'sync_state',
        'word_senses',
        'words',
      ].sort(),
    );
    expect(tables).toHaveLength(17);
  });

  it('关键查询都有索引（否则热路径会退化成全表扫）', () => {
    const db = createMigratedDatabase();
    const indexes = indexNamesOf(db);

    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_learning_state_due',
        'idx_learning_events_user_word',
        'idx_learning_events_local_date',
        'idx_words_normalized',
        'idx_word_senses_word',
        'idx_decks_owner_kind',
        'idx_sync_outbox_seq',
      ]),
    );
  });

  it('两次 migrate 是幂等的：版本表只有 001/002，applied_at 不被覆盖', () => {
    const db = createMigratedDatabase();
    const before = db
      .prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version')
      .all() as { version: string; applied_at: string }[];

    expect(() => migrate(db)).not.toThrow();
    expect(listAppliedMigrations(db)).toEqual(['001', '002']);

    const after = db
      .prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version')
      .all() as { version: string; applied_at: string }[];
    expect(after).toEqual(before);
    expect(after).toHaveLength(2);
  });

  it('applied_at 是 UTC ISO-8601 毫秒字符串（由 SQLite 生成，不用 new Date()）', () => {
    const db = createMigratedDatabase();
    const rows = db.prepare('SELECT applied_at FROM schema_migrations').all() as {
      applied_at: string;
    }[];

    for (const row of rows) {
      expect(row.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
      expect(Number.isNaN(Date.parse(row.applied_at))).toBe(false);
    }
  });

  it('learning_events 以 event_id 为主键（幂等键）', () => {
    const db = createMigratedDatabase();

    const columns = columnsOf(db, 'learning_events');
    expect(columns).toEqual(
      expect.arrayContaining([
        'event_id',
        'user_word_id',
        'mode',
        'recognition',
        'stage_before',
        'stage_after',
        'local_date',
        'synced_at',
      ]),
    );

    const tableInfo = db.prepare('PRAGMA table_info(learning_events)').all() as {
      name: string;
      pk: number;
    }[];
    expect(tableInfo.filter((column) => column.pk > 0).map((column) => column.name)).toEqual([
      'event_id',
    ]);
  });

  it('words 唯一键是 (owner_scope, normalized_lemma)，软删后可重新添加且跨账号隔离', () => {
    const db = createMigratedDatabase();
    const insert = db.prepare(
      `INSERT INTO words (id, owner_scope, lemma, normalized_lemma, created_at, updated_at)
       VALUES (?, ?, ?, ?, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    );

    insert.run('w1', 'LOCAL', 'Abandon', 'abandon');
    expectSqliteConstraint(() => insert.run('w2', 'LOCAL', 'abandon', 'abandon'), 'SQLITE_CONSTRAINT_UNIQUE');
    // 不同 owner_scope 不冲突（账号隔离）。
    expect(() => insert.run('w3', 'acct:u1', 'abandon', 'abandon')).not.toThrow();

    db.prepare("UPDATE words SET deleted_at = '2025-01-02T00:00:00.000Z' WHERE id = 'w1'").run();
    expect(() => insert.run('w4', 'LOCAL', 'abandon', 'abandon')).not.toThrow();
  });

  it('normalized_lemma 必须是已标准化形式（CHECK 兜住脏数据）', () => {
    const db = createMigratedDatabase();

    expectSqliteConstraint(
      () =>
        db
          .prepare(
            `INSERT INTO words (id, owner_scope, lemma, normalized_lemma, created_at, updated_at)
             VALUES ('w9', 'LOCAL', 'Abandon', ' Abandon ', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
          )
          .run(),
      'SQLITE_CONSTRAINT_CHECK',
    );
  });

  it('外键默认开启：义项不能挂在不存在的词上', () => {
    const db = createMigratedDatabase();

    expectSqliteConstraint(
      () =>
        db
          .prepare(
            `INSERT INTO word_senses (id, word_id, sense_no, created_at, updated_at)
             VALUES ('s1', 'missing-word', 1, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
          )
          .run(),
      'SQLITE_CONSTRAINT_FOREIGNKEY',
    );
  });

  it('learning_state 的 stage/weight 有 CHECK，符合 core 的取值域', () => {
    const db = createMigratedDatabase();
    db.prepare(
      `INSERT INTO words (id, owner_scope, lemma, normalized_lemma, created_at, updated_at)
       VALUES ('w1', 'LOCAL', 'abandon', 'abandon', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO decks (id, owner_scope, name, kind, created_at, updated_at)
       VALUES ('d1', 'LOCAL', '默认词库', 'BUILTIN', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    ).run();
    const insertState = db.prepare(
      `INSERT INTO learning_state
         (user_word_id, deck_id, word_id, stage, due_at, weight, state_updated_at)
       VALUES (?, 'd1', 'w1', ?, '2025-01-02T09:00:00.000Z', ?, '2025-01-01T00:00:00.000Z')`,
    );

    expect(() => insertState.run('u1', -1, 1)).not.toThrow();
    expectSqliteConstraint(() => insertState.run('u2', -2, 1), 'SQLITE_CONSTRAINT_CHECK');
    expectSqliteConstraint(() => insertState.run('u3', 0, 0.1), 'SQLITE_CONSTRAINT_CHECK');
    expectSqliteConstraint(() => insertState.run('u4', 0, 4.5), 'SQLITE_CONSTRAINT_CHECK');
  });

  it('frequency_entries 的 equal_count 是 NOT NULL DEFAULT 1 且 >= 1，total_tokens 允许 NULL', () => {
    const db = createMigratedDatabase();
    db.prepare(
      `INSERT INTO words (id, owner_scope, lemma, normalized_lemma, created_at, updated_at)
       VALUES ('w1', 'LOCAL', 'abandon', 'abandon', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO sources (id, owner_scope, type, name, created_at, updated_at)
       VALUES ('src1', 'LOCAL', 'FREQUENCY', 'NGSL', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    ).run();

    const insertEntry = db.prepare(
      `INSERT INTO frequency_entries (word_id, exam, corpus_version, frequency, total_tokens, rank, source_id)
       VALUES ('w1', ?, 'v1', 10, ?, 5, 'src1')`,
    );
    insertEntry.run('CET4', null);
    insertEntry.run('CET6', 1000);

    const rows = db
      .prepare('SELECT exam, equal_count, total_tokens FROM frequency_entries ORDER BY exam')
      .all() as { exam: string; equal_count: number; total_tokens: number | null }[];
    expect(rows.map((row) => row.equal_count)).toEqual([1, 1]);
    expect(rows.map((row) => row.total_tokens)).toEqual([null, 1000]);

    expectSqliteConstraint(
      () =>
        db
          .prepare(
            `INSERT INTO frequency_entries (word_id, exam, corpus_version, frequency, total_tokens, rank, equal_count, source_id)
             VALUES ('w1', 'ALL', 'v1', 10, 1000, 5, 0, 'src1')`,
          )
          .run(),
      'SQLITE_CONSTRAINT_CHECK',
    );
    // 列上不允许 NULL：SUM() 会跳过 NULL，任何基于 equal_count 的校验都会因此失效。
    expectSqliteConstraint(
      () =>
        db
          .prepare(
            `INSERT INTO frequency_entries (word_id, exam, corpus_version, frequency, total_tokens, rank, equal_count, source_id)
             VALUES ('w1', 'GRE', 'v1', 10, 1000, 5, NULL, 'src1')`,
          )
          .run(),
      'SQLITE_CONSTRAINT_NOTNULL',
    );

    expect(createSqlOf(db, 'frequency_entries')).toMatch(
      /equal_count\s+INTEGER\s+NOT NULL\s+DEFAULT\s+1\s+CHECK\s*\(\s*equal_count\s*>=\s*1\s*\)/i,
    );
  });

  it('settings 支持软删除（删除也要能同步给其他设备）', () => {
    const db = createMigratedDatabase();

    expect(columnsOf(db, 'settings')).toContain('deleted_at');
  });
});

describe('openDatabase / closeDatabase / migrate：错误路径', () => {
  it('空路径抛 InvalidDatabasePathError', () => {
    expect(() => openDatabase('')).toThrow(InvalidDatabasePathError);
    expect(() => openDatabase('   ')).toThrow(InvalidDatabasePathError);
  });

  it('closeDatabase 是幂等的（Electron 退出与测试清理都会重复调用）', () => {
    const db = openDatabase(':memory:');

    expect(() => {
      closeDatabase(db);
      closeDatabase(db);
    }).not.toThrow();
  });

  it('迁移失败时抛 MigrationError 并回滚该版本', () => {
    const db = openDatabase(':memory:');
    openDatabases.push(db);
    // 预先造一张同名但缺列的表，让 001 的 CREATE INDEX 撞车（IF NOT EXISTS 不会救场）。
    db.exec('CREATE TABLE learning_state (user_word_id TEXT PRIMARY KEY)');

    // 断言错误具体指向**哪一个**迁移版本，而不是"抛了个错"。
    try {
      migrate(db);
      expect.unreachable('应当抛出 MigrationError');
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
      if (error instanceof MigrationError) {
        expect(error.code).toBe('MIGRATION_FAILED');
        expect(error.message).toContain('001');
      }
    }

    // 001 整体回滚：schema_migrations 里不应出现 001，其他表也没被建出来。
    expect(listAppliedMigrations(db)).toEqual([]);
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'words'")
      .get();
    expect(tableExists).toBeUndefined();
  });
});
