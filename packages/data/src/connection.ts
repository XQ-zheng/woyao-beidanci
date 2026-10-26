/**
 * SQLite 连接与迁移执行。
 *
 * 这一层只做三件事：打开连接（含 pragma）、按版本执行迁移、把已应用版本写进
 * `schema_migrations`。仓储层不自己建表，也不在运行时 `CREATE TABLE`
 * （除迁移外），避免“线上库结构与迁移脚本不一致”这种最常见的数据事故。
 *
 * **没有任何 `node:*` 导入**：迁移 SQL 由 `./migrations` 在构建期内联成字符串，
 * 因此本模块可以被打包进 Electron 主进程或移动端外壳而不依赖文件系统。
 * **也没有 `new Date()`**：所有时间戳要么由调用方注入，要么交给 SQLite 生成
 * （见 `APPLIED_AT_SQL`），保证回放与测试的确定性。
 */

import Database from 'better-sqlite3';

import { InvalidDatabasePathError, MigrationError } from './errors';
import { MIGRATIONS } from './migrations';

/** `better-sqlite3` 的数据库实例类型（全包统一用这个别名）。 */
export type SqliteDatabase = Database.Database;

/** SQLite 侧生成的 UTC ISO-8601 毫秒时间戳（与 JS `toISOString()` 同格式）。 */
export const APPLIED_AT_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** 迁移状态表本身不在 001 里：它必须先于任何迁移存在。 */
const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`;

/**
 * 打开（或创建）一个 SQLite 数据库。
 *
 * pragma 的选择与理由：
 * - `foreign_keys = ON`：SQLite 默认**不**强制外键，必须显式打开，否则引用完整性形同虚设；
 * - `busy_timeout = 5000`：多进程（Electron 主进程 + 后台任务）下避免瞬间 SQLITE_BUSY；
 * - `synchronous = NORMAL`：本地优先应用的崩溃安全与写入延迟折中（配合 WAL 足够）；
 * - `journal_mode = WAL`：内存库不支持 WAL，只在文件库上设置。
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
 * 关闭连接（幂等）。
 *
 * 显式提供这个函数而不是让调用方自己 `db.close()`：Electron 退出与测试清理
 * 都需要“已经关了再关一次也不炸”的语义。
 *
 * @param db 已打开的连接。
 */
export function closeDatabase(db: SqliteDatabase): void {
  if (db.open) {
    db.close();
  }
}

/**
 * 按版本顺序执行尚未应用的迁移（幂等）。
 *
 * 每条迁移都在**独立事务**里执行：SQL 失败时该版本整体回滚，不会留下半张表；
 * 已应用的版本被跳过，因此应用每次启动都可以无脑调用。
 *
 * @param db 已打开的连接。
 * @throws {MigrationError} 某条迁移执行失败时（含具体版本）。
 */
export function migrate(db: SqliteDatabase): void {
  db.exec(SCHEMA_MIGRATIONS_DDL);

  const isApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  const record = db.prepare(
    `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ${APPLIED_AT_SQL})`,
  );

  const ordered = [...MIGRATIONS].sort((left, right) => left.version.localeCompare(right.version));
  for (const migration of ordered) {
    if (isApplied.get(migration.version) !== undefined) {
      continue;
    }
    try {
      db.transaction(() => {
        db.exec(migration.sql);
        record.run(migration.version);
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
