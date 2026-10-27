import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { ReactElement } from 'react';

import { useServices } from '../services/ServiceProvider';
import { ServiceUnavailable } from '../components/ServiceUnavailable';

/** 页面薄壳入参。 */
export interface PageShellProps {
  /** 页面标题（也是 `h2` 的文本）。 */
  readonly title: string;
  /** `aria-labelledby` 引用的标题 id（每个页面唯一，用于无障碍关联）。 */
  readonly headingId: string;
}

/**
 * 6A 的统一薄壳：读 `useServices()`，`null` 显示“数据服务未接入”空态，
 * 否则显示标题 + “内容在 6B/6C 接入”。具体交互由 6B/6C 替换本组件。
 */
export function PageShell({ title, headingId }: PageShellProps): ReactElement {
  const services = useServices();

  return (
    <Box component="section" aria-labelledby={headingId} sx={{ display: 'grid', gap: 1 }}>
      <Typography id={headingId} variant="h5" component="h2">
        {title}
      </Typography>
      {services === null ? (
        <ServiceUnavailable />
      ) : (
        <Typography variant="body1">内容在 6B/6C 接入。</Typography>
      )}
    </Box>
  );
}
