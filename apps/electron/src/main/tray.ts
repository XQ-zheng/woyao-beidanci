/** 系统托盘：最小化到托盘与退出。默认不启用（用户可在设置里打开）。 */
import { Menu, Tray, nativeImage, type BrowserWindow } from 'electron';

/** 托盘句柄：保留引用，避免被 GC 后图标消失。 */
let tray: Tray | null = null;

/**
 * 创建托盘图标与菜单。
 *
 * @param window 主窗口（菜单里“打开主窗口”用）。
 * @param iconPath 图标路径；文件不存在时用空图标，保证托盘仍可点。
 * @returns 托盘实例。
 */
export function createTray(window: BrowserWindow, iconPath?: string): Tray {
  const image = iconPath === undefined ? nativeImage.createEmpty() : nativeImage.createFromPath(iconPath);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('我要背单词');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '打开主窗口',
        click: () => {
          window.show();
          window.focus();
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          // 退出前先摘掉托盘，避免 Windows 上留下“幽灵图标”。
          tray?.destroy();
          tray = null;
          window.destroy();
        },
      },
    ]),
  );
  tray.on('click', () => {
    window.show();
    window.focus();
  });
  return tray;
}

/** 销毁托盘（退出时调用）。 */
export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
