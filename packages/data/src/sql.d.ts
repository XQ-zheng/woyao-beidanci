/**
 * `.sql?raw` 静态导入的类型声明。
 *
 * 迁移 SQL 通过打包器（Vite / Rollup / esbuild）的 `?raw` 后缀在**构建期**内联成字符串，
 * 因此运行时不需要 `fs`、也不依赖 `.sql` 文件是否被打进安装包——
 * 这在 Electron / Capacitor 里是硬要求（asar 内 `readFileSync` 路径会变）。
 *
 * 本文件只声明类型，不产生任何运行时代码。
 */
declare module '*?raw' {
  const content: string;
  export default content;
}
