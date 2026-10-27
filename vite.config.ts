import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 仓库根目录。Vite 的 `root` 显式指向仓库根，因此无论从哪个 workspace
 * 调用 `vite --config ../../vite.config.ts`，入口 index.html 都固定为根目录的那一份。
 */
const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const workspaceSrc = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

interface RootManifest {
  readonly version: string;
}

/**
 * 版本号只在根 package.json 维护一份，构建与测试时通过 define 注入到源码，
 * 避免出现 package.json / index.html / 代码里三份各自漂移的版本号。
 */
const rootManifest = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as RootManifest;

export default defineConfig({
  root: repoRoot,
  // 产物要能被 Electron 用 file:// 直接打开：绝对路径 `/assets/...` 在 file:// 下会 404。
  // 相对路径对网页部署同样有效（放到任意子路径下都能加载）。
  base: './',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(rootManifest.version),
  },
  resolve: {
    alias: [
      // 与 tsconfig.base.json 的 paths 保持一致，后续任务创建对应包后即可直接引用。
      { find: '@woyao/core', replacement: workspaceSrc('packages/core/src') },
      { find: '@woyao/data', replacement: workspaceSrc('packages/data/src') },
      { find: '@woyao/services', replacement: workspaceSrc('packages/services/src') },
      { find: '@woyao/cloud', replacement: workspaceSrc('packages/cloud/src') },
      { find: '@woyao/exporters', replacement: workspaceSrc('packages/exporters/src') },
      { find: '@woyao/assets', replacement: workspaceSrc('packages/assets') },
      { find: '@woyao/web', replacement: workspaceSrc('apps/web/src') },
      { find: '@woyao/electron', replacement: workspaceSrc('apps/electron/src') },
      { find: '@woyao/mobile', replacement: workspaceSrc('apps/mobile/src') },
    ],
  },
  build: {
    outDir: 'dist/apps/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
