import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import CssBaseline from '@mui/material/CssBaseline';
import Divider from '@mui/material/Divider';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { ThemeProvider } from '@mui/material/styles';
import type { ReactElement } from 'react';
import { BrowserRouter, NavLink, useLocation } from 'react-router-dom';

import { APP_NAME } from './bootstrap';
import { AppRoutes } from './router';
import { appRoutes } from './routes';
import { appTheme } from './theme';

function AppNavigation(): ReactElement {
  const { pathname } = useLocation();

  return (
    <Box component="nav" aria-label="主要导航" className="p-2">
      <List>
        {appRoutes.map((route) => (
          <ListItemButton
            key={route.path}
            component={NavLink}
            to={route.path}
            selected={pathname === route.path}
          >
            <ListItemText primary={route.label} />
          </ListItemButton>
        ))}
      </List>
    </Box>
  );
}

/**
 * 应用外壳：桌面为左侧栏，窄屏自动堆叠为顶部导航。
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
        <AppNavigation />
      </header>
      <Divider orientation="vertical" flexItem className="hidden md:block" />
      <main className="flex-1 p-6">
        <AppRoutes />
      </main>
    </div>
  );
}

export function App(): ReactElement {
  return (
    <ThemeProvider theme={appTheme}>
      <CssBaseline />
      <BrowserRouter>
        <AppShell />
      </BrowserRouter>
    </ThemeProvider>
  );
}
