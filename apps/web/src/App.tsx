import AppBar from '@mui/material/AppBar';
import CssBaseline from '@mui/material/CssBaseline';
import Divider from '@mui/material/Divider';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { ThemeProvider } from '@mui/material/styles';
import type { ReactElement } from 'react';
import { BrowserRouter } from 'react-router-dom';
import type { Services } from '@woyao/services';

import { APP_NAME } from './bootstrap';
import { AppNavigation } from './components/AppNavigation';
import { FontScaleSync } from './components/FontScaleSync';
import { AppRoutes } from './router';
import { ServiceProvider } from './services/ServiceProvider';
import { appTheme } from './theme';

/**
 * 应用外壳：桌面为左侧栏 + 主内容区，移动为顶栏 + 固定底栏。
 * 布局用 Tailwind 工具类，视觉样式全部来自 MUI 主题。
 */
function AppShell(): ReactElement {
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
        <BrowserRouter>
          <AppShell />
        </BrowserRouter>
      </ServiceProvider>
    </ThemeProvider>
  );
}
