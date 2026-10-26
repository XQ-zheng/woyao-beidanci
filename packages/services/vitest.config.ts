import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * `@woyao/services` 的独立测试配置。
 *
 * 与 `@woyao/data` 同样的理由：Vitest 默认以 `process.cwd()` 为根，
 * 本包既可能被 `npm test --workspace @woyao/services` 调用（cwd=packages/services），
 * 也可能被根目录聚合命令调用（cwd=仓库根）。把 `root` 钉死为包目录并关闭
 * `passWithNoTests`，避免 `include` 落空后测试被静默跳过。
 *
 * `@woyao/core` / `@woyao/data` 是**运行时**导入：两者都通过 npm workspace 链接
 * （`node_modules/@woyao/*` → 包目录，`main` 指向 `src/index.ts`），Vitest 会按普通依赖
 * 解析并转译 TS 源码，因此这里**不需要**额外配 `resolve.alias`（实测通过）。
 */
const packageRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: packageRoot,
  test: {
    environment: 'node',
    globals: false,
    passWithNoTests: false,
    include: ['src/**/*.{test,spec}.ts'],
    clearMocks: true,
    /**
     * 关闭文件系统模块缓存。
     *
     * Vitest 默认把转换缓存放在**工作区根**的 `node_modules/.vitest-cache`，
     * 由所有 project 共享；多个包各自带 `root` 运行时，缓存键会互相失效，
     * 每次启动都尝试清空该目录。本仓库测试总量很小（毫秒级），
     * 关掉缓存比“共享缓存互相踢”更稳定，也避免在某些环境里触发批量删除保护。
     */
    fsModuleCache: false,
  },
});
