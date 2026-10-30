import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Services } from '@woyao/services';

import { ServiceProvider } from '../services/ServiceProvider';
import { createFakeServices, makeDailyRow, makeDeck, makeSession, makeSummary } from '../test/fakeServices';
import TodayPage from './TodayPage';

/** 固定时钟：本地日必须是 2026-10-27（Asia/Shanghai），不随跑测试的机器变化。 */
const fixedNow = (): Date => new Date('2026-10-27T10:00:00+08:00');

/** 挂进最小路由表，用于验证“开始学习”和“去词库页”的跳转。 */
function renderToday(services: Services | null): void {
  render(
    <ServiceProvider services={services}>
      <MemoryRouter initialEntries={['/today']}>
        <Routes>
          <Route path="/today" element={<TodayPage now={fixedNow} />} />
          <Route path="/study" element={<div>学习页占位</div>} />
          <Route path="/library" element={<div>词库页占位</div>} />
        </Routes>
      </MemoryRouter>
    </ServiceProvider>,
  );
}

describe('TodayPage：今日概览', () => {
  it('展示每日计划、今日已作答与词库选择', async () => {
    const services = createFakeServices({
      report: {
        getDailyHistory: vi.fn(async () => [
          makeDailyRow({ total: 10, correct: 8, wrong: 2, accuracy: 0.8 }),
        ]),
      },
    });
    renderToday(services);

    expect(await screen.findByText('2026-10-27')).toBeInTheDocument();
    expect(screen.getByText('新词上限 20 个 · 复习上限 100 个')).toBeInTheDocument();
    expect(screen.getByText('已作答 10 次 · 正确率 80%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始背新词' })).toBeInTheDocument();
  });

  it('今日没有任何作答时只显示已作答 0 次，不编造正确率', async () => {
    const services = createFakeServices({ report: { getDailyHistory: vi.fn(async () => []) } });
    renderToday(services);

    expect(await screen.findByText('已作答 0 次')).toBeInTheDocument();
    expect(screen.queryByText(/正确率/)).toBeNull();
  });

  it('按设置里的时区取本地日，并把该日作为统计区间', async () => {
    const getDailyHistory = vi.fn(async () => []);
    renderToday(createFakeServices({ report: { getDailyHistory } }));

    await screen.findByText('已作答 0 次');
    expect(getDailyHistory).toHaveBeenCalledWith({
      fromLocalDate: '2026-10-27',
      toLocalDate: '2026-10-27',
    });
  });
});

describe('TodayPage：进入学习', () => {
  it('点“开始学习”用当前词库开会话并跳到 /study', async () => {
    const startSession = vi.fn(async () => makeSession());
    const services = createFakeServices({ study: { startSession } });
    renderToday(services);

    fireEvent.click(await screen.findByRole('button', { name: '开始背新词' }));

    await waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ deckId: 'deck-cet4' }));
    expect(await screen.findByText('学习页占位')).toBeInTheDocument();
  });

  it('今天没有待学卡片时弹出「重新开始」确认框，并把空会话结束掉', async () => {
    const finishSession = vi.fn(async () => makeSummary());
    const services = createFakeServices({
      study: { startSession: vi.fn(async () => makeSession([])), finishSession },
    });
    renderToday(services);

    fireEvent.click(await screen.findByRole('button', { name: '开始背新词' }));

    // 点「开始背新词」但新词早已学完 → 引导去复习（而不是笼统的「今天已背完」）。
    expect(await screen.findByText(/此单词本中的单词您之前已经背诵完成/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始复习' })).toBeInTheDocument();
    await waitFor(() => expect(finishSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's-1' })));
  });

  it('没有词库时引导去词库页', async () => {
    const services = createFakeServices({ library: { listDecks: vi.fn(async () => []) } });
    renderToday(services);

    expect(await screen.findByText(/还没有可用词库/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '去词库页' }));
    expect(await screen.findByText('词库页占位')).toBeInTheDocument();
  });

  it('词库列表有多条时默认选第一条', async () => {
    const services = createFakeServices({
      library: {
        listDecks: vi.fn(async () => [
          makeDeck(),
          makeDeck({ deckId: 'deck-cet6', name: '六级核心词', wordCount: 800 }),
        ]),
      },
    });
    renderToday(services);

    expect(await screen.findByRole('combobox', { name: '学习词库' })).toHaveTextContent('四级核心词');
  });
});

describe('TodayPage：空态', () => {
  it('services 为 null 时显示“数据服务未接入”', () => {
    renderToday(null);

    expect(screen.getByText('数据服务未接入')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开始背新词' })).toBeNull();
  });
});
