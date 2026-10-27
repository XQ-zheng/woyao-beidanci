import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { ReactElement } from 'react';
import { useState } from 'react';

import { useServiceData } from '../hooks/useServiceData';
import { formatLocalDateTime } from '../lib/labels';
import { useServices } from '../services/ServiceProvider';
import { PageShell } from './PageShell';

/** 错词列表一次最多取多少条（报表服务按累计错次降序）。 */
const MISTAKE_LIMIT = 200;

/** 错词页（`/mistakes`）：累计错次、最近错误时间与义项。 */
export default function MistakesPage(): ReactElement {
  const services = useServices();
  const [selectedDeckId, setSelectedDeckId] = useState<string | null>(null);

  const decks = useServiceData('decks', (service) => service.library.listDecks());
  const visibleDecks = (decks.data ?? []).filter((deck) => deck.kind !== 'NOTEBOOK');
  const activeDeckId = selectedDeckId ?? visibleDecks[0]?.deckId ?? null;

  const mistakes = useServiceData(`mistakes:${activeDeckId ?? 'none'}`, (service) =>
    activeDeckId === null
      ? Promise.resolve([])
      : service.report.getMistakes({ deckId: activeDeckId, limit: MISTAKE_LIMIT }),
  );

  if (services === null) {
    return <PageShell title="错词" headingId="mistakes-page-heading" />;
  }

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rows = mistakes.data ?? [];

  return (
    <PageShell title="错词" headingId="mistakes-page-heading">
      <Box sx={{ display: 'grid', gap: 2, maxWidth: 720 }}>
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

        {mistakes.loading ? (
          <CircularProgress size={20} aria-label="正在加载错词" />
        ) : mistakes.error !== null ? (
          <Alert severity="error">{mistakes.error}</Alert>
        ) : rows.length === 0 ? (
          <Typography variant="body1" color="text.secondary">
            这个词库还没有错词。答错过的词会按累计错次排在这里，方便集中攻克。
          </Typography>
        ) : (
          <List aria-label="错词列表">
            {rows.map((row) => (
              <ListItem key={row.userWordId} divider alignItems="flex-start">
                <ListItemText
                  primary={
                    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
                      <Typography component="span" variant="body1" sx={{ fontWeight: 600 }}>
                        {row.lemma}
                      </Typography>
                      <Chip size="small" color="error" variant="outlined" label={`错 ${row.wrongCount} 次`} />
                      <Typography component="span" variant="body2" color="text.secondary">
                        对 {row.correctCount} 次
                      </Typography>
                      {row.recentWrong ? <Chip size="small" variant="outlined" label="最近又错" /> : null}
                    </Box>
                  }
                  secondary={
                    <>
                      <Typography component="span" variant="body2">
                        {row.senses.map((sense) => sense.simpleZh).join('；')}
                      </Typography>
                      <Typography component="span" variant="body2" color="text.secondary" sx={{ display: 'block' }}>
                        最近答错：{formatLocalDateTime(row.lastWrongAt, timeZone)}
                      </Typography>
                    </>
                  }
                />
              </ListItem>
            ))}
          </List>
        )}
      </Box>
    </PageShell>
  );
}
