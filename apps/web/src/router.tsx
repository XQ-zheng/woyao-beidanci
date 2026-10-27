import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import { lazy, Suspense, type ComponentType, type ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { appRoutes, defaultRoutePath } from './routes';

/** 每个路由路径对应的真实页面（懒加载）。Study/Review 页留给 6B 学习流程，暂不进主导航。 */
const routePages: Readonly<Record<string, ComponentType>> = {
  '/today': lazy(() => import('./pages/TodayPage')),
  '/library': lazy(() => import('./pages/LibraryPage')),
  '/notebook': lazy(() => import('./pages/NotebookPage')),
  '/mistakes': lazy(() => import('./pages/MistakesPage')),
  '/history': lazy(() => import('./pages/HistoryPage')),
  '/assessment': lazy(() => import('./pages/AssessmentPage')),
  '/account': lazy(() => import('./pages/AccountPage')),
  '/settings': lazy(() => import('./pages/SettingsPage')),
};

/** 懒加载 fallback：不白屏，给一个居中的加载指示。 */
function RouteFallback(): ReactElement {
  return (
    <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '10rem' }}>
      <CircularProgress aria-label="页面加载中" />
    </Box>
  );
}

/**
 * 路由表：`/` 重定向到默认落地页，`appRoutes` 映射到 pages/ 下的真实页面（懒加载），
 * 未匹配路径也回落到默认页。
 */
export function AppRoutes(): ReactElement {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/" element={<Navigate to={defaultRoutePath} replace />} />
        {appRoutes.map((route) => {
          const Page = routePages[route.path];
          // 路由清单与页面映射必须一一对应；对不上的路径说明接线漏了，直接抛出而非渲染空壳。
          if (Page === undefined) {
            throw new Error(`路由 ${route.path} 缺少对应页面组件`);
          }
          return <Route key={route.path} path={route.path} element={<Page />} />;
        })}
        <Route path="*" element={<Navigate to={defaultRoutePath} replace />} />
      </Routes>
    </Suspense>
  );
}
