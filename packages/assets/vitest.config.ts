import { defineConfig } from 'vitest/config';

/** 资源导入是纯 Node 过程；测试使用内存 SQLite 与临时文件，不碰用户数据。 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // 关闭文件系统模块缓存：多个 workspace 共享根缓存时，Vitest 会尝试批量清理，
    // 在当前环境的 safe-delete 保护下会直接拒绝启动。
    fsModuleCache: false,
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
  },
});
