import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toLocalDateString } from '@woyao/services';
import type {
  DailyHistoryRow,
  DeckSummary,
  SessionView,
  SettingsSnapshot,
} from '@woyao/services';

import { useServices } from '../services/ServiceProvider';
import { PageShell } from './PageShell';

/** TodayPage 入参（`now` 可注入，测试用固定时钟）。 */
export interface TodayPageProps {
  readonly now?: () => Date;
}

/** 今日页需要的三份数据。 */
interface TodayData {
  readonly snapshot: SettingsSnapshot;
  readonly decks: DeckSummary[];
  readonly today: DailyHistoryRow | null;
  readonly localDate: string;
}

/** 训练模式的中文名（界面不直接显示 MIXED / EN_TO_ZH 这类枚举值）。 */
const TRAINING_MODE_LABELS: Readonly<Record<string, string>> = {
  MIXED: '双向混合',
  EN_TO_ZH: '英译中',
  ZH_TO_EN: '中译英',
};

/** 题型的中文名。 */
const QUESTION_STYLE_LABELS: Readonly<Record<string, string>> = {
  CHOICE: '选择题',
  REVEAL: '自评回忆',
};

/** 把异常压成可展示的一句话。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 今日学习（`/today`）：展示今日计划与已学量，并由此进入学习主流程。
 *
 * 这里**不预先构建队列**：队列由 `study.startSession` 按“词库 + 本地日”确定性生成，
 * 没有独立的预览接口。所以页面如实展示“每日上限”（设置里的计划）与“今日已作答”
 * （`report.getDailyHistory` 的真实统计），不把上限伪装成“待学 N 个”。
 */
export default function TodayPage({ now = (): Date => new Date() }: TodayPageProps): ReactElement {
  const services = useServices();
  const navigate = useNavigate();
  const nowRef = useRef(now);
  nowRef.current = now;

  const [data, setData] = useState<TodayData | null>(null);
  const [deckId, setDeckId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (services === null) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);

    void (async (): Promise<void> => {
      const snapshot = await services.settings.getSnapshot();
      const decks = await services.library.listDecks();
      const localDate = toLocalDateString(nowRef.current(), snapshot.timeZone);
      const history = await services.report.getDailyHistory({
        fromLocalDate: localDate,
        toLocalDate: localDate,
      });
      if (!active) {
        return;
      }
      setData({ snapshot, decks, today: history[0] ?? null, localDate });
      setDeckId((current) => current ?? decks[0]?.deckId ?? null);
    })()
      .catch((cause: unknown) => {
        if (active) {
          setError(`加载今日计划失败：${describeError(cause)}`);
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [services]);

  if (services === null) {
    return <PageShell title="今日学习" headingId="today-page-heading" />;
  }

  if (loading) {
    return (
      <PageShell title="今日学习" headingId="today-page-heading">
        <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '8rem' }}>
          <CircularProgress aria-label="正在加载今日计划" />
        </Box>
      </PageShell>
    );
  }

  if (error !== null) {
    return (
      <PageShell title="今日学习" headingId="today-page-heading">
        <Alert severity="error">{error}</Alert>
      </PageShell>
    );
  }

  if (data === null) {
    return <PageShell title="今日学习" headingId="today-page-heading" />;
  }

  if (data.decks.length === 0) {
    return (
      <PageShell title="今日学习" headingId="today-page-heading">
        <Typography variant="body1">还没有可用词库。先到“词库”页导入或新建一个词库，再开始学习。</Typography>
        <Box>
          <Button variant="contained" onClick={() => navigate('/library')}>
            去词库页
          </Button>
        </Box>
      </PageShell>
    );
  }

  const selectedDeck = data.decks.find((deck) => deck.deckId === deckId) ?? data.decks[0];
  const answered = data.today?.total ?? 0;
  const accuracy =
    data.today === null || data.today.total === 0 ? null : Math.round(data.today.accuracy * 100);

  async function start(): Promise<void> {
    if (starting || services === null || selectedDeck === undefined) {
      return;
    }
    setStarting(true);
    setNotice(null);
    try {
      const session: SessionView = await services.study.startSession({
        deckId: selectedDeck.deckId,
        now: nowRef.current(),
      });
      if (session.cards.length === 0) {
        setNotice('今天没有待学习的单词：新词已学完、复习也都没到期。可以调整每日计划或换个词库。');
        return;
      }
      navigate('/study', { state: { session } });
    } catch (cause: unknown) {
      setNotice(`开始学习失败：${describeError(cause)}`);
    } finally {
      setStarting(false);
    }
  }

  return (
    <PageShell title="今日学习" headingId="today-page-heading">
      <Box sx={{ display: 'grid', gap: 2, maxWidth: 640 }}>
        <Typography variant="body2" color="text.secondary">
          {data.localDate}
        </Typography>

        <Box sx={{ display: 'grid', gap: 1 }}>
          <Typography variant="subtitle1" component="h3">
            今日计划
          </Typography>
          <Typography variant="body1">
            新词上限 {data.snapshot.dailyNewLimit} 个 · 复习上限 {data.snapshot.dailyReviewLimit} 个
          </Typography>
          <Typography variant="body2" color="text.secondary">
            训练模式 {TRAINING_MODE_LABELS[data.snapshot.trainingMode] ?? data.snapshot.trainingMode} · 题型{' '}
            {QUESTION_STYLE_LABELS[data.snapshot.questionStyle] ?? data.snapshot.questionStyle} · 复习节点{' '}
            {data.snapshot.intervalsDays.join(' / ')} 天
          </Typography>
        </Box>

        <Box sx={{ display: 'grid', gap: 1 }}>
          <Typography variant="subtitle1" component="h3">
            今日已学
          </Typography>
          <Typography variant="body1">
            已作答 {answered} 次{accuracy === null ? '' : ` · 正确率 ${accuracy}%`}
          </Typography>
        </Box>

        <TextField
          select
          size="small"
          label="学习词库"
          value={selectedDeck?.deckId ?? ''}
          onChange={(event) => setDeckId(event.target.value)}
          sx={{ maxWidth: 320 }}
        >
          {data.decks.map((deck) => (
            <MenuItem key={deck.deckId} value={deck.deckId}>
              {deck.name}（{deck.wordCount} 词）
            </MenuItem>
          ))}
        </TextField>

        {notice !== null ? <Alert severity="info">{notice}</Alert> : null}

        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button
            variant="contained"
            onClick={() => void start()}
            disabled={starting}
            sx={{ minHeight: 44 }}
          >
            {starting ? '正在准备…' : '开始学习'}
          </Button>
          <Button variant="outlined" onClick={() => navigate('/library')}>
            管理词库
          </Button>
        </Box>
      </Box>
    </PageShell>
  );
}
