/**
 * Electron 主进程入口。
 *
 * 生命周期很短：加单实例锁 → 装配数据库与服务 → 注册 IPC → 开窗口 → 按设置接托盘/自启。
 * 业务规则一律在 `@woyao/services` 里，这里只做“平台接线”。
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { app, BrowserWindow, ipcMain, net } from 'electron';

import type { SettingsSnapshot } from '@woyao/services';

import { IPC_CHANNELS } from '../shared/channels';
import { APP_ENTRY_URL, registerAppScheme, serveAppProtocol } from './appProtocol';
import { applyAutoStart } from './autoLaunch';
import { createDesktopRuntime, type DesktopRuntime } from './database';
import { createIpcRouter } from './ipc';
import { createTray, destroyTray } from './tray';
import { createMainWindow } from './window';

/** 数据库与服务（`app.whenReady` 之后才有值）。 */
let runtime: DesktopRuntime | null = null;
/** 主窗口。 */
let mainWindow: BrowserWindow | null = null;
/** 是否正在退出（用于区分“关窗口”和“退应用”）。 */
let quitting = false;
/** 当前是否“关闭窗口时最小化到托盘”（来自设置，默认 false）。 */
let minimizeToTray = false;

// 先定应用名：`userData` 目录由它推导，包名带 scope（@woyao/electron）会生成难读的路径。
app.setName('woyao-beidanci');
registerAppScheme();
// 纯 2D 界面（MUI/CSS）用不到 GPU；关掉硬件加速可避开虚拟机/远程桌面上
// "GPU process isn't usable" 直接退出，也省显存。
app.disableHardwareAcceleration();

/** 单实例锁：第二次启动只唤醒已有窗口，避免两个进程同时写一个 SQLite 文件。 */
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app
    .whenReady()
    .then(async () => {
      console.log(`[woyao] desktop ready (electron ${process.versions.electron}, data ${app.getPath('userData')})`);
      const created = createDesktopRuntime({
        userDataPath: app.getPath('userData'),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        isOnline: () => net.isOnline(),
      });
      runtime = created;

      // web 产物目录：apps/electron/dist/main → 仓库根/dist/apps/web
      const webRoot = path.join(__dirname, '../../../../dist/apps/web');
      serveAppProtocol(webRoot);

      const router = createIpcRouter({ services: created.services, clock: created.context.clock });
      for (const channel of IPC_CHANNELS) {
        ipcMain.handle(channel, async (_event, payload: unknown) => {
          const result = await router(channel, payload);
          // 设置改完立即生效：自启是系统状态，托盘是窗口行为，都要跟着最新快照走。
          if (channel === 'settings.update' && result.ok) {
            applySettings(result.data as SettingsSnapshot);
          }
          return result;
        });
      }

      const snapshot = await created.services.settings.getSnapshot();
      applySettings(snapshot);

      const window = createMainWindow({
        preloadPath: path.join(__dirname, '../preload/index.cjs'),
        indexPath: APP_ENTRY_URL,
        devServerUrl: process.env.VITE_DEV_SERVER_URL,
        iconPath: path.join(__dirname, '../../assets/icon.png'),
        onDidFinishLoad: createSmokeReporter(),
      });
      mainWindow = window;

      // 只有用户显式打开“最小化到托盘”才拦截关闭；默认关闭时点 × 就是退出。
      window.on('close', (event) => {
        if (!quitting && minimizeToTray) {
          event.preventDefault();
          window.hide();
        }
      });
      window.on('closed', () => {
        mainWindow = null;
      });

      console.log('[woyao] main window created');

      if (minimizeToTray) {
        createTray(window, path.join(__dirname, '../../assets/icon.png'));
      }

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          mainWindow = createMainWindow({
            preloadPath: path.join(__dirname, '../preload/index.cjs'),
            indexPath: APP_ENTRY_URL,
            devServerUrl: process.env.VITE_DEV_SERVER_URL,
            iconPath: path.join(__dirname, '../../assets/icon.png'),
          });
        }
      });
    })
    .catch((error: unknown) => {
      console.error('[woyao] 主进程启动失败：', error);
      app.quit();
    });
}

/** 冒烟钩子内容（只在 `WOYAO_SMOKE_OUT` 存在时启用）。 */
const SMOKE_SCRIPT = `(async () => {
  const bridge = window.woyao;
  const settings = bridge ? await bridge.invoke('settings.getSnapshot') : null;
  const decks = bridge ? await bridge.invoke('library.listDecks') : null;
  const blocked = bridge ? await bridge.invoke('db.dropEverything', {}) : null;
  return {
    title: document.title,
    url: location.href,
    text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300),
    hasBridge: Boolean(bridge),
    settingsOk: settings && settings.ok === true,
    settings: settings && settings.ok ? settings.data : null,
    decksOk: decks && decks.ok === true,
    decks: decks && decks.ok ? decks.data : null,
    blocked,
  };
})()`;

/**
 * 创建首个窗口加载完成后的冒烟报告函数。
 *
 * 未设置 `WOYAO_SMOKE_OUT` 时返回 undefined，正常启动完全不受影响。
 *
 * @returns 回调或 undefined。
 */
function createSmokeReporter(): (() => void) | undefined {
  const smokeOut = process.env.WOYAO_SMOKE_OUT;
  if (smokeOut === undefined) {
    return undefined;
  }
  return () => {
    const target = BrowserWindow.getAllWindows()[0];
    if (target === undefined) {
      return;
    }
    void target.webContents
      .executeJavaScript(SMOKE_SCRIPT)
      .then((info: unknown) => {
        writeFileSync(smokeOut, JSON.stringify(info, null, 2), 'utf8');
      })
      .catch((error: unknown) => {
        writeFileSync(smokeOut, JSON.stringify({ error: String(error) }, null, 2), 'utf8');
      })
      .finally(() => {
        setTimeout(() => app.quit(), 300);
      });
  };
}

/**
 * 把设置应用到系统：自启登记 + 托盘存在性。
 *
 * @param snapshot 最新设置快照。
 */
function applySettings(snapshot: SettingsSnapshot): void {
  minimizeToTray = snapshot.minimizeToTray;
  applyAutoStart(snapshot.autoStart);

  if (minimizeToTray && mainWindow !== null) {
    // createTray 内部会保留引用；重复调用时先销毁旧的，避免出现两个图标。
    destroyTray();
    createTray(mainWindow, path.join(__dirname, '../../assets/icon.png'));
  } else if (!minimizeToTray) {
    destroyTray();
  }
}

app.on('window-all-closed', () => {
  // 最小化到托盘时窗口只是隐藏，不会走到这里；其余情况跟随平台习惯。
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  quitting = true;
  destroyTray();
  runtime?.close();
  runtime = null;
});
