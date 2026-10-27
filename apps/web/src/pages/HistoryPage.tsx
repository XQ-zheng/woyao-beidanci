import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import type { ReactElement } from 'react';
import { useRef } from 'react';
import { toLocalDateString } from '@woyao/services';

import { useServiceData } from '../hooks/useServiceData';
import { formatDuration, formatLocalDateTime } from '../lib/labels';
import { useServices } from '../services/ServiceProvider';
import { PageShell } from './PageShell';

/** 历史窗口天数（含今天）。 */
const WINDOW_DAYS = 14;

/** HistoryPage 入参（`now` 可注入，测试用固定时钟）。 */
export interface HistoryPageProps {
  readonly now?: () => Date;
}

/**
 * 历史页（`/history`）：最近 14 天的逐日统计 + 会话列表。
 *
 * 逐日统计与“本地日”都按设置里的时区折算（`toLocalDateString`），不用 UTC 日期，
 * 否则跨时区/跨零点会把学习记录算到错误的日期上。
 */
export default function HistoryPage({ now = (): Date => new Date() }: HistoryPageProps): ReactElement {
  const services = useServices();
  const nowRef = useRef(now);
  nowRef.current = now;

  const data = useServiceData('history:14d', async (service) => {
    const snapshot = await service.settings.getSnapshot();
    const today = nowRef.current();
    const dates: string[] = [];
    for (let offset = WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
      dates.push(toLocalDateString(new Date(today.getTime() - offset * 24 * 60 * 60 * 1000), snapshot.timeZone));
    }
    const fromLocalDate = dates[0] ?? toLocalDateString(today, snapshot.timeZone);
    const toLocalDate = dates[dates.length - 1] ?? fromLocalDate;
    const rows = await service.report.getDailyHistory({ fromLocalDate, toLocalDate });
    const sessions = await service.report.listSessions({
      fromIso: new Date(today.getTime() - (WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000).toISOString(),
      toIso: today.toISOString(),
    });
    return { snapshot, rows, sessions, fromLocalDate, toLocalDate };
  });

  if (services === null) {
    return <PageShell title="历史" headingId="history-page-heading" />;
  }

  const rows = data.data?.rows ?? [];
  const sessions = data.data?.sessions ?? [];
  const activeRows = rows.filter((row) => row.total > 0);
  const totalAnswers = rows.reduce((sum, row) => sum + row.total, 0);
  const totalDuration = rows.reduce((sum, row) => sum + row.activeMs, 0);

  return (
    <PageShell title="历史" headingId="history-page-heading">
      <Box sx={{ display: 'grid', gap: 2, maxWidth: 760 }}>
        {data.loading ? (
          <CircularProgress size={20} aria-label="正在加载历史" />
        ) : data.error !== null ? (
          <Alert severity="error">{data.error}</Alert>
        ) : (
          <>
            <Typography variant="body2" color="text.secondary">
              {data.data?.fromLocalDate} 至 {data.data?.toLocalDate}：共作答 {totalAnswers} 次，累计学习{' '}
              {formatDuration(totalDuration)}
            </Typography>

            <Box sx={{ display: 'grid', gap: 1 }}>
              <Typography variant="subtitle1" component="h3">
                每日统计
              </Typography>
              {activeRows.length === 0 ? (
                <Typography variant="body1" color="text.secondary">
                  这 14 天还没有学习记录。完成一次学习后，这里会按天汇总。
                </Typography>
              ) : (
                <List dense aria-label="每日统计">
                  {activeRows.map((row) => (
                    <ListItem key={row.localDate} divider>
                      <ListItemText
                        primary={row.localDate}
                        secondary={`作答 ${row.total} 次 · 正确 ${row.correct} · 错误 ${row.wrong} · 正确率 ${Math.round(
                          row.accuracy * 100,
                        )}% · ${formatDuration(row.activeMs)}`}
                      />
                    </ListItem>
                  ))}
                </List>
              )}
            </Box>

            <Divider />

            <Box sx={{ display: 'grid', gap: 1 }}>
              <Typography variant="subtitle1" component="h3">
                学习会话
              </Typography>
              {sessions.length === 0 ? (
                <Typography variant="body1" color="text.secondary">
                  还没有已结束的学习会话。
                </Typography>
              ) : (
                <List dense aria-label="学习会话">
                  {sessions.map((session) => (
                    <ListItem key={session.sessionId} divider>
                      <ListItemText
                        primary={`${formatLocalDateTime(
                          session.startedAt,
                          data.data?.snapshot.timeZone ?? 'UTC',
                        )}${session.endedAt === null ? '（未结束）' : ''}`}
                        secondary={`新词 ${session.newCount} · 复习 ${session.reviewCount} · 作答 ${session.totalAnswers} 次 · 答对 ${session.correctCount} · ${formatDuration(
                          session.activeDurationMs,
                        )}`}
                      />
                    </ListItem>
                  ))}
                </List>
              )}
            </Box>
          </>
        )}
      </Box>
    </PageShell>
  );
}
