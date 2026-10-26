import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { App } from './App';
import { appRoutes } from './routes';

describe('应用外壳', () => {
  it('渲染应用名称并默认落在今日学习页', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: '我要背单词' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '今日学习' })).toBeInTheDocument();
  });

  it('为八个占位路由提供导航入口', () => {
    render(<App />);

    for (const route of appRoutes) {
      expect(screen.getByRole('link', { name: route.label })).toBeInTheDocument();
    }
  });

  it('导航顺序与设计规格的侧栏顺序一致', () => {
    render(<App />);

    const labels = screen.getAllByRole('link').map((link) => link.textContent);
    expect(labels).toStrictEqual([
      '今日学习',
      '词库',
      '单词本',
      '错词',
      '历史',
      '水平评估',
      '账号',
      '设置',
    ]);
  });

  it('当前路由对应的导航项处于选中态', () => {
    render(<App />);

    expect(screen.getByRole('link', { name: '今日学习' })).toHaveClass('Mui-selected');
    expect(screen.getByRole('link', { name: '词库' })).not.toHaveClass('Mui-selected');
  });
});
