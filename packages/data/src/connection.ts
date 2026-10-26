/**
 * SQLite 连接与迁移执行。
 *
 * 这一层只做三件事：打开连接（含 pragma）、按顺序执行迁移、把迁移记录写进
 * `schema_migrations`。仓储层不自己建表，也不在运行时 `CREATE TABLE`
 * （除迁移外），避免“线上库结构与迁移脚本不一致”这种最常见的数据事故。
 */

import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';

import { InvalidDatabasePathError, MigrationError } from './errors';

/** `better-sqlite3` 的数据库实例类型（全包统一用这个别名）。 */
export type SqliteDatabase = Database.Database;

/** 一条迁移的定义。 */
export interface MigrationDefinition {
  /** 稳定版本号，按字符串升序执行；写入 `schema_migrations.version`。 */
  readonly version: string;
  /** 迁移名称，仅用于可读性与日志。 */
  readonly name: string;
  /** SQL 文件相对 `migrations/` 的文件名。 */
  readonly file: string;
}

/**
 * 迁移清单（**显式列出**，不靠 `readdir`）。
 *
 * 显式清单的好处：打包进 Electron/移动端时文件集合是确定的，
 * 不依赖运行时的目录读取顺序；也避免“有人往目录里丢了个 .sql 就被自动执行”。
 */
export const MIGRATIONS: readonly MigrationDefinition[] = [
  { version: '001', name: 'init', file: '001_init.sql' },
  { version: '002', name: 'sync', file: '002_sync.sql' },
];

/** 迁移状态表本身不在 001 里：它必须先于任何迁移存在。 */
const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

/**
 * 打开（或创建）一个 SQLite 数据库。
 *
 * pragma 的选择与理由：
 * - `foreign_keys = ON`：SQLite 默认**不**强制外键，必须显式打开，否则引用完整性形同虚设；
 * - `busy_timeout = 5000`：多进程（Electron 主进程 + 后台任务）下避免瞬间 SQLITE_BUSY；
 * - `journal_mode = WAL` + `synchronous = NORMAL`：本地优先应用的读写并发与崩溃安全折中；
 *   `:memory:` 不支持 WAL，所以只在文件库上设置。
 *
 * @param path 数据库文件路径，或 `:memory:`（测试用）。
 * @returns 已配置好 pragma 的连接。
 * @throws {InvalidDatabasePathError} 路径为空或不是字符串时。
 */
export function openDatabase(path: string): SqliteDatabase {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new InvalidDatabasePathError(path);
  }

  const database = new Database(path);
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  if (path !== ':memory:') {
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = NORMAL');
  }
  return database;
}

/**
 * 读取迁移 SQL 文本。用 `import.meta.url` 定位，避免依赖 `process.cwd()`。
 *
 * @param file 迁移文件名。
 * @returns SQL 文本。
 */
function readMigrationSql(file: string): string {
  const url = new URL(`./migrations/${file}`, import.meta.url);
  return readFileSync(url, 'utf8');
}

/** 迁移执行选项（便于测试固定时间戳）。 */
export interface MigrateOptions {
  /** 注入的当前时间，默认取系统时钟；仅用于写入 `applied_at`。 */
  readonly now?: Date;
}

/**
 * 按顺序执行尚未应用的迁移（幂等）。
 *
 * 每条迁移都在**独立事务**里执行：SQL 失败时该版本整体回滚，不会留下半张表。
 * 已应用的版本会被跳过，因此重复调用是安全的（应用启动时每次都会调用）。
 *
 * @param db 已打开的连接。
 * @param options 可选的注入时钟。
 * @throws {MigrationError} 某条迁移执行失败时（含具体版本）。
 */
export function migrate(db: SqliteDatabase, options: MigrateOptions = {}): void {
  const appliedAt = (options.now ?? new Date()).toISOString();
  db.exec(SCHEMA_MIGRATIONS_DDL);

  const isApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  const ordered = [...MIGRATIONS].sort((left, right) => left.version.localeCompare(right.version));
  for (const migration of ordered) {
    if (isApplied.get(migration.version) !== undefined) {
      continue;
    }
    let sql: string;
    try {
      sql = readMigrationSql(migration.file);
    } catch (error) {
      throw new MigrationError(migration.version, `无法读取迁移文件 ${migration.file}：${String(error)}`);
    }
    try {
      db.transaction(() => {
        db.exec(sql);
        record.run(migration.version, migration.name, appliedAt);
      })();
    } catch (error) {
      throw new MigrationError(
        migration.version,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

/**
 * 返回当前数据库已应用的迁移版本（升序）。
 *
 * @param db 已打开的连接。
 * @returns 版本号数组；未执行过任何迁移时为空数组。
 */
export function listAppliedMigrations(db: SqliteDatabase): string[] {
  const rows = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all() as { version: string }[];
  return rows.map((row) => row.version);
}
