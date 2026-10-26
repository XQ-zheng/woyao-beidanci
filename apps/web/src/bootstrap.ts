export type AppPlatform = 'web' | 'electron' | 'mobile';

export const APP_NAME = '我要背单词';
/** 版本号由 vite.config.ts 从根 package.json 注入，不在源码里重复硬编码。 */
export const APP_VERSION = __APP_VERSION__;

export interface AppRuntime {
  readonly platform: AppPlatform;
  readonly appVersion: string;
}

interface CapacitorLike {
  isNativePlatform?: () => boolean;
}

/**
 * 依据宿主特征判断当前运行平台。
 * Electron 与 Capacitor 的真实适配器由后续任务注入，这里只做最小识别。
 */
export function detectPlatform(userAgent: string, capacitor?: CapacitorLike): AppPlatform {
  if (capacitor?.isNativePlatform?.() === true) {
    return 'mobile';
  }

  if (userAgent.includes('Electron')) {
    return 'electron';
  }

  return 'web';
}

/** 幂等标记：重复调用 bootstrap（如 HMR、StrictMode 双执行）时不重复注册监听。 */
let errorHandlersRegistered = false;

/** 取出可读的错误消息。只记录 message，避免把完整错误对象及其堆栈反复打到控制台。 */
function toErrorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

/**
 * 启动期初始化：注册全局错误兜底，并返回运行时信息。
 * 数据库、安全存储等平台适配器后续从函数返回的运行时上下文中接入
 * （架构文档「初始化与登录」时序）。
 */
export function bootstrap(): AppRuntime {
  const capacitor = (globalThis as { Capacitor?: CapacitorLike }).Capacitor;
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;

  if (typeof window !== 'undefined' && !errorHandlersRegistered) {
    errorHandlersRegistered = true;

    window.addEventListener('error', (event) => {
      console.error('[woyao] 未捕获错误：', toErrorMessage(event.error, event.message));
    });
    window.addEventListener('unhandledrejection', (event) => {
      const reason: unknown = event.reason;
      console.error('[woyao] 未处理的 Promise 拒绝：', toErrorMessage(reason, String(reason)));
    });
  }

  return {
    platform: detectPlatform(userAgent, capacitor),
    appVersion: APP_VERSION,
  };
}
