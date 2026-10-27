import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { App } from './App';
import { appRoutes } from './routes';

describe('应用外壳', () => {
  it('渲染应用名称，默认落在今日学习页并显示数据服务未接入空态', async () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: '我要背单词' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 2, name: '今日学习' })).toBeInTheDocument();
    expect(screen.getByText('数据服务未接入')).toBeInTheDocument();
  });

  it('桌面侧栏提供 8 个导航入口，顺序与路由清单一致', () => {
    render(<App />);

    const nav = screen.getByRole('navigation', { name: '主要导航' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toStrictEqual(appRoutes.map((route) => route.label));
  });

  it('当前路由对应的桌面导航项处于选中态', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 2, name: '今日学习' });

    const nav = screen.getByRole('navigation', { name: '主要导航' });
    expect(within(nav).getByRole('link', { name: '今日学习' })).toHaveClass('Mui-selected');
    expect(within(nav).getByRole('link', { name: '词库' })).not.toHaveClass('Mui-selected');
  });
});
