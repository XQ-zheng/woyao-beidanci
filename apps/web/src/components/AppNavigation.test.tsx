import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { appRoutes } from '../routes';
import { AppNavigation } from './AppNavigation';

describe('AppNavigation：桌面侧栏', () => {
  it('渲染 8 个导航项，顺序与路由清单一致', () => {
    render(
      <MemoryRouter initialEntries={['/today']}>
        <AppNavigation variant="desktop" />
      </MemoryRouter>,
    );

    const nav = screen.getByRole('navigation', { name: '主要导航' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toStrictEqual(appRoutes.map((route) => route.label));
  });

  it('当前路由对应项选中，其余不选中', () => {
    render(
      <MemoryRouter initialEntries={['/today']}>
        <AppNavigation variant="desktop" />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: '今日学习' })).toHaveClass('Mui-selected');
    expect(screen.getByRole('link', { name: '词库' })).not.toHaveClass('Mui-selected');
  });
});

describe('AppNavigation：移动底栏', () => {
  it('渲染底部导航（aria-label=移动端导航），含 8 项', () => {
    render(
      <MemoryRouter initialEntries={['/today']}>
        <AppNavigation variant="mobile" />
      </MemoryRouter>,
    );

    const bottomNav = screen.getByLabelText('移动端导航');
    const links = within(bottomNav).getAllByRole('link');
    expect(links).toHaveLength(8);
    // 每项都有中文 aria-label。
    for (const route of appRoutes) {
      expect(within(bottomNav).getByRole('link', { name: route.label })).toBeInTheDocument();
    }
  });

  it('当前项在底栏也是选中态', () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <AppNavigation variant="mobile" />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: '设置' })).toHaveClass('Mui-selected');
    expect(screen.getByRole('link', { name: '今日学习' })).not.toHaveClass('Mui-selected');
  });
});

describe('AppNavigation：学习流程页归属（6A 复审 M1 的锁定用例）', () => {
  // 6B 的 /study、/review 不进主导航，但属于“今日学习”这条主线：
  // 桌面侧栏与移动底栏必须给出**同一套**选中态，不能一侧高亮、另一侧全灭。
  it.each(['/study', '/review', '/today/sub'])('%s 时桌面侧栏仍高亮“今日学习”', (pathname) => {
    render(
      <MemoryRouter initialEntries={[pathname]}>
        <AppNavigation variant="desktop" />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: '今日学习' })).toHaveClass('Mui-selected');
    // 流程页自身不占导航项。
    expect(screen.queryByRole('link', { name: '学习' })).toBeNull();
  });

  it.each(['/study', '/review', '/today/sub'])('%s 时移动底栏仍高亮“今日学习”', (pathname) => {
    render(
      <MemoryRouter initialEntries={[pathname]}>
        <AppNavigation variant="mobile" />
      </MemoryRouter>,
    );

    const bottomNav = screen.getByLabelText('移动端导航');
    expect(within(bottomNav).getAllByRole('link')).toHaveLength(appRoutes.length);
    expect(within(bottomNav).getByRole('link', { name: '今日学习' })).toHaveClass('Mui-selected');
  });

  it('非学习流程的普通页面不会误高亮“今日学习”', () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <AppNavigation variant="desktop" />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: '今日学习' })).not.toHaveClass('Mui-selected');
    expect(screen.getByRole('link', { name: '设置' })).toHaveClass('Mui-selected');
  });
});
