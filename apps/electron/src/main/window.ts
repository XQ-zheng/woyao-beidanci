/** 主窗口创建：安全选项集中在这里，避免各处 new BrowserWindow 时漏掉某一条。 */
import { BrowserWindow, shell } from 'electron';

/** 创建窗口的参数。 */
export interface MainWindowOptions {
  /** preload 脚本绝对路径（打包后位于 dist/preload）。 */
  readonly preloadPath: string;
  /** 开发服务器地址；给了就加载它，否则加载打包后的 index.html。 */
  readonly devServerUrl?: string;
  /** 打包后的 index.html 绝对路径。 */
  readonly indexPath: string;
  /** 窗口图标（可选）。 */
  readonly iconPath?: string;
  /**
   * 首屏加载完成回调。
   *
   * 必须在 `loadURL` **之前**注册：app:// 是本地读取，页面可能在调用方拿到窗口引用
   * 之前就已经加载完，之后再 `on('did-finish-load')` 就永远收不到事件。
   */
  readonly onDidFinishLoad?: () => void;
}

/**
 * 创建主窗口。
 *
 * 安全基线：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
 * 渲染进程只能通过 preload 暴露的白名单方法访问主进程，拿不到 require/process。
 *
 * @param options 路径与开发服务器地址。
 * @returns 创建好的窗口。
 */
export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: '我要背单词',
    backgroundColor: '#ffffff',
    icon: options.iconPath,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // 站外链接交给系统浏览器：应用窗口不带地址栏，被骗去钓鱼页时用户无处可核对。
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // 加载失败要说出来：静默失败的表现是“窗口一片空白”，排查成本极高。
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    console.error(`[woyao] 页面加载失败 ${errorCode} ${errorDescription} ${validatedUrl}`);
  });

  if (options.onDidFinishLoad !== undefined) {
    window.webContents.on('did-finish-load', options.onDidFinishLoad);
  }

  if (options.devServerUrl !== undefined) {
    void window.loadURL(options.devServerUrl);
  } else {
    void window.loadURL(options.indexPath);
  }

  return window;
}
