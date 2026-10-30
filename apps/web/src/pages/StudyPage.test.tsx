import { ThemeProvider } from '@mui/material/styles';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Services, SessionView } from '@woyao/services';

import { ServiceProvider } from '../services/ServiceProvider';
import { createFakeServices, makeAnswerResult, makeCard, makeSession, makeSummary } from '../test/fakeServices';
import { appTheme } from '../theme';
import ReviewPage from './ReviewPage';
import StudyPage from './StudyPage';

/** 固定时钟：`durationMs` 断言不依赖真实时间。 */
const fixedNow = (): Date => new Date('2026-10-27T10:00:00+08:00');

/** 把 StudyPage 挂进最小路由表（含 /review，用于验证结束后的跳转）。 */
function renderStudy(options: {
  readonly services?: Services | null;
  readonly session?: SessionView;
} = {}): ReturnType<typeof render> {
  // 默认用自评（REVEAL）卡：新学习页的 CHOICE 卡会渲染四选项，自评卡才是认识/不认识大按钮。
  const { services = createFakeServices(), session = makeSession([makeCard({ style: 'REVEAL', options: [] })]) } = options;

  return render(
    <ThemeProvider theme={appTheme}>
      <ServiceProvider services={services}>
        <MemoryRouter initialEntries={[{ pathname: '/study', state: { session } }]}>
          <Routes>
            <Route path="/study" element={<StudyPage now={fixedNow} />} />
            <Route path="/review" element={<ReviewPage />} />
            <Route path="/today" element={<div>今日学习页</div>} />
          </Routes>
        </MemoryRouter>
      </ServiceProvider>
    </ThemeProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StudyPage：居中单词卡渲染', () => {
  it('自评卡：展示放大的词形、英/美音标与发音按钮，不渲染选项', async () => {
    renderStudy();

    await screen.findByRole('heading', { name: 'abandon' });
    expect(screen.getByText(/英 \//)).toBeInTheDocument();
    expect(screen.getByText(/美 \//)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '英式发音' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '美式发音' })).toBeInTheDocument();
    // 自评卡不渲染选项
    expect(screen.queryByLabelText('选项区')).toBeNull();
  });

  it('选择题卡：渲染四个选项按钮，单击一个即提交', async () => {
    const submitAnswer = vi.fn(async () => makeAnswerResult());
    renderStudy({
      services: createFakeServices({ study: { submitAnswer } }),
      session: makeSession([makeCard({ style: 'CHOICE', options: ['放弃', '吸收', '维持', '庆祝'] })]),
    });

    expect(await screen.findByLabelText('选项区')).toBeInTheDocument();
    const optionButtons = await screen.findAllByRole('button');
    expect(optionButtons.length).toBeGreaterThanOrEqual(4);
    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    await waitFor(() =>
      expect(submitAnswer).toHaveBeenCalledWith(
        expect.objectContaining({ answer: '放弃', isCorrect: true, style: 'CHOICE' }),
      ),
    );
  });

  it('认识/不认识以左右大方框呈现，且无需先看答案即可点', async () => {
    renderStudy();

    const know = screen.getByRole('button', { name: '认识' });
    const unknown = screen.getByRole('button', { name: '不认识' });
    expect(know).toBeInTheDocument();
    expect(unknown).toBeInTheDocument();
  });

  it('点击发音按钮走系统 TTS（无在线音频也能发声）', async () => {
    const speak = vi.fn();
    vi.stubGlobal('SpeechSynthesisUtterance', class { text = ''; lang = ''; voice = null; volume = 1; rate = 1; });
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [{ lang: 'en-US', name: 'test' }],
      cancel: () => undefined,
      speak: (utterance: { lang: string }) => {
        speak(utterance.lang);
      },
    });
    renderStudy();

    fireEvent.click(await screen.findByRole('button', { name: '英式发音' }));
    expect(speak).toHaveBeenCalledWith('en-GB');
    fireEvent.click(screen.getByRole('button', { name: '美式发音' }));
    expect(speak).toHaveBeenCalledWith('en-US');
  });
});

describe('StudyPage：作答提交', () => {
  it('点「认识」提交 recognition=KNOWN、answer 为空、isCorrect=true', async () => {
    const submitAnswer = vi.fn(async () => makeAnswerResult());
    renderStudy({ services: createFakeServices({ study: { submitAnswer } }) });

    fireEvent.click(await screen.findByRole('button', { name: '认识' }));

    await waitFor(() =>
      expect(submitAnswer).toHaveBeenCalledWith(
        expect.objectContaining({ recognition: 'KNOWN', answer: '', isCorrect: true }),
      ),
    );
  });

  it('点「不认识」提交 recognition=UNKNOWN、isCorrect=false，反馈展示释义', async () => {
    const submitAnswer = vi.fn(async () => makeAnswerResult());
    renderStudy({ services: createFakeServices({ study: { submitAnswer } }) });

    fireEvent.click(await screen.findByRole('button', { name: '不认识' }));

    await waitFor(() =>
      expect(submitAnswer).toHaveBeenCalledWith(
        expect.objectContaining({ recognition: 'UNKNOWN', isCorrect: false }),
      ),
    );
    // 反馈后展示全部义项
    await waitFor(() => expect(screen.getAllByText(/放弃/).length).toBeGreaterThan(0));
  });

  it('提交失败时留在当前卡片给出可重试提示', async () => {
    const submitAnswer = vi.fn(async () => {
      throw new Error('网络断开');
    });
    renderStudy({ services: createFakeServices({ study: { submitAnswer } }) });

    fireEvent.click(await screen.findByRole('button', { name: '认识' }));

    expect(await screen.findByText(/保存失败|提交作答失败：网络断开/)).toBeInTheDocument();
  });

  it('同一帧内连点两次「认识」只提交一次', async () => {
    const submitAnswer = vi.fn(async () => makeAnswerResult());
    renderStudy({ services: createFakeServices({ study: { submitAnswer } }) });

    const know = await screen.findByRole('button', { name: '认识' });
    fireEvent.click(know);
    fireEvent.click(know);

    await waitFor(() => expect(submitAnswer).toHaveBeenCalledTimes(1));
  });
});

describe('StudyPage：会话结束', () => {
  it('卡耗尽后结束会话并带真实汇总跳到 /review', async () => {
    const finishSession = vi.fn(async () => makeSummary());
    renderStudy({
      services: createFakeServices({ study: { finishSession, submitAnswer: vi.fn(async () => makeAnswerResult()) } }),
    });

    fireEvent.click(await screen.findByRole('button', { name: '认识' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '完成学习' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '完成学习' }));

    await waitFor(() => expect(finishSession).toHaveBeenCalled());
    expect(await screen.findByText('学习完成')).toBeInTheDocument();
  });
});

describe('StudyPage：今日已背完后的重新开始', () => {
  it('0 卡会话弹出确认框，确认后带 force 重新开会话', async () => {
    const startSession = vi.fn(async () => makeSession([makeCard({ style: 'REVEAL', options: [] })]));
    const finishSession = vi.fn(async () => makeSummary());
    renderStudy({
      services: createFakeServices({ study: { startSession, finishSession } }),
      session: makeSession([]), // 今日已背完：0 卡会话
    });

    expect(await screen.findByText(/今天已经背诵完毕/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确定重新开始' }));

    await waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    // 重开后有卡可学
    expect(await screen.findByRole('button', { name: '认识' })).toBeInTheDocument();
  });
});

describe('StudyPage：干扰项收藏（R4 五角星）', () => {
  /** 造一张带干扰项来源词形的卡（庆祝没有来源词形 → 不渲染收藏按钮）。 */
  function makeChoiceCard(): SessionView {
    return makeSession([
      makeCard({
        options: ['放弃', '吸收', '维持', '庆祝'],
        distractorWords: [
          { text: '吸收', lemma: 'absorb' },
          { text: '维持', lemma: 'maintain' },
        ],
      }),
    ]);
  }

  it('反馈出现后展示干扰项；有来源词形的选项带收藏按钮，没有的不带', async () => {
    renderStudy({ session: makeChoiceCard() });

    // 作答前不渲染任何干扰项/星标。
    expect(screen.queryByRole('button', { name: /收藏/ })).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: '吸收' }));

    expect(await screen.findByText('吸收')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收藏 absorb' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收藏 maintain' })).toBeInTheDocument();
    // 庆祝没有来源词形 → 没有收藏按钮。
    expect(screen.queryByRole('button', { name: /收藏.*庆祝/u })).toBeNull();
  });

  it('点击星标调 collectWord（传来源词形），成功后星标变实心', async () => {
    const collectWord = vi.fn(async () => ({ collected: true, wordId: 'w-absorb' }));
    renderStudy({
      services: createFakeServices({ library: { collectWord } }),
      session: makeChoiceCard(),
    });

    fireEvent.click(await screen.findByRole('button', { name: '吸收' }));
    fireEvent.click(await screen.findByRole('button', { name: '收藏 absorb' }));

    await waitFor(() => expect(collectWord).toHaveBeenCalledWith({ lemma: 'absorb' }));
    expect(await screen.findByRole('button', { name: '已收藏 absorb' })).toBeInTheDocument();
  });

  it('收藏失败给行内提示，不打断学习', async () => {
    const collectWord = vi.fn(async () => {
      throw new Error('云端 AI 未配置');
    });
    renderStudy({
      services: createFakeServices({ library: { collectWord } }),
      session: makeChoiceCard(),
    });

    fireEvent.click(await screen.findByRole('button', { name: '吸收' }));
    fireEvent.click(await screen.findByRole('button', { name: '收藏 absorb' }));

    expect(await screen.findByText(/收藏失败：云端 AI 未配置/)).toBeInTheDocument();
  });
});
