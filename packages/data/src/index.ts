/**
 * `@woyao/data` 的公开入口。
 *
 * 分层约定：
 * - `connection` / `transaction`：连接的 pragma 与事务边界；
 * - `wordRepository` / `learningRepository` / `syncRepository` / `settingsRepository`：仓储；
 * - `errors`：稳定的错误码，供服务层与 IPC 分支，不要靠 message 匹配。
 *
 * 本包是 Node 侧（`better-sqlite3` 原生模块），不要在浏览器端 import。
 */

export * from './connection';
export * from './errors';
export * from './learningRepository';
export * from './settingsRepository';
export * from './syncRepository';
export * from './transaction';
export * from './wordRepository';
