import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** 浏览器端源码：只声明浏览器全局，不再顺带声明 Node 的 process/require/__dirname。 */
const webSourceFiles = ['apps/web/src/**/*.{ts,tsx}'];

/**
 * 领域核心源码：必须是可在浏览器、WebView、Node 中同样运行的纯 TS。
 * tsconfig 已不加载 Node 类型（`types: []`），这里再从模块层面堵住 Node 内置模块，
 * 防止 `import 'node:fs'` 这类只在 Node 可用的依赖渗进核心层。
 */
const coreSourceFiles = ['packages/core/src/**/*.ts'];

/**
 * 数据层源码：跑在 Node 侧（`better-sqlite3` 原生模块），但**同样不许 import `node:*`**。
 *
 * 原因不是洁癖：迁移 SQL 已通过 `?raw` 在构建期内联，时间戳要么由调用方注入、
 * 要么交给 SQLite 生成，ID 用 `globalThis.crypto.randomUUID()`——一旦有人写回
 * `node:fs` / `node:crypto`，Electron 打包与移动端 WebView 就会在运行时才炸。
 */
const dataSourceFiles = ['packages/data/src/**/*.ts'];

/**
 * 服务层源码：只做编排，**不得**碰平台 API。
 *
 * 平台能力必须走端口（`Clock` / `IdGeneratorPort` / `DeviceInfoPort` / `LoggerPort`），
 * 这样同一套服务能在 Electron 主进程、移动端 WebView、以及单元测试里跑出完全一致的结果。
 * 一旦有人在这里 `import 'node:fs'` 或 `fetch(...)`，移动端要重写的不只是一个函数。
 */
const servicesSourceFiles = ['packages/services/src/**/*.ts'];

/** 构建与检查工具的配置文件：这些才真正运行在 Node 里。 */
const toolingConfigFiles = [
  '**/*.config.{js,mjs,cjs,ts,mts,cts}',
  'eslint.config.js',
  'apps/web/vitest.config.ts',
];

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
  {
    files: webSourceFiles,
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    files: coreSourceFiles,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                'fs',
                'fs/promises',
                'path',
                'os',
                'process',
                'crypto',
                'child_process',
                'http',
                'https',
                'net',
                'worker_threads',
              ],
              message:
                'packages/core 是浏览器中立的纯 TS 领域层：不得导入 Node 内置模块，平台能力请放到适配器层。',
            },
          ],
        },
      ],
    },
  },
  {
    files: dataSourceFiles,
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                'fs',
                'fs/promises',
                'path',
                'os',
                'process',
                'crypto',
                'child_process',
                'http',
                'https',
                'net',
                'worker_threads',
              ],
              message:
                'packages/data 的数据层不得导入 Node 内置模块：迁移 SQL 用 ?raw 内联，时间与 ID 由调用方注入或交给 SQLite，平台能力放到 Electron/Capacitor 适配层。',
            },
          ],
        },
      ],
    },
  },
  {
    files: servicesSourceFiles,
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                'fs',
                'fs/promises',
                'path',
                'os',
                'process',
                'crypto',
                'child_process',
                'http',
                'https',
                'net',
                'worker_threads',
                'electron',
                '@capacitor/*',
              ],
              message:
                'packages/services 只做编排：不得导入 Node 内置模块、Electron 或 Capacitor。平台能力（时钟/id/设备号/日志/网络）请通过 ports 注入。',
            },
          ],
        },
      ],
    },
  },
  {
    files: toolingConfigFiles,
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
