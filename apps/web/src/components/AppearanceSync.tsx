import { useEffect } from 'react';

import { useServices } from '../services/ServiceProvider';

/**
 * 启动时把已保存的壁纸与字体应用到根元素。
 *
 * 壁纸：`SettingsSnapshot.wallpaper` 存的是 `file://` 绝对路径或空串；
 * 这里把 `body` 背景设成该图（覆盖 + 居中），文字层靠 `.app-surface` 半透明底保证可读。
 * 字体：`fontFamily` 为内置 key 时映射到一组字体栈；自定义导入字体直接作为字体名。
 *
 * 与 FontScaleSync 同理，挂在应用外壳上，保证任何页面都生效，而不是只在设置页。
 *
 * @returns 不渲染任何内容。
 */
export function AppearanceSync(): null {
  const services = useServices();

  useEffect(() => {
    if (services === null) {
      return;
    }
    let active = true;
    void services.settings
      .getSnapshot()
      .then((snapshot) => {
        if (!active) {
          return;
        }
        applyWallpaper(snapshot.wallpaper);
        applyFontFamily(snapshot.fontFamily);
      })
      .catch(() => {
        // 读不到设置就保持默认外观：这是显示偏好，不该阻断启动。
      });
    return () => {
      active = false;
    };
  }, [services]);

  return null;
}

/** 壁纸字体栈映射（内置 key → CSS 字体栈）。 */
const FONT_STACKS: Readonly<Record<string, string>> = {
  system:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif",
  serif: "'Noto Serif SC', 'Songti SC', 'SimSun', Georgia, serif",
  mono: "'Consolas', 'Menlo', 'Courier New', monospace",
  rounded: "'PingFang SC', 'Varela Round', 'Microsoft YaHei', sans-serif",
};

/** 把字体偏好作用到根元素。 */
function applyFontFamily(fontFamily: string): void {
  const resolved = FONT_STACKS[fontFamily] ?? fontFamily;
  document.documentElement.style.setProperty('--woyao-font', resolved);
}

/** 把壁纸作用到 body 背景。 */
function applyWallpaper(wallpaper: string): void {
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
