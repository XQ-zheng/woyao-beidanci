import { useEffect } from 'react';

import { applyFontFamily } from '../lib/appearance';
import { useServices } from '../services/ServiceProvider';

/**
 * 启动时把已保存的壁纸与字体应用到根元素。
 *
 * 字体：`fontFamily` 为内置 key 或导入字体的 FontFace family。
 *
 * 与 FontScaleSync 同理，挂在应用外壳上，保证任何页面都生效，而不是只在设置页。
 * 设置页保存时会立即调用同一组函数（不做二次读取），避免「改了看不到变化」。
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
