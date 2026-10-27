/** 根元素基准字号（px）；字号缩放 1.0 等于它。 */
export const BASE_FONT_SIZE = 16;

/**
 * 把字号缩放作用到根元素。
 *
 * 用 `rem` 的组件（MUI 的排版都以 rem 计算）会整体跟着变；改的是 `documentElement`
 * 而不是 body，避免与 MUI 的 CssBaseline 抢样式。
 *
 * @param scale 缩放倍数（0.5–2）。
 */
export function applyFontScale(scale: number): void {
  document.documentElement.style.fontSize = `${Math.round(BASE_FONT_SIZE * scale)}px`;
}
