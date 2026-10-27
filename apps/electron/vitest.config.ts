import { defineConfig } from 'vitest/config';

/** 主进程单测：纯 Node 环境（不启动 Electron）。 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
  },
});
