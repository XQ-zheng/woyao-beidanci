import { defineConfig } from 'vite';

/**
 * 主进程打包。
 *
 * 用 **SSR 构建**（`build.ssr`）而不是普通 lib 构建：普通构建会把 `node:fs` 之类
 * 当成浏览器环境去替换成 `__vite-browser-external` 空壳，运行到 `mkdirSync` 才炸。
 * SSR 构建默认把 Node 内置模块与 `electron` 视作外部依赖。
 */
export default defineConfig({
  build: {
    ssr: 'src/main/index.ts',
    outDir: 'dist',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: {
      external: ['electron', 'better-sqlite3'],
      output: {
        entryFileNames: 'main/index.cjs',
        format: 'cjs',
      },
    },
  },
});
