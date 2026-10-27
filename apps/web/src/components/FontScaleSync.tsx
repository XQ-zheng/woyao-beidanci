import { useEffect } from 'react';

import { applyFontScale } from '../lib/fontScale';
import { useServices } from '../services/ServiceProvider';

/**
 * 启动时把已保存的字号缩放应用到根元素。
 *
 * 为什么不在设置页里做：设置页只在打开时生效，用户回到学习页字号就恢复默认了。
 * 这里挂在应用外壳上，保证“保存过的字号”在任何页面都成立；设置页只负责拖动时的即时预览。
 *
 * @returns 不渲染任何内容。
 */
export function FontScaleSync(): null {
  const services = useServices();

  useEffect(() => {
    if (services === null) {
      return;
    }
    let active = true;
    void services.settings
      .getSnapshot()
      .then((snapshot) => {
        if (active) {
          applyFontScale(snapshot.fontScale);
        }
      })
      .catch(() => {
        // 读不到设置就保持默认字号：这是显示偏好，不该阻断应用启动。
      });
    return () => {
      active = false;
    };
  }, [services]);

  return null;
}
