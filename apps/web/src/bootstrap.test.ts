import { describe, expect, it, vi } from 'vitest';

import rootManifest from '../../../package.json';
import { APP_VERSION, bootstrap, detectPlatform } from './bootstrap';

describe('bootstrap', () => {
  it('版本号来自根 package.json，而不是源码里另写一份', () => {
    expect(APP_VERSION).toBe(rootManifest.version);
  });

  it('按宿主特征识别平台', () => {
    expect(detectPlatform('Mozilla/5.0 Chrome/140.0')).toBe('web');
    expect(detectPlatform('Mozilla/5.0 Electron/40.0 Chrome/140.0')).toBe('electron');
    expect(detectPlatform('Mozilla/5.0', { isNativePlatform: () => true })).toBe('mobile');
  });

  it('重复调用不会重复注册全局错误监听', () => {
    const addEventListener = vi.spyOn(window, 'addEventListener');
    addEventListener.mockClear();

    bootstrap();

    const registered = () =>
      addEventListener.mock.calls.filter(([type]) => type === 'error').length;

    expect(registered()).toBe(1);
    bootstrap();
    bootstrap();
    expect(registered()).toBe(1);

    addEventListener.mockRestore();
  });

  it('全局错误只输出 message，不输出完整错误对象', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleError.mockClear();

    bootstrap();
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('渲染失败'), message: '渲染失败' }));

    expect(consoleError).toHaveBeenCalledWith('[woyao] 未捕获错误：', '渲染失败');
    consoleError.mockRestore();
  });
});
