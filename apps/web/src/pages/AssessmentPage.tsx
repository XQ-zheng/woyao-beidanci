import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { ReactElement } from 'react';
import { useRef, useState } from 'react';

import { useServiceData } from '../hooks/useServiceData';
import { assessmentLevelLabel, formatLocalDateTime } from '../lib/labels';
import { useServices } from '../services/ServiceProvider';
import { PageShell } from './PageShell';

/** AssessmentPage 入参（`now` 可注入，测试用固定时钟）。 */
export interface AssessmentPageProps {
  readonly now?: () => Date;
}

/**
 * 水平评估（`/assessment`）：分数、等级、覆盖率、置信度与 core 给出的建议。
 *
 * 样本不足时**不显示分数**——`score` 在无样本时是 0，直接展示会被读成“零分”，
 * 而事实是“还没数据”。这类“看似有数、其实无意义”的数字必须挡住。
 */
export default function AssessmentPage({ now = (): Date => new Date() }: AssessmentPageProps): ReactElement {
  const services = useServices();
  const nowRef = useRef(now);
  nowRef.current = now;
  const [selectedDeckId, setSelectedDeckId] = useState<string | null>(null);

  const decks = useServiceData('decks', (service) => service.library.listDecks());
  const visibleDecks = (decks.data ?? []).filter((deck) => deck.kind !== 'NOTEBOOK');
  const activeDeckId = selectedDeckId ?? visibleDecks[0]?.deckId ?? null;

  const assessment = useServiceData(`assessment:${activeDeckId ?? 'none'}`, (service) =>
    activeDeckId === null
      ? Promise.resolve(null)
      : service.report.getAssessment({ deckId: activeDeckId, now: nowRef.current() }),
  );

  if (services === null) {
    return <PageShell title="水平评估" headingId="assessment-page-heading" />;
  }

  const view = assessment.data;
  const insufficient = view === null || view.level === 'INSUFFICIENT_SAMPLE';
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <PageShell title="水平评估" headingId="assessment-page-heading">
      <Box sx={{ display: 'grid', gap: 2, maxWidth: 680 }}>
        {visibleDecks.length > 1 ? (
          <TextField
            select
            size="small"
            label="词库"
            value={activeDeckId ?? ''}
            onChange={(event) => setSelectedDeckId(event.target.value)}
            sx={{ maxWidth: 280 }}
          >
            {visibleDecks.map((deck) => (
              <MenuItem key={deck.deckId} value={deck.deckId}>
                {deck.name}
              </MenuItem>
            ))}
          </TextField>
        ) : null}

        {assessment.loading ? (
          <CircularProgress size={20} aria-label="正在计算评估" />
        ) : assessment.error !== null ? (
          <Alert severity="error">{assessment.error}</Alert>
        ) : visibleDecks.length === 0 ? (
          <Typography variant="body1" color="text.secondary">
            还没有可评估的词库。先在词库页建一个词库并学几个词。
          </Typography>
        ) : view === null ? (
          <Typography variant="body1" color="text.secondary">
            暂时没有评估结果。
          </Typography>
        ) : (
          <>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <Typography variant="h4" component="p" aria-label="综合得分">
                {insufficient ? '—' : view.score}
              </Typography>
              <Chip
                variant="outlined"
                color={insufficient ? 'default' : 'primary'}
                label={assessmentLevelLabel(view.level)}
              />
              <Typography variant="body2" color="text.secondary">
                覆盖率 {Math.round(view.coverage * 100)}% · 置信度 {Math.round(view.confidence * 100)}%
              </Typography>
            </Box>

            {insufficient ? (
              <Alert severity="info">
                样本不足，暂不给分数。评估需要足够的作答记录：目前窗口内有效作答 {view.validAnswers} 次、涉及{' '}
                {view.distinctWords} 个词。
              </Alert>
            ) : null}

            <Typography variant="body2" color="text.secondary">
              分析窗口：{formatLocalDateTime(view.windowStart, timeZone)} 至{' '}
              {formatLocalDateTime(view.windowEnd, timeZone)} · 算法版本 {view.algorithmVersion}
            </Typography>

            <Box sx={{ display: 'grid', gap: 0.5 }}>
              <Typography variant="subtitle1" component="h3">
                建议
              </Typography>
              {view.suggestions.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  暂无建议。
                </Typography>
              ) : (
                <Box component="ul" sx={{ m: 0, pl: 3 }}>
                  {view.suggestions.map((suggestion) => (
                    <Typography component="li" variant="body2" key={suggestion}>
                      {suggestion}
                    </Typography>
                  ))}
                </Box>
              )}
            </Box>
          </>
        )}
      </Box>
    </PageShell>
  );
}
