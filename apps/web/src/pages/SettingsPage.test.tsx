import { ThemeProvider } from '@mui/material/styles';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ServiceProvider } from '../services/ServiceProvider';
import { createFakeServices, defaultSettings } from '../test/fakeServices';
import { appTheme } from '../theme';
import SettingsPage from './SettingsPage';

/** 用真实主题渲染设置页。 */
function renderSettings(services = createFakeServices()): void {
  render(
    <ThemeProvider theme={appTheme}>
      <ServiceProvider services={services}>
        <SettingsPage />
      </ServiceProvider>
    </ThemeProvider>,
  );
}

describe('SettingsPage：加载真实快照', () => {
  it('展示每日上限、复习节点、训练模式与桌面开关', async () => {
    renderSettings();

    expect(await screen.findByLabelText('每日新词上限')).toHaveValue(20);
    expect(screen.getByLabelText('每日复习上限')).toHaveValue(100);
    expect(screen.getByLabelText('复习节点（天，逗号分隔）')).toHaveValue('1,2,4,7,15,30');
    expect(screen.getByLabelText('训练模式')).toHaveTextContent('双向混合');
    expect(screen.getByLabelText('题型')).toHaveTextContent('选择题');
    expect(screen.getByLabelText('开机自启')).not.toBeChecked();
    expect(screen.getByLabelText('关闭窗口时最小化到托盘')).not.toBeChecked();
  });

  it('没有学习时段时给出空态说明，不编造时段', async () => {
    renderSettings();

    expect(await screen.findByText(/还没有设置学习时段/)).toBeInTheDocument();
  });
});

describe('SettingsPage：保存', () => {
  it('修改上限后保存，调用 update 与 saveReviewPlan', async () => {
    const update = vi.fn(async (patch) => ({ ...defaultSettings, ...patch }));
    const saveReviewPlan = vi.fn(async (plan) => plan);
    const services = createFakeServices({ settings: { update, saveReviewPlan } });
    renderSettings(services);

    const input = await screen.findByLabelText('每日新词上限');
    fireEvent.change(input, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ dailyNewLimit: 30, dailyReviewLimit: 100, trainingMode: 'MIXED' }),
    );
    expect(saveReviewPlan).toHaveBeenCalledWith(
      expect.objectContaining({ intervalsDays: [1, 2, 4, 7, 15, 30], dailyNewLimit: 30 }),
    );
    expect(await screen.findByText('已保存。')).toBeInTheDocument();
  });

  it('复习节点非递增时本地拦截，不发任何请求', async () => {
    const update = vi.fn(async (patch) => ({ ...defaultSettings, ...patch }));
    const services = createFakeServices({ settings: { update } });
    renderSettings(services);

    const intervals = await screen.findByLabelText('复习节点（天，逗号分隔）');
    fireEvent.change(intervals, { target: { value: '4,2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    expect(await screen.findByText(/复习节点必须严格递增/)).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it('复习节点超出范围时本地拦截', async () => {
    const update = vi.fn(async (patch) => ({ ...defaultSettings, ...patch }));
    renderSettings(createFakeServices({ settings: { update } }));

    fireEvent.change(await screen.findByLabelText('复习节点（天，逗号分隔）'), {
      target: { value: '1,400' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    expect(await screen.findByText(/必须在 1–365 天之间/)).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it('保存失败时展示服务返回的错误，而不是假装成功', async () => {
    const services = createFakeServices({
      settings: {
        update: vi.fn(async () => {
          throw new Error('数据库只读');
        }),
      },
    });
    renderSettings(services);

    await screen.findByLabelText('每日新词上限');
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    expect(await screen.findByText(/保存失败：数据库只读/)).toBeInTheDocument();
    expect(screen.queryByText('已保存。')).toBeNull();
  });
});
