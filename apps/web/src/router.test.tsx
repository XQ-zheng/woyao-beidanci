import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AppRoutes } from './router';
import { ServiceProvider } from './services/ServiceProvider';
import { createFakeServices } from './test/fakeServices';

/**
 * 6B 起 `/today`、`/study` 已经接入真实服务，不能再拿空对象当假服务
 * （空对象会在页面加载时抛错，掩盖“路由是否真的接上了”这一断言目标）。
 */
const fakeServices = createFakeServices();

/** 懒加载页在首次运行时需要额外时间做模块转换，给足 5s 上限。 */
const FIND_OPTIONS = { timeout: 5000 } as const;

/** 渲染指定路径（带假服务 + 内存路由）。 */
function renderRoute(path: string): void {
  render(
    <ServiceProvider services={fakeServices}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </ServiceProvider>,
  );
}

describe('路由冒烟（薄壳页）', () => {
  it.each([
    ['/settings', '设置'],
    ['/assessment', '水平评估'],
    ['/library', '词库'],
    ['/history', '历史'],
  ])('%s 渲染 h2 标题「%s」', async (path, title) => {
    renderRoute(path);
    expect(await screen.findByRole('heading', { level: 2, name: title }, FIND_OPTIONS)).toBeInTheDocument();
  });
});

describe('路由接线（6B 学习流程）', () => {
  it('/today 渲染真实的今日计划，而不是 6A 占位文案', async () => {
    renderRoute('/today');

    expect(await screen.findByText('新词上限 20 个 · 复习上限 100 个', {}, FIND_OPTIONS)).toBeInTheDocument();
    expect(screen.queryByText('内容在 6B/6C 接入。')).toBeNull();
  });

  it('/study 已接入路由（无会话时给出返回提示，不白屏）', async () => {
    renderRoute('/study');

    expect(await screen.findByRole('heading', { level: 2, name: '学习' }, FIND_OPTIONS)).toBeInTheDocument();
    // 标题在加载态就已渲染，正文要等“没有 deckId”的分支落定，所以同样用 find* 等待。
    expect(
      await screen.findByText(/今天已经背诵完毕/, {}, FIND_OPTIONS),
    ).toBeInTheDocument();
  });

  it('/review 已接入路由', async () => {
    renderRoute('/review');

    expect(await screen.findByRole('heading', { level: 2, name: '学习完成' }, FIND_OPTIONS)).toBeInTheDocument();
    expect(
      await screen.findByText('没有可展示的学习记录，请返回今日学习。', {}, FIND_OPTIONS),
    ).toBeInTheDocument();
  });

  it('未匹配路径回落到默认落地页', async () => {
    renderRoute('/does-not-exist');

    expect(await screen.findByRole('heading', { level: 2, name: '今日学习' }, FIND_OPTIONS)).toBeInTheDocument();
  });
});
