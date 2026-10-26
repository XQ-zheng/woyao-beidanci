import { describe, expect, it } from 'vitest';

import type { SqliteDatabase } from './connection';
import { listAppliedMigrations, migrate, openDatabase } from './connection';
import { InvalidDatabasePathError, MigrationError } from './errors';

/** 建一个已迁移过的内存库。 */
function createMigratedDatabase(): SqliteDatabase {
  const db = openDatabase(':memory:');
  migrate(db, { now: new Date('2025-01-01T00:00:00.000Z') });
  return db;
}

/** 读出一张表的所有列名。 */
function columnsOf(db: SqliteDatabase, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((row) => row.name);
}

/** 读出一张表的所有 CHECK/UNIQUE 约束（来自建表 SQL 文本）。 */
function createSqlOf(db: SqliteDatabase, table: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined;
  return row?.sql ?? '';
}

describe('migrate：建表与幂等', () => {
  it('创建全部领域表与同步表', () => {
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
  });

  it('两次 migrate 是幂等的，版本表只有 001/002', () => {
    const db = createMigratedDatabase();
    const secondNow = new Date('2025-02-02T00:00:00.000Z');

    expect(() => migrate(db, { now: secondNow })).not.toThrow();
    expect(listAppliedMigrations(db)).toEqual(['001', '002']);

    const rows = db.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version').all() as {
      version: string;
      applied_at: string;
    }[];
    // 幂等不只是“不报错”：已应用版本的 applied_at 不能被覆盖。
    expect(rows[0]?.applied_at).toBe('2025-01-01T00:00:00.000Z');
  });

  it('learning_events 以 event_id 为主键（幂等键）', () => {
    const db = createMigratedDatabase();

    const columns = columnsOf(db, 'learning_events');
    expect(columns).toContain('event_id');
    expect(columns).toContain('recognition');
    expect(columns).toContain('stage_before');
    expect(columns).toContain('stage_after');

    const pk = db.prepare('PRAGMA table_info(learning_events)').all() as { name: string; pk: number }[];
    expect(pk.filter((column) => column.pk > 0).map((column) => column.name)).toEqual(['event_id']);
  });

  it('words 唯一键是 (owner_scope, normalized_lemma)，且软删除后可重新添加', () => {
    const db = createMigratedDatabase();
    const insert = db.prepare(
      `INSERT INTO words (id, owner_scope, lemma, normalized_lemma, created_at, updated_at)
       VALUES (?, ?, ?, ?, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    );

    insert.run('w1', 'LOCAL', 'Abandon', 'abandon');
    expect(() => insert.run('w2', 'LOCAL', 'abandon', 'abandon')).toThrow(/UNIQUE/i);
    // 不同 owner_scope 不冲突（账号隔离）。
    expect(() => insert.run('w3', 'account-1', 'abandon', 'abandon')).not.toThrow();

    db.prepare("UPDATE words SET deleted_at = '2025-01-02T00:00:00.000Z' WHERE id = 'w1'").run();
    expect(() => insert.run('w4', 'LOCAL', 'abandon', 'abandon')).not.toThrow();
  });

  it('normalized_lemma 必须已是小写去空白形式（CHECK 兜住脏数据）', () => {
    const db = createMigratedDatabase();

    expect(() =>
      db
        .prepare(
          `INSERT INTO words (id, owner_scope, lemma, normalized_lemma, created_at, updated_at)
           VALUES ('w9', 'LOCAL', 'Abandon', ' Abandon ', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/CHECK/i);
  });

  it('外键默认开启：义项不能挂在不存在的词上', () => {
    const db = createMigratedDatabase();

    expect(() =>
      db
        .prepare(
          `INSERT INTO word_senses (id, word_id, sense_no, created_at, updated_at)
           VALUES ('s1', 'missing-word', 1, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
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
    expect(() => insertState.run('u2', -2, 1)).toThrow(/CHECK/i);
    expect(() => insertState.run('u3', 0, 0.1)).toThrow(/CHECK/i);
    expect(() => insertState.run('u4', 0, 4.5)).toThrow(/CHECK/i);
  });

  it('frequency_entries 的 equal_count 是 NOT NULL DEFAULT 1 且 >= 1', () => {
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
       VALUES ('w1', ?, 'v1', 10, 1000, 5, 'src1')`,
    );
    insertEntry.run('CET4');
    insertEntry.run('CET6');

    const rows = db
      .prepare('SELECT exam, equal_count FROM frequency_entries ORDER BY exam')
      .all() as { exam: string; equal_count: number }[];
    expect(rows.map((row) => row.equal_count)).toEqual([1, 1]);

    expect(() =>
      db
        .prepare(
          `INSERT INTO frequency_entries (word_id, exam, corpus_version, frequency, total_tokens, rank, equal_count, source_id)
           VALUES ('w1', 'ALL', 'v1', 10, 1000, 5, 0, 'src1')`,
        )
        .run(),
    ).toThrow(/CHECK/i);
    // 列上不允许 NULL：SUM() 会跳过 NULL，让 SUM(equal_count) == knownWordCount 失去意义。
    expect(() =>
      db
        .prepare(
          `INSERT INTO frequency_entries (word_id, exam, corpus_version, frequency, total_tokens, rank, equal_count, source_id)
           VALUES ('w1', 'GRE', 'v1', 10, 1000, 5, NULL, 'src1')`,
        )
        .run(),
    ).toThrow(/NOT NULL/i);
  });

  it('源表里的 frequency_entries 声明包含 equal_count 的 NOT NULL DEFAULT 1', () => {
    const db = createMigratedDatabase();

    expect(createSqlOf(db, 'frequency_entries')).toMatch(
      /equal_count\s+INTEGER\s+NOT NULL\s+DEFAULT\s+1\s+CHECK\s*\(\s*equal_count\s*>=\s*1\s*\)/i,
    );
  });
});

describe('openDatabase / migrate：错误路径', () => {
  it('空路径抛 InvalidDatabasePathError', () => {
    expect(() => openDatabase('')).toThrow(InvalidDatabasePathError);
    expect(() => openDatabase('   ')).toThrow(InvalidDatabasePathError);
  });

  it('迁移失败时抛 MigrationError 并回滚该版本', () => {
    const db = openDatabase(':memory:');
    // 预先造一张同名但缺列的表，让 001 的 CREATE INDEX 撞车（IF NOT EXISTS 不会救场）。
    db.exec('CREATE TABLE learning_state (user_word_id TEXT PRIMARY KEY)');

    expect(() => migrate(db)).toThrow(MigrationError);

    // 001 整体回滚：schema_migrations 里不应出现 001，其他表也没被建出来。
    expect(listAppliedMigrations(db)).toEqual([]);
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'words'")
      .get();
    expect(tableExists).toBeUndefined();
  });
});
