import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { AnswerResult, SessionView } from '@woyao/services';

import { AnswerFeedback } from '../components/AnswerFeedback';
import { WordCard } from '../components/WordCard';
import { isChoiceCard } from '../components/wordCardModel';
import { useServices } from '../services/ServiceProvider';
import { PageShell } from './PageShell';

/** 从今日页带过来的会话（`navigate('/study', { state: { session } })`）。 */
export interface StudyLocationState {
  readonly session?: SessionView;
}

/** StudyPage 入参（`now` 可注入，测试用固定时钟；服务层禁止 new Date，UI 层允许）。 */
export interface StudyPageProps {
  readonly now?: () => Date;
}

/** 把异常压成可展示的一句话。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 学习作答页（`/study`）。
 *
 * 流程：展示卡片 → CHOICE 点选 / REVEAL 显示答案 → “认识/不认识”（recognition 唯一来源，
 * **绝不由 isCorrect 推导**）→ 提交 → 反馈 → 下一题；卡耗尽 → `finishSession` → `/review`。
 *
 * 会话来源有两条：路由 state（今日页“开始学习”）或 `?deckId=`（刷新/直达时重建会话）。
 * 两条路径拿到的是同一个 `SessionView`（服务层按“词库 + 本地日”确定性重建）。
 */
export default function StudyPage({ now = (): Date => new Date() }: StudyPageProps): ReactElement {
  const services = useServices();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const initialState = (location.state as StudyLocationState | null)?.session ?? null;

  const [session, setSession] = useState<SessionView | null>(initialState);
  const [starting, setStarting] = useState<boolean>(initialState === null);
  const [error, setError] = useState<string | null>(null);
  // 提交/结束会话失败是可重试的：用行内提示，不把整页替换成错误页（否则用户会丢掉当前卡片）。
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [feedback, setFeedback] = useState<AnswerResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cardShownAt, setCardShownAt] = useState<number>(() => now().getTime());

  // 时钟只作为“取当前时刻”的注入点，不参与依赖：避免默认 `() => new Date()` 每次渲染
  // 都换身份，导致重建会话的 effect 反复触发。
  const nowRef = useRef(now);
  nowRef.current = now;
  // StrictMode 会重复执行 effect；用 ref 保证最多发起一次 startSession。
  const startRequested = useRef(false);

  useEffect(() => {
    if (services === null || initialState !== null || startRequested.current) {
      return;
    }
    const deckId = searchParams.get('deckId');
    if (deckId === null) {
      // 既没有路由 state 也没有 deckId：不是错误，提示用户从今日页进入。
      setStarting(false);
      return;
    }
    startRequested.current = true;
    void services.study
      .startSession({ deckId, now: nowRef.current() })
      .then((view) => {
        setSession(view);
      })
      .catch((cause: unknown) => {
        setError(`开始学习失败：${describeError(cause)}`);
      })
      .finally(() => {
        setStarting(false);
      });
  }, [services, initialState, searchParams]);

  /** 未接入数据服务：只显示空态（PageShell 内部渲染 ServiceUnavailable）。 */
  if (services === null) {
    return <PageShell title="学习" headingId="study-page-heading" />;
  }

  if (starting) {
    return (
      <PageShell title="学习" headingId="study-page-heading">
        <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '8rem' }}>
          <CircularProgress aria-label="正在准备学习内容" />
        </Box>
      </PageShell>
    );
  }

  if (error !== null) {
    return (
      <PageShell title="学习" headingId="study-page-heading">
        <Alert severity="error">{error}</Alert>
        <Box>
          <Button variant="outlined" onClick={() => navigate('/today')}>
            返回今日学习
          </Button>
        </Box>
      </PageShell>
    );
  }

  if (session === null || session.cards.length === 0) {
    return (
      <PageShell title="学习" headingId="study-page-heading">
        <Typography variant="body1">本次会话没有卡片，请返回今日学习。</Typography>
        <Box>
          <Button variant="contained" onClick={() => navigate('/today')}>
            返回今日学习
          </Button>
        </Box>
      </PageShell>
    );
  }

  const activeSession = session;
  const activeServices = services;
  const card = activeSession.cards[index];
  if (card === undefined) {
    return (
      <PageShell title="学习" headingId="study-page-heading">
        <Typography variant="body1">本次会话的卡片已全部完成。</Typography>
        <Box>
          <Button variant="contained" onClick={() => navigate('/review', { state: {} })}>
            查看本次汇总
          </Button>
        </Box>
      </PageShell>
    );
  }

  const choice = isChoiceCard(card);
  const isLastCard = index + 1 >= activeSession.cards.length;
  const canReportRecognition = feedback === null && (choice ? selected !== null : revealed);
  const totalCards = activeSession.cards.length;
  const progress = `第 ${index + 1} / ${totalCards} 题`;

  /**
   * “认识/不认识”是 recognition 的唯一来源；isCorrect 只按作答事实计算。
   *
   * CHOICE：`selected === card.answer`（选对了就是答对，与自报认识与否无关）；
   * REVEAL（含单选退化的 CHOICE）：没有可选项，“自报认识”即视为答对。
   */
  async function submit(recognition: 'KNOWN' | 'UNKNOWN'): Promise<void> {
    if (submitting) {
      return;
    }
    const isCorrect = choice ? selected === card.answer : recognition === 'KNOWN';
    const answeredAt = nowRef.current();
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await activeServices.study.submitAnswer({
        sessionId: activeSession.sessionId,
        deckId: activeSession.deckId,
        wordId: card.wordId,
        mode: card.mode,
        prompt: card.prompt,
        // 没有“选项”的题型没有用户答案，按契约传空串（不把自报结果当答案文本）。
        answer: choice ? (selected ?? '') : '',
        isCorrect,
        recognition,
        answeredAt,
        durationMs: answeredAt.getTime() - cardShownAt,
      });
      setFeedback(result);
    } catch (cause: unknown) {
      setSubmitError(`提交作答失败：${describeError(cause)}`);
    } finally {
      setSubmitting(false);
    }
  }

  /** 进入下一题；最后一题先结束会话拿到真实汇总，再带汇总去完成页。 */
  async function advance(): Promise<void> {
    if (!isLastCard) {
      setIndex(index + 1);
      setSelected(null);
      setRevealed(false);
      setFeedback(null);
      setCardShownAt(nowRef.current().getTime());
      return;
    }
    setSubmitError(null);
    try {
      const summary = await activeServices.study.finishSession({
        sessionId: activeSession.sessionId,
        now: nowRef.current(),
      });
      navigate('/review', { state: { summary } });
    } catch (cause: unknown) {
      setSubmitError(`结束学习失败：${describeError(cause)}`);
    }
  }

  return (
    <PageShell title="学习" headingId="study-page-heading">
      <Box sx={{ display: 'grid', gap: 2, maxWidth: 720 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <Typography variant="body2" color="text.secondary">
            {progress}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            新词 {activeSession.newCount} · 复习 {activeSession.reviewCount}
          </Typography>
        </Box>

        <WordCard
          card={card}
          selected={selected}
          revealed={revealed}
          locked={feedback !== null || submitting}
          onSelect={setSelected}
          onReveal={() => setRevealed(true)}
        />

        {/* 作答操作区：始终在正常文档流里，靠页面底部留白躲开移动端固定底栏，
            不使用 fixed/sticky 覆盖卡片内容。 */}
        <Box
          data-testid="study-actions"
          sx={{
            display: 'flex',
            gap: 1,
            flexWrap: 'wrap',
            alignItems: 'center',
            minHeight: 44,
          }}
        >
          {canReportRecognition ? (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ mr: 1 }}>
                你认识这个词吗？
              </Typography>
              <Button
                variant="contained"
                onClick={() => void submit('KNOWN')}
                disabled={submitting}
                aria-label="认识"
                sx={{ minHeight: 44, minWidth: 88 }}
              >
                认识
              </Button>
              <Button
                variant="outlined"
                onClick={() => void submit('UNKNOWN')}
                disabled={submitting}
                aria-label="不认识"
                sx={{ minHeight: 44, minWidth: 88 }}
              >
                不认识
              </Button>
            </>
          ) : feedback === null ? (
            <Typography variant="body2" color="text.secondary">
              {choice ? '请选择一个选项，然后告诉我们你认不认识这个词。' : '先显示答案，再告诉我们你认不认识这个词。'}
            </Typography>
          ) : null}
        </Box>

        {submitError !== null ? <Alert severity="error">{submitError}</Alert> : null}

        {feedback !== null ? (
          <>
            <AnswerFeedback
              isCorrect={feedback.isCorrect}
              correctAnswer={feedback.correctAnswer}
              cumulativeWrongCount={feedback.cumulativeWrongCount}
              showCumulativeWrongPrompt={feedback.showCumulativeWrongPrompt}
            />
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <Button variant="contained" onClick={() => void advance()} sx={{ minHeight: 44 }}>
                {isLastCard ? '完成学习' : '下一题'}
              </Button>
            </Box>
          </>
        ) : null}
      </Box>
    </PageShell>
  );
}
