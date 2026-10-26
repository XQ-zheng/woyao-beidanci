import { defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from '../../vite.config.ts';

/**
 * 在 Vite 配置之上叠加测试配置，而不是另起一份独立配置：
 * 这样可以复用根配置里的 `@woyao/*` 别名与 React 插件，后续 Task 6 的 UI 测试
 * 引用 `@woyao/core` 等 workspace 包时能直接解析（否则会报模块找不到）。
 *
 * 合并后 `root` 为仓库根（见 vite.config.ts），因此 `include` 与 `setupFiles`
 * 都必须写成相对仓库根的路径，而不是相对 apps/web。
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./apps/web/src/test/setup.ts'],
      include: ['apps/web/src/**/*.{test,spec}.{ts,tsx}'],
    },
  }),
);
