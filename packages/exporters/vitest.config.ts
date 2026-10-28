import { defineConfig } from 'vitest/config';

/** 导出器在 Node 侧真实写文件；测试只使用系统临时目录，不读用户数据。 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // 关闭文件系统模块缓存：多个 workspace 共享根缓存时，Vitest 会尝试批量清理，
    // 在当前环境的 safe-delete 保护下会直接拒绝启动。
    fsModuleCache: false,
    include: ['src/**/*.test.ts'],
    testTimeout: 60000,
  },
});
