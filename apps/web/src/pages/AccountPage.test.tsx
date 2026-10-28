import { ThemeProvider } from '@mui/material/styles';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@woyao/services';

import { ServiceProvider } from '../services/ServiceProvider';
import { createFakeServices } from '../test/fakeServices';
import { appTheme } from '../theme';
import AccountPage from './AccountPage';

const SESSION: AuthSession = {
  userId: 'u-1',
  token: 'secret-token',
  refreshToken: 'secret-refresh',
  expiresAt: null,
};

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

describe('AccountPage：手机验证码登录', () => {
  it('未登录时显示手机号与验证码输入，不显示任何 token', async () => {
    renderAccount();

    expect(await screen.findByRole('tab', { name: '手机验证码' })).toBeInTheDocument();
    expect(screen.getByLabelText('手机号')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '获取验证码' })).toBeInTheDocument();
    expect(screen.queryByText('secret-token')).toBeNull();
  });

  it('手机号为空时本地拦截，不发码', async () => {
    const requestOtp = vi.fn();
    renderAccount(createFakeServices({ auth: { requestOtp } }));

    fireEvent.click(await screen.findByRole('button', { name: '获取验证码' }));

    expect(await screen.findByText('请先填写手机号。')).toBeInTheDocument();
    expect(requestOtp).not.toHaveBeenCalled();
  });

  it('手机号格式不对时本地拦截', async () => {
    const requestOtp = vi.fn();
    renderAccount(createFakeServices({ auth: { requestOtp } }));

    fireEvent.change(screen.getByLabelText('手机号'), { target: { value: '12345' } });
    fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));

    expect(await screen.findByText('请输入正确的 11 位手机号。')).toBeInTheDocument();
    expect(requestOtp).not.toHaveBeenCalled();
  });

  it('发码 → 验码 → 显示已登录，并把 challenge 原样带回', async () => {
    const requestOtp = vi.fn(async () => ({ challengeId: 'ch-1', isExistingUser: true }));
    const verifyOtp = vi.fn(async () => SESSION);
    renderAccount(createFakeServices({ auth: { requestOtp, verifyOtp } }));

    fireEvent.change(await screen.findByLabelText('手机号'), { target: { value: '13800138000' } });
    fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));

    expect(await screen.findByText(/验证码已发送/)).toBeInTheDocument();
    expect(requestOtp).toHaveBeenCalledWith({ channel: 'phone', target: '13800138000' });

    fireEvent.change(screen.getByLabelText('验证码'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: '登录 / 注册' }));

    expect(await screen.findByText('账号已登录。token 不会显示在界面上，也不会写进日志。')).toBeInTheDocument();
    expect(verifyOtp).toHaveBeenCalledWith({
      channel: 'phone',
      target: '13800138000',
      challengeId: 'ch-1',
      isExistingUser: true,
      token: '123456',
    });
    expect(screen.queryByText('secret-token')).toBeNull();
  });

  it('未获取验证码就提交时本地拦截', async () => {
    const verifyOtp = vi.fn();
    renderAccount(createFakeServices({ auth: { verifyOtp } }));

    fireEvent.change(await screen.findByLabelText('手机号'), { target: { value: '13800138000' } });
    fireEvent.click(screen.getByRole('button', { name: '登录 / 注册' }));

    expect(await screen.findByText('请先为当前手机号/邮箱获取验证码。')).toBeInTheDocument();
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('发码失败时展示服务返回的错误', async () => {
    const requestOtp = vi.fn(async () => {
      throw new Error('短信额度不足');
    });
    renderAccount(createFakeServices({ auth: { requestOtp } }));

    fireEvent.change(await screen.findByLabelText('手机号'), { target: { value: '13800138000' } });
    fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));

    expect(await screen.findByText(/发送验证码失败：短信额度不足/)).toBeInTheDocument();
  });
});

describe('AccountPage：邮箱辅助登录', () => {
  it('切到邮箱页签后用 email 渠道发码', async () => {
    const requestOtp = vi.fn(async () => ({ challengeId: 'ch-e', isExistingUser: false }));
    renderAccount(createFakeServices({ auth: { requestOtp } }));

    fireEvent.click(await screen.findByRole('tab', { name: '邮箱验证码（辅助）' }));
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'me@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));

    await waitFor(() =>
      expect(requestOtp).toHaveBeenCalledWith({ channel: 'email', target: 'me@example.com' }),
    );
  });
});

describe('AccountPage：已登录与退出', () => {
  it('已有会话时显示已登录，退出后回到登录表单', async () => {
    const signOut = vi.fn(async () => undefined);
    const getSession = vi.fn(async () => SESSION);
    renderAccount(createFakeServices({ auth: { getSession, signOut } }));

    expect(await screen.findByText(/账号已登录/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));

    await waitFor(() => expect(signOut).toHaveBeenCalledWith(SESSION));
    expect(await screen.findByRole('tab', { name: '手机验证码' })).toBeInTheDocument();
  });
});

describe('AccountPage：同步状态', () => {
  it('同步返回 NOT_CONFIGURED 时明确说明未执行同步', async () => {
    const synchronize = vi.fn(async () => ({
      startedAt: '2026-10-28T02:00:00.000Z',
      endedAt: '2026-10-28T02:00:01.000Z',
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

    fireEvent.click(await screen.findByRole('button', { name: '立即同步' }));

    expect(await screen.findByText('云同步尚未接入，本次没有执行任何同步。')).toBeInTheDocument();
    expect(synchronize).toHaveBeenCalledTimes(1);
  });
});
