import { ThemeProvider } from '@mui/material/styles';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ServiceProvider } from '../services/ServiceProvider';
import { createFakeServices } from '../test/fakeServices';
import { appTheme } from '../theme';
import AccountPage from './AccountPage';

/** 用真实主题渲染账号页。 */
function renderAccount(services = createFakeServices()): void {
  render(
    <ThemeProvider theme={appTheme}>
      <ServiceProvider services={services}>
        <AccountPage />
      </ServiceProvider>
    </ThemeProvider>,
  );
}

describe('AccountPage：如实展示云服务状态', () => {
  it('未配置云时登录失败要报错，不显示假的已登录态', async () => {
    const services = createFakeServices({
      auth: {
        signIn: vi.fn(async () => {
          throw new Error('云认证未配置（WorkBuddy Cloud 未激活）');
        }),
      },
    });
    renderAccount(services);

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'me@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText(/登录失败：云认证未配置/)).toBeInTheDocument();
    expect(screen.queryByText(/已登录/)).toBeNull();
  });

  it('邮箱为空时本地拦截，不调用 signIn', () => {
    const signIn = vi.fn(async () => {
      throw new Error('不应被调用');
    });
    renderAccount(createFakeServices({ auth: { signIn } }));

    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(screen.getByText('请先填写邮箱。')).toBeInTheDocument();
    expect(signIn).not.toHaveBeenCalled();
  });

  it('同步返回 NOT_CONFIGURED 时明确说明未执行同步', async () => {
    const synchronize = vi.fn(async () => ({
      startedAt: '2026-10-27T02:00:00.000Z',
      endedAt: '2026-10-27T02:00:01.000Z',
      pushed: 0,
      duplicates: 0,
      pulled: 0,
      applied: 0,
      conflicts: 0,
      errors: 0,
      status: 'NOT_CONFIGURED' as const,
      errorMessages: [],
    }));
    renderAccount(createFakeServices({ sync: { synchronize } }));

    fireEvent.click(screen.getByRole('button', { name: '立即同步' }));

    expect(await screen.findByText('云服务未配置，本次没有执行任何同步。')).toBeInTheDocument();
    expect(synchronize).toHaveBeenCalledTimes(1);
  });

  it('同步有部分失败时展示计数与错误信息', async () => {
    const synchronize = vi.fn(async () => ({
      startedAt: '2026-10-27T02:00:00.000Z',
      endedAt: '2026-10-27T02:00:01.000Z',
      pushed: 3,
      duplicates: 1,
      pulled: 2,
      applied: 2,
      conflicts: 0,
      errors: 1,
      status: 'PARTIAL' as const,
      errorMessages: ['一条事件推送失败'],
    }));
    renderAccount(createFakeServices({ sync: { synchronize } }));

    fireEvent.click(screen.getByRole('button', { name: '立即同步' }));

    expect(await screen.findByText('同步部分完成，有失败项。')).toBeInTheDocument();
    expect(screen.getByText(/推送 3 · 重复 1 · 拉取 2/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('一条事件推送失败')).toBeInTheDocument());
  });
});
