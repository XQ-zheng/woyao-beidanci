import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Services } from '@woyao/services';

import { AppRoutes } from './router';
import { ServiceProvider } from './services/ServiceProvider';

/** 6A 薄壳页只判断 services 是否为 null，不调用具体方法，空对象即可当假服务。 */
const fakeServices = {} as unknown as Services;

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
    ['/today', '今日学习'],
    ['/settings', '设置'],
    ['/assessment', '水平评估'],
    ['/library', '词库'],
    ['/history', '历史'],
  ])('%s 渲染 h2 标题「%s」', async (path, title) => {
    renderRoute(path);
    expect(await screen.findByRole('heading', { level: 2, name: title })).toBeInTheDocument();
  });

  it('未匹配路径回落到默认落地页', async () => {
    renderRoute('/does-not-exist');
    expect(await screen.findByRole('heading', { level: 2, name: '今日学习' })).toBeInTheDocument();
  });
});
