/**
 * Electron 主进程入口。
 *
 * 生命周期很短：加单实例锁 → 装配数据库与服务 → 注册 IPC → 开窗口 → 按设置接托盘/自启。
 * 业务规则一律在 `@woyao/services` 里，这里只做“平台接线”。
 */
import { existsSync, writeFileSync } from 'node:fs';
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

/** Windows 应用用户模型 ID：任务栏图标分组与快捷方式归属都靠它。 */
const WINDOWS_APP_USER_MODEL_ID = 'com.woyao.beidanci';

/** 静态资源位置（web 产物与图标），随运行形态变化，见 {@link resolveStaticRoots}。 */
interface StaticRoots {
  /** web 产物目录（必须含 index.html）。 */
  readonly webRoot: string;
  /** 图标等随包资源目录。 */
  readonly assetsDir: string;
}

/**
 * 计算静态资源目录。
 *
 * 两种布局差别很大，所以必须显式分支，不能靠一堆 `../` 猜：
 * - 开发态：`__dirname` = `apps/electron/dist/main`，web 产物在**仓库根** `dist/apps/web`；
 * - 打包态：`<安装目录>/resources/app/{dist/web,assets}`，源码目录已经不存在。
 *
 * 用 `app.isPackaged` 而不是“哪个路径存在”——目录缺失时应该报错暴露问题，
 * 而不是悄悄退到另一个布局上继续白屏。
 *
 * @returns web 产物目录与资源目录。
 */
function resolveStaticRoots(): StaticRoots {
  if (app.isPackaged) {
    const appRoot = path.join(process.resourcesPath, 'app');
    return {
      webRoot: path.join(appRoot, 'dist', 'web'),
      assetsDir: path.join(appRoot, 'assets'),
    };
  }
  return {
    webRoot: path.join(__dirname, '../../../../dist/apps/web'),
    assetsDir: path.join(__dirname, '../../assets'),
  };
}

/** 数据库与服务（`app.whenReady` 之后才有值）。 */
let runtime: DesktopRuntime | null = null;

/**
 * 应用图标（PNG）绝对路径。窗口、托盘共用一份，避免三处各写一遍相对路径。
 *
 * @returns 图标路径。
 */
function resolveIconPath(): string {
  return path.join(resolveStaticRoots().assetsDir, 'icon.png');
}
/** 主窗口。 */
let mainWindow: BrowserWindow | null = null;
/** 是否正在退出（用于区分“关窗口”和“退应用”）。 */
let quitting = false;
/** 当前是否“关闭窗口时最小化到托盘”（来自设置，默认 false）。 */
let minimizeToTray = false;

// 先定应用名：`userData` 目录由它推导，包名带 scope（@woyao/electron）会生成难读的路径。
app.setName('woyao-beidanci');
// 任务栏分组/固定到任务栏后的图标归属：不设的话 Windows 会把窗口当成 electron.exe 的。
app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
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

      // web 产物目录：开发态是仓库根 dist/apps/web，打包态是 resources/app/dist/web。
      const staticRoots = resolveStaticRoots();
      const iconPath = path.join(staticRoots.assetsDir, 'icon.png');
      if (!existsSync(path.join(staticRoots.webRoot, 'index.html'))) {
        // 白屏最常见的原因就是产物没构建或路径算错，提前喊出来。
        console.error(`[woyao] web 产物缺失：${staticRoots.webRoot}（请先执行 npm run package:win 或 npm run build）`);
      }
      console.log(`[woyao] webRoot=${staticRoots.webRoot} icon=${existsSync(iconPath) ? 'ok' : 'missing'}`);
      serveAppProtocol(staticRoots.webRoot);

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
        iconPath: resolveIconPath(),
        onDidFinishLoad: createSmokeReporter(),
      });
      mainWindow = window;

      // 冒烟模式：把加载失败/崩溃/控制台错误也落盘，打包版白屏时才有线索。
      const smokeOut = process.env.WOYAO_SMOKE_OUT;
      if (smokeOut !== undefined) {
        installSmokeDiagnostics(window, smokeOut);
      }

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
        createTray(window, resolveIconPath());
      }

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          mainWindow = createMainWindow({
            preloadPath: path.join(__dirname, '../preload/index.cjs'),
            indexPath: APP_ENTRY_URL,
            devServerUrl: process.env.VITE_DEV_SERVER_URL,
            iconPath: resolveIconPath(),
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
    finishSmoke(smokeOut, () =>
      target.webContents
        .executeJavaScript(SMOKE_SCRIPT)
        .then((info: unknown) => ({ ok: true, info }))
        .catch((error: unknown) => ({ ok: false, error: String(error) })),
    );
  };
}

/** 冒烟诊断信息收集器。 */
interface SmokeDiagnostics {
  /** 已记录的关键事件。 */
  readonly events: string[];
  /** 停表，写文件后调用避免重复退出。 */
  stop(): void;
}

/**
 * 在冒烟模式下挂上诊断监听：页面加载失败/渲染进程崩溃/控制台错误都记下来。
 *
 * 打包版白屏时，主进程 `console.log` 在 Windows GUI 子系统里往往看不到，
 * 所以把“为什么没加载成功”落进同一个 JSON，而不是让人对着空白窗口猜。
 *
 * @param window 刚创建的主窗口。
 * @param smokeOut 报告文件路径。
 * @returns 诊断收集器。
 */
function installSmokeDiagnostics(window: BrowserWindow, smokeOut: string): SmokeDiagnostics {
  const events: string[] = [];
  const record = (entry: string): void => {
    events.push(`${new Date().toISOString()} ${entry}`);
  };
  record(`app.isPackaged=${String(app.isPackaged)} resources=${process.resourcesPath}`);

  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    record(`did-fail-load ${String(code)} ${description} ${url}`);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    record(`render-process-gone ${details.reason}`);
  });
  // Electron 45 的 console-message 回调第一个参数是事件对象；老版本是 level 数字，这里两种都兼容。
  window.webContents.on('console-message', (...args: unknown[]) => {
    const payload = args[1];
    const message =
      typeof payload === 'object' && payload !== null && 'message' in payload
        ? String((payload as { message: unknown }).message)
        : String(args[2] ?? '');
    record(`console ${message.slice(0, 300)}`);
  });

  const timer = setTimeout(() => {
    if (existsSync(smokeOut)) {
      // 正常路径已经写过报告（did-finish-load 成功），别覆盖成“超时”。
      setTimeout(() => app.quit(), 300);
      return;
    }
    record('timeout: 25s 内没有收到 did-finish-load');
    const target = BrowserWindow.getAllWindows()[0];
    writeFileSync(
      smokeOut,
      JSON.stringify(
        {
          timedOut: true,
          url: target === undefined ? null : target.webContents.getURL(),
          crashed: target === undefined ? null : target.webContents.isCrashed(),
          events,
        },
        null,
        2,
      ),
      'utf8',
    );
    setTimeout(() => app.quit(), 300);
  }, 25_000);

  return {
    events,
    stop: () => {
      clearTimeout(timer);
    },
  };
}

/**
 * 写冒烟报告并把应用退出。
 *
 * @param smokeOut 报告文件路径。
 * @param probe 采集函数（返回要落盘的对象）。
 */
function finishSmoke(smokeOut: string, probe: () => Promise<unknown>): void {
  void probe()
    .then((result) => {
      writeFileSync(smokeOut, JSON.stringify(result, null, 2), 'utf8');
    })
    .catch((error: unknown) => {
      writeFileSync(smokeOut, JSON.stringify({ error: String(error) }, null, 2), 'utf8');
    })
    .finally(() => {
      setTimeout(() => app.quit(), 300);
    });
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
    createTray(mainWindow, resolveIconPath());
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
