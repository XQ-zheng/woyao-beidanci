import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { appRoutes, defaultRoutePath, type AppRoute } from './routes';

function PlaceholderPage({ route }: { route: AppRoute }): ReactElement {
  const headingId = `${route.path.replaceAll('/', '-')}-heading`;

  return (
    <Box component="section" aria-labelledby={headingId} sx={{ display: 'grid', gap: 1 }}>
      <Typography id={headingId} variant="h5" component="h2">
        {route.label}
      </Typography>
      <Typography variant="body1">{route.summary}</Typography>
      <Typography variant="body2" color="text.secondary">
        该页面目前是占位实现，真实内容将在后续任务中接入。
      </Typography>
    </Box>
  );
}

/**
 * 占位路由表：每个页面先给出标题与用途，保证导航与深链接可用。
 * Task 6 会用 pages/ 下的真实页面替换 PlaceholderPage。
 */
export function AppRoutes(): ReactElement {
  return (
    <Routes>
      <Route path="/" element={<Navigate to={defaultRoutePath} replace />} />
      {appRoutes.map((route) => (
        <Route key={route.path} path={route.path} element={<PlaceholderPage route={route} />} />
      ))}
      <Route path="*" element={<Navigate to={defaultRoutePath} replace />} />
    </Routes>
  );
}
