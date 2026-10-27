import { defineConfig } from 'vitest/config';

/** 导出器在 Node 侧真实写文件；测试只使用系统临时目录，不读用户数据。 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
    testTimeout: 60000,
  },
});
