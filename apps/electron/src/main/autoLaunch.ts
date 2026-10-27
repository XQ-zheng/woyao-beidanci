/** 开机自启：只改当前用户，不申请管理员权限。 */
import { app } from 'electron';

/**
 * 设置开机自启。
 *
 * 用 `app.setLoginItemSettings`（Windows 注册表 Run 键 / macOS 登录项），
 * **不写计划任务、不申请 UAC**：普通用户装到自己的目录即可生效。
 *
 * @param enabled 是否自启。
 */
export function applyAutoStart(enabled: boolean): void {
  if (process.platform === 'linux') {
    // Linux 各发行版机制不同（systemd user unit / autostart desktop 文件），本轮不猜。
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled });
}

/**
 * 读取当前系统的自启状态（以系统为准，不信任数据库里的偏好）。
 *
 * @returns 系统是否已登记开机自启。
 */
export function isAutoStartEnabled(): boolean {
  if (process.platform === 'linux') {
    return false;
  }
  return app.getLoginItemSettings().openAtLogin;
}
