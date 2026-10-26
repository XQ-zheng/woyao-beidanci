import { createTheme } from '@mui/material';

/**
 * 全局主题：白底黑字。
 *
 * 主色与次色都取纯黑，保证标题、按钮、导航等一律黑字白底；
 * 绿色只用于「答对」，红色只用于「答错」与真正的错误提示（界面还需配合文字或图标，
 * 不能只靠颜色表达结果）。
 */
export const appTheme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#000000',
      contrastText: '#ffffff',
    },
    secondary: {
      main: '#000000',
      contrastText: '#ffffff',
    },
    background: {
      default: '#ffffff',
      paper: '#ffffff',
    },
    text: {
      primary: '#000000',
      secondary: 'rgba(0, 0, 0, 0.72)',
    },
    divider: 'rgba(0, 0, 0, 0.12)',
    success: {
      main: '#2e7d32',
      contrastText: '#ffffff',
    },
    error: {
      main: '#c62828',
      contrastText: '#ffffff',
    },
  },
  shape: {
    borderRadius: 8,
  },
  typography: {
    fontFamily: [
      '-apple-system',
      'BlinkMacSystemFont',
      '"Segoe UI"',
      '"PingFang SC"',
      '"Microsoft YaHei"',
      '"Noto Sans SC"',
      'sans-serif',
    ].join(','),
    h1: { fontWeight: 700 },
    h2: { fontWeight: 700 },
    h3: { fontWeight: 700 },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: '#ffffff',
          color: '#000000',
        },
      },
    },
    MuiAppBar: {
      defaultProps: {
        color: 'inherit',
        elevation: 0,
      },
    },
  },
});
