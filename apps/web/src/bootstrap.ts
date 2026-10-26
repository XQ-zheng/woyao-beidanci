export type AppPlatform = 'web' | 'electron' | 'mobile';

export const APP_NAME = '我要背单词';
export const APP_VERSION = '0.1.0';

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

/**
 * 启动期初始化：注册全局错误兜底，并返回运行时信息。
 * 数据库、安全存储等平台适配器后续从函数返回的运行时上下文中接入
 * （架构文档「初始化与登录」时序）。
 */
export function bootstrap(): AppRuntime {
  const capacitor = (globalThis as { Capacitor?: CapacitorLike }).Capacitor;
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;

  if (typeof window !== 'undefined') {
    window.addEventListener('error', (event) => {
      console.error('[woyao] 未捕获错误：', event.error ?? event.message);
    });
    window.addEventListener('unhandledrejection', (event) => {
      console.error('[woyao] 未处理的 Promise 拒绝：', event.reason);
    });
  }

  return {
    platform: detectPlatform(userAgent, capacitor),
    appVersion: APP_VERSION,
  };
}
