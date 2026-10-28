/**
 * `@woyao/web` 自己的 Vite 配置：仓库根配置 + 「渲染进程专用替换」。
 *
 * 为什么不直接改根 `vite.config.ts`：根配置同时被 `vite-node` 脚本复用
 * （`scripts/import-dictionary.ts` 等要在 Node 里真开 SQLite），在那里把
 * `better-sqlite3` 换成桩会弄坏数据导入链路。只有浏览器构建需要替换，
 * 所以拆出这一份，由 `apps/web/package.json` 的 dev/build/preview 使用。
 */
import { fileURLToPath } from 'node:url';

import { mergeConfig } from 'vite';

import baseConfig from '../../vite.config.ts';

/** 浏览器端 better-sqlite3 桩（见文件头注释）。 */
const betterSqlite3Stub = fileURLToPath(new URL('./src/stubs/better-sqlite3.ts', import.meta.url));

export default mergeConfig(baseConfig, {
  resolve: {
    alias: [
      // 精确匹配：不吞 `better-sqlite3/lib/...` 之类的子路径导入（当前没有，防患于未然）。
      { find: /^better-sqlite3$/u, replacement: betterSqlite3Stub },
    ],
  },
});
