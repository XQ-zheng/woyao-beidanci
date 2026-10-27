import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { ReactElement, ReactNode } from 'react';

import { useServices } from '../services/ServiceProvider';
import { ServiceUnavailable } from '../components/ServiceUnavailable';

/** 页面薄壳入参。 */
export interface PageShellProps {
  /** 页面标题（也是 `h2` 的文本）。 */
  readonly title: string;
  /** `aria-labelledby` 引用的标题 id（每个页面唯一，用于无障碍关联）。 */
  readonly headingId: string;
  /**
   * 页面正文。
   *
   * 只有服务已接入时才渲染：`services === null` 时**无论是否传 children** 都只显示
   * “数据服务未接入”空态。把这条规则收在薄壳里，避免每个页面各写一遍 null 分支时
   * 出现“某个页面在无服务时仍渲染了半截真实内容”的分叉。
   */
  readonly children?: ReactNode;
}

/**
 * 6A 的统一薄壳：读 `useServices()`，`null` 显示“数据服务未接入”空态，
 * 否则渲染标题与页面正文（未传正文时保持 6A 的占位文案）。
 */
export function PageShell({ title, headingId, children }: PageShellProps): ReactElement {
  const services = useServices();

  return (
    <Box component="section" aria-labelledby={headingId} sx={{ display: 'grid', gap: 2 }}>
      <Typography id={headingId} variant="h5" component="h2">
        {title}
      </Typography>
      {services === null ? (
        <ServiceUnavailable />
      ) : (
        (children ?? <Typography variant="body1">内容在 6B/6C 接入。</Typography>)
      )}
    </Box>
  );
}
