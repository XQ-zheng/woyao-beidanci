import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * `@woyao/core` 的独立测试配置。
 *
 * 必须显式声明 `root`：Vitest 默认用 `process.cwd()` 作为根目录，
 * 而本包既可能通过 `npm test --workspace @woyao/core`（cwd=packages/core）运行，
 * 也可能被根目录的聚合命令调用（cwd=仓库根）。若 `root` 随 cwd 漂移，
 * `include` 就会匹配不到任何文件，测试被静默跳过——这正是审查中被点出的风险。
 * 这里把 `root` 钉死为包目录，并显式关闭 `passWithNoTests`，让 0 个测试直接失败。
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
     * Vitest 默认把转换缓存放在**工作区根**的 `node_modules/.vitest-cache`，由所有
     * project 共享；本仓库的 web / core / data 三个 project 各自带不同的 `root`，
     * 缓存键会互相失效，于是每次 `npm test` 都尝试清空这个共享目录。
     * 测试量很小（毫秒级），关掉缓存比“共享缓存互相踢”更稳定，
     * 也避免在某些环境里触发批量删除保护而让启动阶段直接失败。
     */
    fsModuleCache: false,
  },
});
