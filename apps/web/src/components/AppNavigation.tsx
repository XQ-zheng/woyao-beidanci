import BottomNavigation from '@mui/material/BottomNavigation';
import BottomNavigationAction from '@mui/material/BottomNavigationAction';
import Box from '@mui/material/Box';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import type { ReactElement } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import { activeNavPath, appRoutes, type AppRoute } from '../routes';

/**
 * 当前应高亮的导航项。
 *
 * 桌面侧栏与移动底栏共用 `activeNavPath()` 这一套匹配规则（含“流程页归属父栏目”），
 * 因此 `/study`、`/review` 期间“今日学习”在两种布局下都保持选中——不会出现一侧高亮、
 * 另一侧全灭的分叉。
 */
function useActivePath(): string {
  const { pathname } = useLocation();
  return activeNavPath(pathname);
}

/** 桌面导航项：选中态来自共用规则，而不是各自的字符串比较。 */
function DesktopNavigationItem({
  route,
  activePath,
}: {
  readonly route: AppRoute;
  readonly activePath: string;
}): ReactElement {
  const isActive = activePath === route.path;

  return (
    <ListItemButton
      component={NavLink}
      to={route.path}
      selected={isActive}
      aria-label={route.label}
      data-active={isActive ? 'true' : 'false'}
    >
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
  // hook 必须在分支之前调用：两种布局的选中态来自同一份计算结果。
  const activePath = useActivePath();

  if (variant === 'mobile') {
    return <MobileNavigation activePath={activePath} />;
  }

  return <DesktopNavigation activePath={activePath} />;
}

/** 桌面侧栏。 */
function DesktopNavigation({ activePath }: { readonly activePath: string }): ReactElement {
  return (
    <Box
      component="nav"
      aria-label="主要导航"
      sx={{ display: { xs: 'none', md: 'block' }, p: 1 }}
    >
      <List>
        {appRoutes.map((route) => (
          <DesktopNavigationItem key={route.path} route={route} activePath={activePath} />
        ))}
      </List>
    </Box>
  );
}

/** 移动底栏：fixed 底部 + safe-area-inset-bottom 内边距。 */
function MobileNavigation({ activePath }: { readonly activePath: string }): ReactElement {
  return (
    <BottomNavigation
      component="nav"
      value={activePath}
      showLabels
      aria-label="移动端导航"
      className="fixed bottom-0 left-0 right-0 border-t border-neutral-200"
      sx={{
        // 显隐必须走 MUI 的 sx：MuiBottomNavigation-root 自带未分层的 `display: flex`，
        // Tailwind 的 `.md:hidden` 在 @layer utilities 里优先级更低，盖不住它
        // （6A 交付时桌面端因此多出一条底栏，jsdom 不做媒体查询所以没暴露）。
        display: { xs: 'flex', md: 'none' },
        paddingBottom: 'env(safe-area-inset-bottom)',
        // 8 个栏目在 390px 宽的手机上放不下：默认的 minWidth: 80 会让底栏横向溢出，
        // 首尾两项被裁掉（真实浏览器截图可见）。这里改成等分 + 10px 标签，保证 8 项都在屏内。
        '& .MuiBottomNavigationAction-root': {
          minWidth: 0,
          flex: '1 1 0',
          px: 0,
        },
        '& .MuiBottomNavigationAction-label': {
          fontSize: 10,
          whiteSpace: 'nowrap',
        },
      }}
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
