import type { Config } from 'tailwindcss';

/**
 * Tailwind v4 以 CSS 优先配置为主（见 apps/web/src/styles.css 的 @config 与 @theme）。
 * 这里保留 legacy 配置对象，唯一职责是把内容扫描范围收敛到 Web 应用源码，
 * 避免 Tailwind 自动探测把文档、脚本里的示例类名也编译进产物。
 *
 * 注意：本文件不定义颜色与排版 token —— 颜色体系由 MUI 主题（apps/web/src/theme.ts）独占，
 * Tailwind 只负责布局与间距。
 */
const config: Config = {
  content: ['./index.html', './apps/web/src/**/*.{ts,tsx}'],
};

export default config;
