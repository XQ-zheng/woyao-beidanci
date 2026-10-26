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
});
