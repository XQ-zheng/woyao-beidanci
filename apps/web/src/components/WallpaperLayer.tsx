import { useEffect, useState } from 'react';

import { useServices } from '../services/ServiceProvider';

/** 壁纸渲染状态：dataURL + 图片宽高（判断竖图/横图）。 */
interface WallpaperState {
  readonly dataUrl: string;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
}

/** 通过 IPC 桥调主进程通道（渲染层无桥时返回 null）。 */
async function invokeBridge<T>(channel: string, payload?: unknown): Promise<T | null> {
  const bridge = (globalThis as { woyao?: { invoke(c: string, p?: unknown): Promise<unknown> } }).woyao;
  if (bridge === undefined) {
    return null;
  }
  const raw = (await bridge.invoke(channel, payload)) as
    | { ok: true; data: T }
    | { ok: false; error: { message: string } };
  if (!raw.ok) {
    return null;
  }
  return raw.data;
}

/**
 * 全屏壁纸层。
 *
 * 为什么单独一层而不是 body 背景：需要按图片比例决定缩放方式，并支持竖向长图
 * 用滚轮上下移动（用户要求「中间放大到匹配界面，可上下滑动看被裁掉的部分」）。
 *
 * 缩放规则：
 * - 竖图（高/宽 > 视口比）：宽度铺满（`100% auto`），高度溢出 → 滚轮调 verticalOffset；
 * - 横图 / 方图：等比放大铺满（`cover`），左右溢出但居中固定（左右不滚动）。
 *
 * 数据来源：设置里存的是本地路径，渲染层必须走主进程转 dataURL（`file://` 在
 * `app://` 页面会被安全策略拦掉），这一步由 `settings.readWallpaper` 完成。
 */
export function WallpaperLayer(): React.JSX.Element | null {
  const services = useServices();
  const [wallpaper, setWallpaper] = useState<WallpaperState | null>(null);
  const [offset, setOffset] = useState(0);
  const [viewportH, setViewportH] = useState(() => window.innerHeight);

  // 读取设置里的壁纸路径 → 主进程转 dataURL → 读图片尺寸
  useEffect(() => {
    if (services === null) {
      return;
    }
    let active = true;
    void services.settings
      .getSnapshot()
      .then(async (snapshot) => {
        if (!active || snapshot.wallpaper === '') {
          return;
        }
        // 旧设置里可能已经存了 dataURL（历史版本），直接用；否则按路径读文件。
        const dataUrl = snapshot.wallpaper.startsWith('data:')
          ? snapshot.wallpaper
          : await invokeBridge<string>('settings.readWallpaper', { path: snapshot.wallpaper });
        if (!active || dataUrl === null || typeof dataUrl !== 'string') {
          return;
        }
        const image = new Image();
        image.onload = () => {
          if (active) {
            setWallpaper({
              dataUrl,
              naturalWidth: image.naturalWidth,
              naturalHeight: image.naturalHeight,
            });
          }
        };
        image.src = dataUrl;
      })
      .catch(() => {
        // 读不到就保持无壁纸，不阻断界面。
      });
    return () => {
      active = false;
    };
  }, [services]);

  // 设置页选好壁纸后广播 dataURL：立即显示，不必等保存或重启
  useEffect(() => {
    const onWallpaper = (event: Event): void => {
      const dataUrl = (event as CustomEvent<string>).detail;
      if (dataUrl === '') {
        setWallpaper(null);
        setOffset(0);
        return;
      }
      const image = new Image();
      image.onload = () => {
        setWallpaper({
          dataUrl,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
        });
        setOffset(0);
      };
      image.src = dataUrl;
    };
    window.addEventListener('woyao:wallpaper', onWallpaper);
    return () => window.removeEventListener('woyao:wallpaper', onWallpaper);
  }, []);

  // 视口尺寸变化（窗口缩放）时重算
  useEffect(() => {
    const onResize = (): void => setViewportH(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const isPortrait =
    wallpaper !== null && wallpaper.naturalHeight / wallpaper.naturalWidth > viewportH / window.innerWidth;

  // 竖向长图：滚轮上下移动壁纸（只在壁纸层上监听，不干扰页面滚动）
  useEffect(() => {
    if (!isPortrait || wallpaper === null) {
      return;
    }
    const onWheel = (event: WheelEvent): void => {
      // 竖图按宽度铺满后的实际高度
      const scaledHeight = (wallpaper.naturalHeight / wallpaper.naturalWidth) * window.innerWidth;
      const maxOffset = Math.max(0, scaledHeight - window.innerHeight);
      if (maxOffset === 0) {
        return;
      }
      setOffset((prev) => {
        const next = prev + event.deltaY;
        return Math.min(maxOffset, Math.max(0, next));
      });
    };
    window.addEventListener('wheel', onWheel, { passive: true });
    return () => window.removeEventListener('wheel', onWheel);
  }, [isPortrait, wallpaper]);

  if (wallpaper === null) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      data-testid="wallpaper-layer"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: -1,
        pointerEvents: 'none',
        backgroundImage: 'url("' + wallpaper.dataUrl + '")',
        backgroundRepeat: 'no-repeat',
        // 竖图：宽度铺满（高度按比例溢出，可滚动）；横图：等比 cover 铺满（居中固定）
        backgroundSize: isPortrait ? '100% auto' : 'cover',
        backgroundPosition: isPortrait ? 'center ' + String(-offset) + 'px' : 'center center',
      }}
    />
  );
}
