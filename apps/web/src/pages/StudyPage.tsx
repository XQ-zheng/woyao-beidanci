import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { AnswerResult, SessionView } from '@woyao/services';

import { AnswerFeedback } from '../components/AnswerFeedback';
import { speak } from '../lib/speech';
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
 * 交互按用户要求重做：单词**居中、放大、加粗**；下方一行英式/美式音标与发音按钮
 * （点击朗读，系统 TTS 离线可用）；底部左右两个大方框「认识 / 不认识」，单击即提交。
 * **不再用其他单词的释义做选择题**——认不认识由用户自报（recognition 唯一来源）。
 * 学习期间左侧导航隐藏，右上角「☰」可随时展开查看；卡耗尽 → `finishSession` → `/review`。
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
  const [feedback, setFeedback] = useState<AnswerResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  // state 要等 re-render 才生效，连点两下会在同一帧里都通过 `if (submitting)` 检查；
  // 用 ref 在调用当帧就锁住。
  const submitLock = useRef(false);
  const [cardShownAt, setCardShownAt] = useState<number>(() => now().getTime());
  /** 今日已背完后的「重新开始学习」确认框。 */
  const [relearnOpen, setRelearnOpen] = useState(false);
  /** 确认重学后正在重开会话。 */
  const [relearning, setRelearning] = useState(false);
  /** 本题已收藏成功的干扰选项文本（星标变实心，纯本地状态，刷新后以服务端为准）。 */
  const [collectedTexts, setCollectedTexts] = useState<ReadonlySet<string>>(new Set());

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
    let active = true;
    void services.study
      .startSession({ deckId, now: nowRef.current() })
      .then(async (view) => {
        if (view.cards.length === 0) {
          // 0 张卡的会话没有任何记录价值；直接结束掉，避免历史里留下一条“0 作答”的空会话。
          try {
            await services.study.finishSession({ sessionId: view.sessionId, now: nowRef.current() });
          } catch {
            // 收尾失败不影响“没有卡片”这个事实，页面照样给出返回入口。
          }
        }
        if (active) {
          setSession(view);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(`开始学习失败：${describeError(cause)}`);
        }
      })
      .finally(() => {
        if (active) {
          setStarting(false);
        }
      });

    return () => {
      active = false;
    };
  }, [services, initialState, searchParams]);

  // 重新发码倒计时已废弃；这里监听「今日已背完」状态，自动弹出重新开始确认框。
  useEffect(() => {
    if (session !== null && session.cards.length === 0) {
      setRelearnOpen(true);
    }
  }, [session]);

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
    const relearnDeckId = session?.deckId ?? searchParams.get('deckId');
    return (
      <PageShell title="学习" headingId="study-page-heading">
        <Box sx={{ display: 'grid', gap: 2, maxWidth: 520, mx: 'auto', mt: 6, justifyItems: 'center' }}>
          <Typography variant="h5">今天已经背诵完毕 🎉</Typography>
          <Typography variant="body1" color="text.secondary" sx={{ textAlign: "center" }}>
            今日的学习计划已经完成。如果你想再过一遍，可以重新开始学习——
            **两次学习的记录都会保存**，不会互相覆盖。
          </Typography>
          <Box sx={{ display: 'flex', gap: 2, mt: 1 }}>
            <Button variant="outlined" onClick={() => navigate('/today')}>
              返回今日学习
            </Button>
            <Button
              variant="contained"
              disabled={relearning || relearnDeckId === null}
              onClick={() => {
                if (relearnDeckId === null) {
                  return;
                }
                setRelearnOpen(true);
              }}
            >
              重新开始学习
            </Button>
          </Box>
        </Box>
        <Dialog open={relearnOpen} onClose={() => setRelearnOpen(false)}>
          <DialogTitle>重新开始学习？</DialogTitle>
          <DialogContent>
            <DialogContentText>
              今天的学习计划已经完成。确定要重新开始学习吗？
              重新开始的这一次也会记录在学习历史里，与之前的记录互不影响。
            </DialogContentText>
          </DialogContent>
          <DialogActions>
            <Button
              onClick={() => {
                setRelearnOpen(false);
                setRelearning(false);
              }}
              disabled={relearning}
            >
              取消
            </Button>
            <Button
              variant="contained"
              disabled={relearning}
              onClick={() => {
                if (relearnDeckId === null) {
                  return;
                }
                setRelearning(true);
                startRequested.current = false;
                void services.study
                  .startSession({ deckId: relearnDeckId, force: true, now: nowRef.current() })
                  .then(async (view) => {
                    if (view.cards.length === 0) {
                      try {
                        await services.study.finishSession({ sessionId: view.sessionId, now: nowRef.current() });
                      } catch {
                        // 同上：0 卡会话直接结束。
                      }
                    }
                    setSession(view);
                    setIndex(0);
                    setFeedback(null);
                    setRelearnOpen(false);
                    setRelearning(false);
                  })
                  .catch((cause: unknown) => {
                    setError(`重新开始失败：${describeError(cause)}`);
                    setRelearnOpen(false);
                    setRelearning(false);
                  });
              }}
            >
              {relearning ? '正在重新开始…' : '确定重新开始'}
            </Button>
          </DialogActions>
        </Dialog>
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

  const isLastCard = index + 1 >= activeSession.cards.length;
  const totalCards = activeSession.cards.length;
  const progress = `第 ${index + 1} / ${totalCards} 题`;

  /**
   * 统一提交入口：REVEAL 由「认识/不认识」自报（自报认识即答对）；
   * CHOICE 由点选选项判定（选中正确答案才算答对，仍以用户点选为唯一作答事实）。
   * 题型随事件落库，供混合模式按题型统计掌握度。
   */
  async function submit(input: {
    recognition: 'KNOWN' | 'UNKNOWN';
    answer: string;
    isCorrect: boolean;
    style: 'CHOICE' | 'REVEAL';
  }): Promise<void> {
    if (submitLock.current) {
      return;
    }
    submitLock.current = true;
    const { recognition, answer, isCorrect, style } = input;
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
        answer,
        isCorrect,
        recognition,
        style,
        answeredAt,
        durationMs: answeredAt.getTime() - cardShownAt,
      });
      setFeedback(result);
    } catch (cause: unknown) {
      setSubmitError(`提交作答失败：${describeError(cause)}`);
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  }

  /**
   * 收藏一个干扰选项的来源词形（R4）：调 collectWord（词不存在时自动建词并挂入生词本），
   * 成功后该选项旁的星标变实心。失败给行内提示，不弹窗打断学习。
   */
  async function collectDistractor(text: string, lemma: string): Promise<void> {
    try {
      await activeServices.library.collectWord({ lemma });
      setCollectedTexts((previous) => new Set(previous).add(text));
    } catch (cause: unknown) {
      setSubmitError(`收藏失败：${describeError(cause)}`);
    }
  }

  /** 进入下一题；最后一题先结束会话拿到真实汇总，再带汇总去完成页。 */
  async function advance(): Promise<void> {
    if (!isLastCard) {
      setIndex(index + 1);
      setFeedback(null);
      setCollectedTexts(new Set());
      setCardShownAt(nowRef.current().getTime());
      return;
    }
    if (finishing) {
      return;
    }
    setFinishing(true);
    setSubmitError(null);
    try {
      const summary = await activeServices.study.finishSession({
        sessionId: activeSession.sessionId,
        now: nowRef.current(),
      });
      navigate('/review', { state: { summary } });
    } catch (cause: unknown) {
      setSubmitError(`结束学习失败：${describeError(cause)}`);
    } finally {
      setFinishing(false);
    }
  }

  return (
    <Box
      sx={{
        display: 'grid',
        placeItems: 'center',
        minHeight: 'calc(100vh - 48px)',
        gap: 3,
        py: 3,
      }}
    >
      <Typography variant="body2" color="text.secondary" sx={{ justifySelf: 'start' }}>
        {progress} · 新词 {activeSession.newCount} · 复习 {activeSession.reviewCount}
      </Typography>

      <Box sx={{ display: 'grid', justifyItems: 'center', gap: 2, width: '100%' }}>
        <Typography
          component="h1"
          sx={{
            fontSize: { xs: 56, md: 76 },
            fontWeight: 700,
            textAlign: 'center',
            wordBreak: 'break-word',
            lineHeight: 1.1,
          }}
        >
          {card.lemma}
        </Typography>

        <Box sx={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
          <Box sx={{ display: 'grid', justifyItems: 'center', gap: 0.5 }}>
            <Typography variant="body1" color="text.secondary">
              英 /{card.phoneticUk ?? '—'}/
            </Typography>
            <Button size="small" variant="outlined" onClick={() => speak(card.lemma, 'uk')} aria-label="英式发音">
              🔊 英式
            </Button>
          </Box>
          <Box sx={{ display: 'grid', justifyItems: 'center', gap: 0.5 }}>
            <Typography variant="body1" color="text.secondary">
              美 /{card.phoneticUs ?? '—'}/
            </Typography>
            <Button size="small" variant="outlined" onClick={() => speak(card.lemma, 'us')} aria-label="美式发音">
              🔊 美式
            </Button>
          </Box>
        </Box>
      </Box>

      {card.style === 'CHOICE' ? (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
            gap: 2,
            width: '100%',
            maxWidth: 720,
          }}
          aria-label="选项区"
        >
          {card.options.map((option) => (
            <Button
              key={option}
              variant="outlined"
              onClick={() =>
                void submit({
                  recognition: option === card.answer ? 'KNOWN' : 'UNKNOWN',
                  answer: option,
                  isCorrect: option === card.answer,
                  style: 'CHOICE',
                })
              }
              disabled={submitting}
              sx={{ minHeight: 76, fontSize: 18, borderWidth: 2, textTransform: 'none' }}
            >
              {option}
            </Button>
          ))}
        </Box>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 3,
            width: '100%',
            maxWidth: 720,
          }}
        >
          <Button
            variant="contained"
            color="success"
            onClick={() =>
              void submit({ recognition: 'KNOWN', answer: '', isCorrect: true, style: 'REVEAL' })
            }
            disabled={submitting}
            aria-label="认识"
            sx={{ minHeight: 96, fontSize: 22, fontWeight: 700 }}
          >
            认识
          </Button>
          <Button
            variant="outlined"
            onClick={() =>
              void submit({ recognition: 'UNKNOWN', answer: '', isCorrect: false, style: 'REVEAL' })
            }
            disabled={submitting}
            aria-label="不认识"
            sx={{ minHeight: 96, fontSize: 22, fontWeight: 700, borderWidth: 2 }}
          >
            不认识
          </Button>
        </Box>
      )}

      {submitError !== null ? <Alert severity="error">{submitError}</Alert> : null}

      {feedback !== null ? (
        <Box sx={{ display: 'grid', gap: 2, width: '100%', maxWidth: 720, justifyItems: 'center' }}>
          <AnswerFeedback
            isCorrect={feedback.isCorrect}
            correctAnswer={feedback.correctAnswer}
            cumulativeWrongCount={feedback.cumulativeWrongCount}
            showCumulativeWrongPrompt={feedback.showCumulativeWrongPrompt}
          />
          <Box sx={{ display: 'grid', gap: 1, width: '100%', justifyItems: 'center' }}>
            {card.senses.map((sense) => (
              <Box key={sense.senseNo} sx={{ textAlign: 'center' }}>
                <Typography variant="body2" color="text.secondary">
                  {sense.pos}
                </Typography>
                <Typography variant="body1">{sense.simpleZh}</Typography>
                {sense.detailedZh !== null ? (
                  <Typography variant="body2" color="text.secondary">
                    {sense.detailedZh}
                  </Typography>
                ) : null}
              </Box>
            ))}
          </Box>
          {card.style === 'CHOICE' && card.options.length > 1 ? (
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', justifyContent: 'center' }}>
              {card.options
                .filter((text) => text !== card.answer)
                .map((text) => {
                  const lemma =
                    (card.distractorWords ?? []).find((item) => item.text === text)?.lemma ?? null;
                  const collected = collectedTexts.has(text);
                  return (
                    <Box
                      key={text}
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 0.5,
                        border: '1px solid',
                        borderColor: 'divider',
                        borderRadius: 1,
                        px: 1,
                        py: 0.25,
                      }}
                    >
                      {lemma !== null ? (
                        <Typography component="span" variant="body2" sx={{ fontWeight: 700 }}>
                          {lemma}
                        </Typography>
                      ) : null}
                      <Typography component="span" variant="body2" color="text.secondary">
                        {text}
                      </Typography>
                      {lemma !== null ? (
                        <IconButton
                          size="small"
                          aria-label={collected ? `已收藏 ${lemma}` : `收藏 ${lemma}`}
                          title={`收藏「${lemma}」到生词本`}
                          onClick={() => void collectDistractor(text, lemma)}
                        >
                          {collected ? '★' : '☆'}
                        </IconButton>
                      ) : null}
                    </Box>
                  );
                })}
            </Box>
          ) : null}
          <Button
            variant="contained"
            onClick={() => void advance()}
            disabled={finishing}
            sx={{ minHeight: 44, minWidth: 160 }}
          >
            {isLastCard ? (finishing ? '正在保存…' : '完成学习') : '下一题'}
          </Button>
        </Box>
      ) : null}
    </Box>
  );
}
