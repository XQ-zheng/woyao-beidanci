import { defineConfig } from 'vitest/config';

/** 主进程单测：纯 Node 环境（不启动 Electron）。 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
    // 关闭文件系统模块缓存：多个 workspace 共享根缓存时，Vitest 会尝试批量清理，
    // 在当前环境的 safe-delete 保护下会直接拒绝启动。
    fsModuleCache: false,
  },
});
