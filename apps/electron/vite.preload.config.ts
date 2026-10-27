import { defineConfig } from 'vite';

/**
 * preload 必须是一个**单文件**：沙箱里的 preload 只能 require('electron') 与少量内置模块，
 * 拆出 chunk 会在运行时找不到模块。所以这里独立打包、不做代码分割。
 */
export default defineConfig({
  build: {
    ssr: 'src/preload/index.ts',
    outDir: 'dist',
    emptyOutDir: false,
    target: 'node22',
    minify: false,
    rollupOptions: {
      external: ['electron'],
      output: {
        entryFileNames: 'preload/index.cjs',
        format: 'cjs',
        inlineDynamicImports: true,
      },
    },
  },
});
