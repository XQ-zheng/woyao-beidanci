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
  },
});
