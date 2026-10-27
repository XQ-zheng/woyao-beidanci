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
  const { services = createFakeServices(), session = makeSession() } = options;

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

describe('StudyPage：卡片渲染', () => {
  it('展示词形、音标、选项与工具栏，且无音频时按钮禁用但音标仍在', async () => {
    renderStudy();

    expect(screen.getByRole('heading', { name: 'abandon' })).toBeInTheDocument();
    expect(screen.getByText('/əˈbændən/')).toBeInTheDocument();
    for (const option of ['放弃', '吸收', '维持', '庆祝']) {
      expect(screen.getByRole('button', { name: option })).toBeInTheDocument();
    }

    const toolbar = screen.getByRole('toolbar', { name: '单词工具栏' });
    expect(toolbar).toBeInTheDocument();
    // 假服务的发音 URL 为 null → 按钮禁用，但音标照旧展示（发音缺失不等于词条缺失）。
    await waitFor(() => expect(screen.getByRole('button', { name: '英音' })).toBeDisabled());
    expect(screen.getByRole('button', { name: '美音' })).toBeDisabled();
    expect(screen.getByRole('slider', { name: '音量' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收藏' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '详解' })).toBeInTheDocument();
  });

  it('切到“不认识”之前不出现认识/不认识按钮', () => {
    renderStudy();

    expect(screen.queryByRole('button', { name: '认识' })).toBeNull();
    expect(screen.queryByRole('button', { name: '不认识' })).toBeNull();
    expect(screen.getByText('请选择一个选项，然后告诉我们你认不认识这个词。')).toBeInTheDocument();
  });

  it('REVEAL 题型先显示答案，再出现认识/不认识', () => {
    renderStudy({
      session: makeSession([makeCard({ style: 'REVEAL', options: [] })]),
    });

    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));

    expect(screen.getByTestId('revealed-answer')).toHaveTextContent('放弃');
    expect(screen.getByRole('button', { name: '认识' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '不认识' })).toBeInTheDocument();
  });

  it('只有一个选项时退化为“显示答案”，不渲染无意义的选择', () => {
    renderStudy({
      session: makeSession([makeCard({ style: 'CHOICE', options: ['放弃'] })]),
    });

    expect(screen.getByRole('button', { name: '显示答案' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '放弃' })).toBeNull();
  });
});

describe('StudyPage：作答反馈', () => {
  it('答对显示绿色“答对了”', async () => {
    const services = createFakeServices({
      study: { submitAnswer: vi.fn(async () => makeAnswerResult({ isCorrect: true })) },
    });
    renderStudy({ services });

    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    fireEvent.click(screen.getByRole('button', { name: '认识' }));

    expect(await screen.findByText('答对了')).toHaveStyle({ color: 'rgb(46, 125, 50)' });
    expect(screen.getByRole('status')).toHaveAttribute('data-result', 'correct');
  });

  it('答错显示红色“答错了”', async () => {
    const services = createFakeServices({
      study: {
        submitAnswer: vi.fn(async () => makeAnswerResult({ isCorrect: false, correctAnswer: '放弃' })),
      },
    });
    renderStudy({ services });

    fireEvent.click(screen.getByRole('button', { name: '吸收' }));
    fireEvent.click(screen.getByRole('button', { name: '认识' }));

    expect(await screen.findByText('答错了')).toHaveStyle({ color: 'rgb(198, 40, 40)' });
    expect(screen.getByRole('status')).toHaveAttribute('data-result', 'wrong');
  });

  it('同一词累计答错 2 次时提示“累计答错 2 次”，答对时不提示', async () => {
    const services = createFakeServices({
      study: {
        submitAnswer: vi.fn(async () =>
          makeAnswerResult({
            isCorrect: false,
            cumulativeWrongCount: 2,
            showCumulativeWrongPrompt: true,
          }),
        ),
      },
    });
    renderStudy({ services });

    fireEvent.click(screen.getByRole('button', { name: '吸收' }));
    fireEvent.click(screen.getByRole('button', { name: '不认识' }));

    expect(await screen.findByText('累计答错 2 次')).toBeInTheDocument();
  });

  it('提交后锁定选项，已作答的卡片不能再改选', async () => {
    const services = createFakeServices({
      study: { submitAnswer: vi.fn(async () => makeAnswerResult({ isCorrect: true })) },
    });
    renderStudy({ services });

    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    fireEvent.click(screen.getByRole('button', { name: '认识' }));
    await screen.findByText('答对了');

    expect(screen.getByRole('button', { name: '放弃' })).toBeDisabled();
  });

  it('提交失败时留在当前卡片给出可重试提示，不把整页替换成错误页', async () => {
    const services = createFakeServices({
      study: {
        submitAnswer: vi.fn(async () => {
          throw new Error('数据库忙');
        }),
      },
    });
    renderStudy({ services });

    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    fireEvent.click(screen.getByRole('button', { name: '认识' }));

    expect(await screen.findByText(/提交作答失败：数据库忙/)).toBeInTheDocument();
    // 卡片与作答按钮仍在，用户可以直接重试。
    expect(screen.getByRole('heading', { name: 'abandon' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '认识' })).toBeEnabled();
  });

  it('答对且未达阈值时不出现累计错次提示', async () => {
    const services = createFakeServices({
      study: {
        submitAnswer: vi.fn(async () =>
          makeAnswerResult({ isCorrect: true, cumulativeWrongCount: 0, showCumulativeWrongPrompt: false }),
        ),
      },
    });
    renderStudy({ services });

    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    fireEvent.click(screen.getByRole('button', { name: '认识' }));

    await screen.findByText('答对了');
    expect(screen.queryByText(/累计答错/)).toBeNull();
  });
});

describe('StudyPage：认识/不认识是用户自报，不由正误推导', () => {
  it('选择题选对后点“不认识”→ isCorrect=true 且 recognition=UNKNOWN', async () => {
    const submitAnswer = vi.fn(async () => makeAnswerResult({ isCorrect: true }));
    const services = createFakeServices({ study: { submitAnswer } });
    renderStudy({ services });

    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    fireEvent.click(screen.getByRole('button', { name: '不认识' }));

    await waitFor(() => expect(submitAnswer).toHaveBeenCalledTimes(1));
    expect(submitAnswer).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's-1',
        deckId: 'deck-cet4',
        wordId: 'w-abandon',
        mode: 'EN_TO_ZH',
        answer: '放弃',
        isCorrect: true,
        recognition: 'UNKNOWN',
      }),
    );
  });

  it('选择题选错后点“认识”→ isCorrect=false 且 recognition=KNOWN', async () => {
    const submitAnswer = vi.fn(async () => makeAnswerResult({ isCorrect: false }));
    const services = createFakeServices({ study: { submitAnswer } });
    renderStudy({ services });

    fireEvent.click(screen.getByRole('button', { name: '吸收' }));
    fireEvent.click(screen.getByRole('button', { name: '认识' }));

    await waitFor(() => expect(submitAnswer).toHaveBeenCalledTimes(1));
    expect(submitAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ isCorrect: false, recognition: 'KNOWN' }),
    );
  });

  it('REVEAL 题型不伪造答案文本：answer 传空串', async () => {
    const submitAnswer = vi.fn(async () => makeAnswerResult({ isCorrect: true }));
    const services = createFakeServices({ study: { submitAnswer } });
    renderStudy({ services, session: makeSession([makeCard({ style: 'REVEAL', options: [] })]) });

    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
    fireEvent.click(screen.getByRole('button', { name: '认识' }));

    await waitFor(() => expect(submitAnswer).toHaveBeenCalledTimes(1));
    expect(submitAnswer).toHaveBeenCalledWith(expect.objectContaining({ answer: '', recognition: 'KNOWN' }));
  });
});

describe('StudyPage：防重入', () => {
  it('同一帧内连点两次“认识”只提交一次', async () => {
    const submitAnswer = vi.fn(async () => makeAnswerResult({ isCorrect: true }));
    const services = createFakeServices({ study: { submitAnswer } });
    renderStudy({ services });

    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    const know = screen.getByRole('button', { name: '认识' });
    fireEvent.click(know);
    fireEvent.click(know);

    await screen.findByText('答对了');
    expect(submitAnswer).toHaveBeenCalledTimes(1);
  });
});

describe('StudyPage：会话结束', () => {
  it('卡耗尽后结束会话并带真实汇总跳到 /review', async () => {
    const finishSession = vi.fn(async () =>
      makeSummary({ newCount: 1, reviewCount: 0, totalAnswers: 1, correctCount: 1, activeDurationMs: 125000 }),
    );
    const services = createFakeServices({ study: { finishSession } });
    renderStudy({ services, session: makeSession([makeCard()]) });

    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    fireEvent.click(screen.getByRole('button', { name: '认识' }));
    await screen.findByText('答对了');
    fireEvent.click(screen.getByRole('button', { name: '完成学习' }));

    await waitFor(() => expect(finishSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's-1' })));
    expect(await screen.findByText('学习完成')).toBeInTheDocument();
    expect(screen.getByTestId('summary-new-count')).toHaveTextContent('新词数1');
    expect(screen.getByTestId('summary-review-count')).toHaveTextContent('复习数0');
    expect(screen.getByTestId('summary-duration')).toHaveTextContent('2 分 5 秒');
    expect(screen.getByTestId('summary-correct')).toHaveTextContent('1 / 1');
  });

  it('多张卡时“下一题”推进到下一张，且不提前结束会话', async () => {
    const finishSession = vi.fn(async () => makeSummary());
    const services = createFakeServices({ study: { finishSession } });
    renderStudy({
      services,
      session: makeSession([makeCard(), makeCard({ wordId: 'w-brief', lemma: 'brief', prompt: 'brief', answer: '简短的', options: ['简短的', '昂贵的'] })]),
    });

    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    fireEvent.click(screen.getByRole('button', { name: '认识' }));
    await screen.findByText('答对了');
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));

    expect(screen.getByRole('heading', { name: 'brief' })).toBeInTheDocument();
    expect(screen.getByText('第 2 / 2 题')).toBeInTheDocument();
    expect(finishSession).not.toHaveBeenCalled();
  });
});

describe('StudyPage：空态与布局约束', () => {
  it('services 为 null 时显示“数据服务未接入”', () => {
    renderStudy({ services: null });

    expect(screen.getByText('数据服务未接入')).toBeInTheDocument();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('作答操作区在正常文档流中，排在词卡之后（不用 fixed/sticky 盖住卡片）', () => {
    renderStudy();
    fireEvent.click(screen.getByRole('button', { name: '放弃' }));

    const article = screen.getByRole('article', { name: '单词卡片' });
    const actions = screen.getByTestId('study-actions');
    const position = getComputedStyle(actions).position;

    expect(position).not.toBe('fixed');
    expect(position).not.toBe('sticky');
    expect(article.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
