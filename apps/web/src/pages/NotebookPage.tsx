import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import type { ReactElement } from 'react';
import { useState } from 'react';

import { useServiceData } from '../hooks/useServiceData';
import { frequencyLabel } from '../lib/labels';
import { useServices } from '../services/ServiceProvider';
import { PageShell } from './PageShell';

/** 把异常压成可展示的一句话。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 单词本（`/notebook`）。
 *
 * 生词本在数据层就是一个 `kind === 'NOTEBOOK'` 的系统词库，所以这里列出该词库的词，
 * 而不是另建一套“收藏表”——收藏与词库共用同一份真值，避免两处状态分叉。
 */
export default function NotebookPage(): ReactElement {
  const services = useServices();
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decks = useServiceData('decks', (service) => service.library.listDecks());
  const notebook = (decks.data ?? []).find((deck) => deck.kind === 'NOTEBOOK') ?? null;
  const words = useServiceData(`notebook:${notebook?.deckId ?? 'none'}`, (service) =>
    notebook === null ? Promise.resolve([]) : service.library.listDeckWords({ deckId: notebook.deckId }),
  );

  if (services === null) {
    return <PageShell title="单词本" headingId="notebook-page-heading" />;
  }
  const activeServices = services;

  async function remove(wordId: string): Promise<void> {
    if (services === null) {
      return;
    }
    setRemovingId(wordId);
    setError(null);
    try {
      await activeServices.library.removeWordFromNotebook(wordId);
      words.reload();
    } catch (cause: unknown) {
      setError(`移出单词本失败：${describeError(cause)}`);
    } finally {
      setRemovingId(null);
    }
  }

  const list = words.data ?? [];

  return (
    <PageShell title="单词本" headingId="notebook-page-heading">
      <Box sx={{ display: 'grid', gap: 2, maxWidth: 720 }}>
        <Typography variant="body2" color="text.secondary">
          {notebook === null
            ? '还没有生词本：在学习页点“收藏”时会自动创建。'
            : `共 ${list.length} 个词（数据来自本地生词本，不依赖云同步）。`}
        </Typography>

        {error !== null ? <Alert severity="error">{error}</Alert> : null}

        {decks.loading || words.loading ? (
          <CircularProgress size={20} aria-label="正在加载单词本" />
        ) : decks.error !== null ? (
          <Alert severity="error">{decks.error}</Alert>
        ) : words.error !== null ? (
          <Alert severity="error">{words.error}</Alert>
        ) : list.length === 0 ? (
          <Typography variant="body1" color="text.secondary">
            单词本还是空的。学习时点“收藏”，词就会出现在这里。
          </Typography>
        ) : (
          <List aria-label="单词本列表">
            {list.map((word) => {
              const importance = frequencyLabel(word.frequency.importance);
              return (
                <ListItem
                  key={word.wordId}
                  divider
                  secondaryAction={
                    <Button
                      size="small"
                      variant="outlined"
                      disabled={removingId === word.wordId}
                      onClick={() => void remove(word.wordId)}
                      aria-label={`移出单词本：${word.lemma}`}
                    >
                      移出
                    </Button>
                  }
                >
                  <ListItemText
                    primary={
                      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
                        <Typography component="span" variant="body1" sx={{ fontWeight: 600 }}>
                          {word.lemma}
                        </Typography>
                        {word.phoneticUk !== null ? (
                          <Typography component="span" variant="body2" color="text.secondary">
                            /{word.phoneticUk}/
                          </Typography>
                        ) : null}
                        {importance !== null ? (
                          <Chip size="small" variant="outlined" label={importance} />
                        ) : null}
                      </Box>
                    }
                    secondary={word.senses.map((sense) => sense.simpleZh).join('；')}
                  />
                </ListItem>
              );
            })}
          </List>
        )}
      </Box>
    </PageShell>
  );
}
