/**
 * 外观应用（壁纸 / 字体）。
 *
 * 抽成独立模块的原因：启动时由 `AppearanceSync` 调用、设置页保存时也要立即调用，
 * 两处必须共用同一套映射与设置方式，否则「设置里换了字体但页面没变」。
 */

/**
 * 内置字体 key → CSS 字体栈。
 *
 * 取值参考 Office/PPT 的默认中文字体（等线、微软雅黑、宋体、黑体、楷体、仿宋）
 * 与开源常用字体（思源黑体/宋体），只收**常用**的，避免下拉里几十个用不上的选项。
 * 全部用系统已装字体名做 fallback，不额外下载字体文件。
 */
export const FONT_STACKS: Readonly<Record<string, string>> = {
  system:
    "'DengXian', '等线', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', sans-serif",
  yahei: "'Microsoft YaHei', '微软雅黑', 'PingFang SC', sans-serif",
  dengxian: "'DengXian', 'DengXian Light', '等线', 'Microsoft YaHei', sans-serif",
  heiti: "'SimHei', '黑体', 'Microsoft YaHei', sans-serif",
  songti: "'SimSun', '宋体', 'Songti SC', 'Noto Serif SC', serif",
  kaiti: "'KaiTi', '楷体', 'STKaiti', serif",
  fangsong: "'FangSong', '仿宋', 'STFangsong', serif",
  sourcehan: "'Source Han Sans SC', 'Noto Sans SC', '思源黑体', 'Microsoft YaHei', sans-serif",
  sourcehanserif: "'Source Han Serif SC', 'Noto Serif SC', '思源宋体', 'SimSun', serif",
  mono: "'Consolas', 'Cascadia Mono', 'Menlo', 'Courier New', monospace",
  rounded: "'PingFang SC', 'Varela Round', 'Microsoft YaHei', sans-serif",
};

/** 字体选择项（设置页下拉与搜索用）。 */
export interface FontOption {
  readonly value: string;
  readonly label: string;
  /** 搜索关键字（中英文别名，便于按拼音或中文片段匹配）。 */
  readonly keywords: string;
}

/** 常用字体列表：按「日常最常用」排序，下拉默认先看到它们。 */
export const FONT_OPTIONS: ReadonlyArray<FontOption> = [
  { value: 'system', label: '等线（Office 默认）', keywords: 'dengxian 等线 默认' },
  { value: 'yahei', label: '微软雅黑', keywords: 'yahei weiruan 微软雅黑' },
  { value: 'songti', label: '宋体', keywords: 'songti simsun 宋体' },
  { value: 'heiti', label: '黑体', keywords: 'heiti simhei 黑体' },
  { value: 'kaiti', label: '楷体', keywords: 'kaiti 楷体' },
  { value: 'fangsong', label: '仿宋', keywords: 'fangsong 仿宋' },
  { value: 'sourcehan', label: '思源黑体（Noto Sans SC）', keywords: 'sourcehan noto sans 思源黑体' },
  {
    value: 'sourcehanserif',
    label: '思源宋体（Noto Serif SC）',
    keywords: 'sourcehan noto serif 思源宋体',
  },
  { value: 'dengxian', label: '等线 Light（细体）', keywords: 'dengxian light 等线 细' },
  { value: 'mono', label: '等宽（Consolas / Cascadia）', keywords: 'mono consolas cascadia 等宽' },
  { value: 'rounded', label: '圆润（PingFang / Varela）', keywords: 'rounded pingfang 圆润' },
];

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
 * 把壁纸作用到 body 背景（兜底路径；正常由 `WallpaperLayer` 用 dataURL 渲染）。
 *
 * 注意：`file://` 在 `app://` 页面会被安全策略拦掉，这里的入参必须是 dataURL 或空串。
 *
 * @param wallpaper dataURL 或空串（空串 = 移除壁纸）。
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
