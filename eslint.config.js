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
    files: toolingConfigFiles,
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
