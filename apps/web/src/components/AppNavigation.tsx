import BottomNavigation from '@mui/material/BottomNavigation';
import BottomNavigationAction from '@mui/material/BottomNavigationAction';
import Box from '@mui/material/Box';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import type { ReactElement } from 'react';
import { NavLink, useLocation, useMatch } from 'react-router-dom';

import { appRoutes, defaultRoutePath, type AppRoute } from '../routes';

/**
 * 桌面导航项：用 router 自身的匹配结果判断选中（`end: false` 允许匹配子路由），
 * 而不是比较 pathname 字符串——后续出现 /today/xxx 这类子路由时，父级导航项依然高亮。
 */
function DesktopNavigationItem({ route }: { readonly route: AppRoute }): ReactElement {
  const isActive = useMatch({ path: route.path, end: false }) !== null;

  return (
    <ListItemButton component={NavLink} to={route.path} selected={isActive} aria-label={route.label}>
      <ListItemText primary={route.label} />
    </ListItemButton>
  );
}

/** 移动端底部导航的占位图标（6B/6C 换成真实图标，本轮不引入额外图标依赖）。 */
function NavGlyph(): ReactElement {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="6" fill="currentColor" />
    </svg>
  );
}

/**
 * 应用导航：`desktop` 渲染左侧栏列表，`mobile` 渲染固定底栏。
 * 显隐由 App.tsx 用 Tailwind（`hidden md:block` / `md:hidden`）控制，
 * 视觉样式来自 MUI 主题（黑白）。
 */
export function AppNavigation({ variant }: { readonly variant: 'desktop' | 'mobile' }): ReactElement {
  if (variant === 'mobile') {
    return <MobileNavigation />;
  }

  return (
    <Box component="nav" aria-label="主要导航" className="hidden p-2 md:block">
      <List>
        {appRoutes.map((route) => (
          <DesktopNavigationItem key={route.path} route={route} />
        ))}
      </List>
    </Box>
  );
}

/** 移动底栏：fixed 底部 + safe-area-inset-bottom 内边距。 */
function MobileNavigation(): ReactElement {
  const location = useLocation();
  // 底部导航的选中值由当前路径推导（路由扁平，取最长匹配前缀；6B 引入子路由时再细化）。
  const activePath =
    appRoutes.find(
      (route) => location.pathname === route.path || location.pathname.startsWith(`${route.path}/`),
    )?.path ?? defaultRoutePath;

  return (
    <BottomNavigation
      value={activePath}
      showLabels
      aria-label="移动端导航"
      className="fixed bottom-0 left-0 right-0 border-t border-neutral-200 md:hidden"
      sx={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {appRoutes.map((route) => (
        <BottomNavigationAction
          key={route.path}
          component={NavLink}
          to={route.path}
          label={route.label}
          value={route.path}
          icon={<NavGlyph />}
          aria-label={route.label}
        />
      ))}
    </BottomNavigation>
  );
}
