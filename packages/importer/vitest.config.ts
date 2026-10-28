import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 各 workspace 共用 vitest 模块缓存会触发 safe-delete 拒绝启动，关掉。
    fsModuleCache: false,
  },
});
