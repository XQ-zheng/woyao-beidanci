/**
 * 外观应用（壁纸 / 字体）。
 *
 * 抽成独立模块的原因：启动时由 `AppearanceSync` 调用、设置页保存时也要立即调用，
 * 两处必须共用同一套映射与设置方式，否则「设置里换了字体但页面没变」。
 */

/** 内置字体 key → CSS 字体栈。 */
const FONT_STACKS: Readonly<Record<string, string>> = {
  system:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif",
  serif: "'Noto Serif SC', 'Songti SC', 'SimSun', Georgia, serif",
  mono: "'Consolas', 'Menlo', 'Courier New', monospace",
  rounded: "'PingFang SC', 'Varela Round', 'Microsoft YaHei', sans-serif",
};

/**
 * 把字体偏好作用到根元素（CSS 变量 `--woyao-font`，MUI 主题已引用它）。
 *
 * @param fontFamily 内置字体 key 或自定义字体名（导入字体的 FontFace family）。
 */
export function applyFontFamily(fontFamily: string): void {
  const resolved = FONT_STACKS[fontFamily] ?? `'${fontFamily}', sans-serif`;
  document.documentElement.style.setProperty('--woyao-font', resolved);
}

/**
 * 把壁纸作用到 body 背景；空串表示移除壁纸。
 *
 * @param wallpaper `file://` 路径、dataURL 或空串。
 */
export function applyWallpaper(wallpaper: string): void {
  if (wallpaper === '') {
    document.body.style.backgroundImage = '';
    document.body.style.backgroundColor = '#ffffff';
    return;
  }
  document.body.style.backgroundImage = `url("${wallpaper}")`;
  document.body.style.backgroundSize = 'cover';
  document.body.style.backgroundPosition = 'center';
  document.body.style.backgroundAttachment = 'fixed';
}
