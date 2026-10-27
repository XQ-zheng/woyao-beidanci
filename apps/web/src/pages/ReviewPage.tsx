import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import type { ReactElement } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { SessionSummary } from '@woyao/services';

import { PageShell } from './PageShell';

/** 完成页入参（由 StudyPage 在 `finishSession` 后写入 `location.state.summary`）。 */
export interface ReviewLocationState {
  readonly summary?: SessionSummary;
}

/**
 * 把毫秒时长折成可读文本（不足 1 分钟按秒）。
 *
 * @param milliseconds 毫秒时长。
 * @returns 形如 `2 分 5 秒` / `42 秒`。
 */
function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes} 分 ${seconds} 秒`;
  }
  return `${seconds} 秒`;
}

/** 一行统计（术语用 `dl/dt/dd`，读屏能读出“指标名 + 数值”的对应关系）。 */
function StatRow({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
      <Typography component="dt" variant="body2" color="text.secondary" sx={{ minWidth: 72 }}>
        {label}
      </Typography>
      <Typography component="dd" variant="h6" sx={{ m: 0 }}>
        {value}
      </Typography>
    </Box>
  );
}

/**
 * 完成页（`/review`）：展示本次会话的真实汇总（新词数、复习数、学习时长、答对数）。
 * 数字全部来自 `finishSession` 返回的 `SessionSummary`，不在前端估算。
 */
export default function ReviewPage(): ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const summary = (location.state as ReviewLocationState | null)?.summary;

  return (
    <PageShell title="学习完成" headingId="review-page-heading">
      {summary === undefined ? (
        <>
          <Typography variant="body1">没有可展示的学习记录，请返回今日学习。</Typography>
          <Box>
            <Button variant="contained" onClick={() => navigate('/today')}>
              返回今日学习
            </Button>
          </Box>
        </>
      ) : (
        <Box sx={{ display: 'grid', gap: 2, maxWidth: 480 }}>
          <Typography variant="body1">本次学习已完成，记录已保存到本地。</Typography>
          <Box component="dl" sx={{ display: 'grid', gap: 1, m: 0 }}>
            <Box data-testid="summary-new-count">
              <StatRow label="新词数" value={String(summary.newCount)} />
            </Box>
            <Box data-testid="summary-review-count">
              <StatRow label="复习数" value={String(summary.reviewCount)} />
            </Box>
            <Box data-testid="summary-duration">
              <StatRow label="学习时长" value={formatDuration(summary.activeDurationMs)} />
            </Box>
            <Box data-testid="summary-correct">
              <StatRow label="答对" value={`${summary.correctCount} / ${summary.totalAnswers}`} />
            </Box>
          </Box>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            <Button variant="contained" onClick={() => navigate('/today')}>
              返回今日学习
            </Button>
            <Button variant="outlined" onClick={() => navigate('/history')}>
              查看历史
            </Button>
          </Box>
        </Box>
      )}
    </PageShell>
  );
}
