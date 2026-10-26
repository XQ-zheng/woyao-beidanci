/**
 * 事务封装。
 *
 * 数据层要求“每一次写入都在事务里”。直接用 `db.transaction(fn)()` 也能工作，
 * 但这里额外做两件事：
 * 1. **嵌套安全**：`better-sqlite3` 的嵌套 `transaction` 会自动降级为 SAVEPOINT，
 *    但很多人不知道；显式提供一个 `runInTransaction`，让仓储可以互相复用而不用担心。
 * 2. **回滚语义显式化**：回调抛错 → 整体回滚并向上抛原错误（不改写错误类型），
 *    避免调用方只能看到 `SqliteError` 而丢失业务语义。
 */

import type { SqliteDatabase } from './connection';

/** 事务选项。 */
export interface TransactionOptions {
  /**
   * 事务模式：
   * - `DEFERRED`（默认）：首个读写语句时才取锁，读多写少时更友好；
   * - `IMMEDIATE`：进入即取写锁，避免“读后写”升级锁时抛 SQLITE_BUSY，写路径建议用它。
   */
  readonly mode?: 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE';
}

/**
 * 在事务中同步执行 `work`，并返回其结果。
 *
 * @param db 已打开的连接。
 * @param work 事务体（必须是同步函数；SQLite 的写事务不应跨异步边界）。
 * @param options 事务模式。
 * @returns `work` 的返回值（提交成功后才是最终结果）。
 */
export function runInTransaction<T>(
  db: SqliteDatabase,
  work: () => T,
  options: TransactionOptions = {},
): T {
  const mode = options.mode ?? 'DEFERRED';
  const wrapped = db.transaction(work);
  switch (mode) {
    case 'IMMEDIATE':
      return wrapped.immediate();
    case 'EXCLUSIVE':
      return wrapped.exclusive();
    default:
      return wrapped.deferred();
  }
}
