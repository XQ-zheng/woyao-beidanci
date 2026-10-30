import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CssBaseline from '@mui/material/CssBaseline';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { ThemeProvider } from '@mui/material/styles';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { BrowserRouter, useLocation } from 'react-router-dom';
import type { Services } from '@woyao/services';

import { APP_NAME } from './bootstrap';
import { AppNavigation } from './components/AppNavigation';
import { AppearanceSync } from './components/AppearanceSync';
import { FontScaleSync } from './components/FontScaleSync';
import { AppRoutes } from './router';
import { ServiceProvider } from './services/ServiceProvider';
import { appTheme } from './theme';

/**
 * 学习作答期间隐藏左侧导航（用户要求：单词独占全屏，避免分心），
 * 右上角保留「☰」按钮随时打开抽屉查看导航。
 */
function isImmersiveRoute(pathname: string): boolean {
  return pathname === '/study';
}

/** 应用外壳：桌面为左侧栏 + 主内容区，移动为顶栏 + 固定底栏。 */
function AppShell(): ReactElement {
  const location = useLocation();
  const immersive = isImmersiveRoute(location.pathname);
  const [navOpen, setNavOpen] = useState(false);

  if (immersive) {
    return (
      <div className="flex min-h-screen flex-col">
        <Button
          aria-label="查看导航"
          onClick={() => setNavOpen(true)}
          variant="contained"
          sx={{ position: 'fixed', top: 12, right: 16, zIndex: (theme) => theme.zIndex.appBar, minWidth: 48, px: 1.5, fontSize: 20 }}
        >
          ☰
        </Button>
        <Drawer open={navOpen} onClose={() => setNavOpen(false)}>
          <Box sx={{ width: 240 }} role="presentation" onClick={() => setNavOpen(false)}>
            <Typography variant="h6" sx={{ px: 2, py: 2 }}>
              {APP_NAME}
            </Typography>
            <Divider />
            <AppNavigation variant="desktop" />
          </Box>
        </Drawer>
        <main className="flex-1">
          <AppRoutes />
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <header className="shrink-0 md:w-60">
        <AppBar position="static">
          <Toolbar>
            <Typography variant="h6" component="h1">
              {APP_NAME}
            </Typography>
          </Toolbar>
        </AppBar>
        <AppNavigation variant="desktop" />
      </header>
      <Divider orientation="vertical" flexItem className="hidden md:block" />
      <main className="flex-1 p-6 pb-24 md:pb-6">
        <AppRoutes />
      </main>
      <AppNavigation variant="mobile" />
    </div>
  );
}

/** 应用入口入参。 */
export interface AppProps {
  /** 数据服务；缺省 `null`（浏览器 dev 预览阶段未接入，页面显示空态）。 */
  readonly services?: Services | null;
}

export function App({ services }: AppProps): ReactElement {
  return (
    <ThemeProvider theme={appTheme}>
      <CssBaseline />
      <ServiceProvider services={services ?? null}>
        <FontScaleSync />
        <AppearanceSync />
        <BrowserRouter>
          <AppShell />
        </BrowserRouter>
      </ServiceProvider>
    </ThemeProvider>
  );
}
