import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** 浏览器端源码：只声明浏览器全局，不再顺带声明 Node 的 process/require/__dirname。 */
const webSourceFiles = ['apps/web/src/**/*.{ts,tsx}'];

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
    files: toolingConfigFiles,
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
