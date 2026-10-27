import Typography from '@mui/material/Typography';
import type { ReactElement } from 'react';

/**
 * 数据服务未接入的统一空态。
 *
 * 页面薄壳在 `useServices()` 返回 `null` 时渲染它；真正接入发生在 Task 7（Electron IPC 桥）。
 */
export function ServiceUnavailable(): ReactElement {
  return <Typography variant="body1">数据服务未接入</Typography>;
}
