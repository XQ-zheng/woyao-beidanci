import { defineConfig } from 'vitest/config';

/** 资源导入是纯 Node 过程；测试使用内存 SQLite 与临时文件，不碰用户数据。 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
  },
});
