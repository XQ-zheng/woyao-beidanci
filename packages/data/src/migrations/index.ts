/**
 * 迁移清单（**构建期内联**，不在运行时读文件）。
 *
 * 两条约束决定了这里必须用 `?raw` 而不是 `node:fs`：
 * 1. 数据层零 `node:*` 导入（见 `.eslintrc` 的 `packages/data/src/**` 块）——
 *    同一份代码要能被 Electron 主进程与移动端 WebView 打包；
 * 2. 打包后 `.sql` 文件的运行时路径不可靠（asar / iOS bundle），
 *    `readFileSync(new URL(...))` 在开发机能跑、装完就炸。
 *
 * 顺带的好处：迁移版本是**显式清单**而不是 `readdir` 排序，
 * 不会因为有人往目录里丢文件就被自动执行。
 */

import initSql from './001_init.sql?raw';
import syncSql from './002_sync.sql?raw';

/** 一条迁移：版本号 + 便于排障的名称 + 内联 SQL 文本。 */
export interface MigrationDefinition {
  /** 稳定版本号，按字符串升序执行，写入 `schema_migrations.version`。 */
  readonly version: string;
  /** 人类可读名称，仅用于日志与报错。 */
  readonly name: string;
  /** 内联的迁移 SQL。 */
  readonly sql: string;
}

/**
 * 全部迁移，按执行顺序排列。
 *
 * 新增迁移只能**追加**，不得修改已发布条目的 `version` 或 SQL——
 * 已经跑过该版本的用户不会被重放，改了等于给自己造出两个不同的库结构。
 */
export const MIGRATIONS: readonly MigrationDefinition[] = [
  { version: '001', name: 'init', sql: initSql },
  { version: '002', name: 'sync', sql: syncSql },
];
