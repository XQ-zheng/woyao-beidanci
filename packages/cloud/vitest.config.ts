import { defineConfig } from 'vitest/config';

/** 云适配层单测：不联网，全部注入假 SDK。 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
    fsModuleCache: false,
  },
});
