import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { ReactElement } from 'react';
import { useState } from 'react';
import type { DeckSummary, DeckWordView } from '@woyao/services';

import { useServiceData } from '../hooks/useServiceData';
import { deckKindLabel, frequencyLabel } from '../lib/labels';
import { useServices } from '../services/ServiceProvider';
import ImportWordsDialog from './ImportWordsDialog';
import { PageShell } from './PageShell';

/** 一个义项的编辑草稿。 */
interface SenseDraft {
  readonly senseNo: number;
  readonly pos: string;
  readonly simpleZh: string;
  readonly detailedZh: string;
}

/** 把异常压成可展示的一句话。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 词库页（`/library`）：列出词库、新建自建词库、查看词表、软删除。
 *
 * 生词本是 `kind === 'NOTEBOOK'` 的系统词库，有独立页面（`/notebook`），这里不重复展示。
 */
export default function LibraryPage(): ReactElement {
  const services = useServices();
  const [selectedDeckId, setSelectedDeckId] = useState<string | null>(null);
  const [expandedWordId, setExpandedWordId] = useState<string | null>(null);
  const [newDeckName, setNewDeckName] = useState('');
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  /** 展开词条的释义编辑草稿（按 wordId 存）。 */
  const [senseDrafts, setSenseDrafts] = useState<Record<string, readonly SenseDraft[]>>({});
  /** 正在保存释义的词条 id。 */
  const [savingSense, setSavingSense] = useState<string | null>(null);
  /** 刚保存成功的词条 id。 */
  const [senseSaved, setSenseSaved] = useState<string | null>(null);

  const decks = useServiceData('decks', (service) => service.library.listDecks());
  const visibleDecks: readonly DeckSummary[] = (decks.data ?? []).filter(
    (deck) => deck.kind !== 'NOTEBOOK',
  );
  const activeDeckId = selectedDeckId ?? visibleDecks[0]?.deckId ?? null;
  const activeDeck = visibleDecks.find((deck) => deck.deckId === activeDeckId) ?? null;

  const words = useServiceData(`words:${activeDeckId ?? 'none'}`, (service) =>
    activeDeckId === null ? Promise.resolve([]) : service.library.listDeckWords({ deckId: activeDeckId }),
  );

  if (services === null) {
    return <PageShell title="词库" headingId="library-page-heading" />;
  }
  const activeServices = services;

  async function createDeck(): Promise<void> {
    const name = newDeckName.trim();
    if (name.length === 0) {
      setActionError('请先填写词库名称。');
      return;
    }
    setBusy(true);
    setActionError(null);
    setMessage(null);
    try {
      const deck = await activeServices.library.createDeck({ name });
      setNewDeckName('');
      setSelectedDeckId(deck.deckId);
      setMessage(`已创建词库「${deck.name}」。`);
      decks.reload();
    } catch (cause: unknown) {
      setActionError(`创建词库失败：${describeError(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteDeck(deckId: string): Promise<void> {
    if (pendingDeleteId !== deckId) {
      setPendingDeleteId(deckId);
      setMessage(null);
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await activeServices.library.deleteDeck(deckId);
      setPendingDeleteId(null);
      setSelectedDeckId(null);
      setMessage('词库已删除（词与历史记录仍保留在本地）。');
      decks.reload();
    } catch (cause: unknown) {
      setActionError(`删除词库失败：${describeError(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  /** 展开词条时用当前释义初始化编辑草稿。 */
  function beginEdit(word: DeckWordView): void {
    setSenseDrafts((previous) => ({
      ...previous,
      [word.wordId]: word.senses.map((sense) => ({
        senseNo: sense.senseNo,
        pos: sense.pos,
        simpleZh: sense.simpleZh,
        detailedZh: sense.detailedZh ?? '',
      })),
    }));
    setSenseSaved(null);
    setActionError(null);
  }

  /** 修改草稿中的一个字段。 */
  function updateDraft(wordId: string, index: number, patch: Partial<SenseDraft>): void {
    setSenseDrafts((previous) => {
      const drafts = previous[wordId];
      if (drafts === undefined) {
        return previous;
      }
      const next = drafts.map((draft, i) => (i === index ? { ...draft, ...patch } : draft));
      return { ...previous, [wordId]: next };
    });
  }

  /** 保存词条的全部义项（逐条更新，全部成功才算完成）。 */
  async function saveSenses(word: DeckWordView): Promise<void> {
    const drafts = senseDrafts[word.wordId];
    if (drafts === undefined) {
      return;
    }
    for (const [index, draft] of drafts.entries()) {
      if (draft.simpleZh.trim().length === 0) {
        setActionError(`第 ${index + 1} 条义项的简明释义不能为空。`);
        return;
      }
    }
    setSavingSense(word.wordId);
    setSenseSaved(null);
    setActionError(null);
    try {
      for (const draft of drafts) {
        await activeServices.library.updateWordSense({
          wordId: word.wordId,
          senseNo: draft.senseNo,
          pos: draft.pos.trim(),
          simpleZh: draft.simpleZh.trim(),
          detailedZh: draft.detailedZh.trim() === '' ? null : draft.detailedZh.trim(),
        });
      }
      setSenseSaved(word.wordId);
      words.reload();
    } catch (cause: unknown) {
      setActionError(`保存释义失败：${describeError(cause)}`);
    } finally {
      setSavingSense(null);
    }
  }

  return (
    <PageShell title="词库" headingId="library-page-heading">
      <Box sx={{ display: 'grid', gap: 2, maxWidth: 960 }}>
        {message !== null ? <Alert severity="success">{message}</Alert> : null}
        {actionError !== null ? <Alert severity="error">{actionError}</Alert> : null}

        <Box
          sx={{
            display: 'grid',
            gap: 2,
            gridTemplateColumns: { xs: '1fr', md: '260px 1fr' },
            alignItems: 'start',
          }}
        >
          <Box sx={{ display: 'grid', gap: 1 }}>
            <Typography variant="subtitle1" component="h3">
              我的词库
            </Typography>

            {decks.loading ? (
              <CircularProgress size={20} aria-label="正在加载词库" />
            ) : decks.error !== null ? (
              <Alert severity="error">{decks.error}</Alert>
            ) : visibleDecks.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                还没有词库。新建一个自建词库，或到“导入”能力接入后导入四级/六级/考研词表。
              </Typography>
            ) : (
              <List dense aria-label="词库列表">
                {visibleDecks.map((deck) => (
                  <ListItemButton
                    key={deck.deckId}
                    selected={deck.deckId === activeDeckId}
                    onClick={() => {
                      setSelectedDeckId(deck.deckId);
                      setExpandedWordId(null);
                      setPendingDeleteId(null);
                    }}
                  >
                    <ListItemText
                      primary={deck.name}
                      secondary={`${deckKindLabel(deck.kind)} · ${deck.wordCount} 词`}
                    />
                  </ListItemButton>
                ))}
              </List>
            )}

            <Divider sx={{ my: 1 }} />

            <TextField
              size="small"
              label="新词库名称"
              value={newDeckName}
              onChange={(event) => setNewDeckName(event.target.value)}
            />
            <Button variant="contained" onClick={() => void createDeck()} disabled={busy}>
              新建自建词库
            </Button>
          </Box>

          <Box sx={{ display: 'grid', gap: 1.5 }}>
            {activeDeck === null ? (
              <Typography variant="body1">先选择一个词库查看词表。</Typography>
            ) : (
              <>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                  <Typography variant="h6" component="h3">
                    {activeDeck.name}
                  </Typography>
                  <Chip size="small" variant="outlined" label={deckKindLabel(activeDeck.kind)} />
                  <Typography variant="body2" color="text.secondary">
                    共 {activeDeck.wordCount} 词
                  </Typography>
                  <Box sx={{ flex: 1 }} />
                  <Button
                    size="small"
                    variant="contained"
                    disabled={busy}
                    onClick={() => setImportOpen(true)}
                  >
                    导入单词
                  </Button>
                  <Button
                    size="small"
                    color="error"
                    variant="outlined"
                    disabled={busy}
                    onClick={() => void deleteDeck(activeDeck.deckId)}
                  >
                    {pendingDeleteId === activeDeck.deckId ? '确认删除' : '删除词库'}
                  </Button>
                </Box>

                {words.loading ? (
                  <CircularProgress size={20} aria-label="正在加载词表" />
                ) : words.error !== null ? (
                  <Alert severity="error">{words.error}</Alert>
                ) : (words.data ?? []).length === 0 ? (
                  <Box sx={{ display: 'grid', gap: 1.5 }}>
                    <Typography variant="body1" color="text.secondary">
                      这个词库还没有单词。点「导入单词」把英文单词/短语加进来。
                    </Typography>
                    <Box>
                      <Button
                        size="small"
                        variant="contained"
                        disabled={busy}
                        onClick={() => setImportOpen(true)}
                      >
                        导入单词
                      </Button>
                    </Box>
                  </Box>
                ) : (
                  <List dense aria-label="词表">
                    {(words.data ?? []).map((word) => {
                      const importance = frequencyLabel(word.frequency.importance);
                      const expanded = expandedWordId === word.wordId;
                      const noDefinition =
                        word.senses.length === 0 ||
                        word.senses.every((sense) => sense.simpleZh === '（暂无释义）');
                      return (
                        <Box key={word.wordId} component="li" sx={{ listStyle: 'none' }}>
                          <ListItemButton
                            onClick={() => {
                              setExpandedWordId(expanded ? null : word.wordId);
                              if (!expanded) {
                                beginEdit(word);
                              }
                            }}
                            aria-expanded={expanded}
                            title="单击展开释义，可直接编辑后保存"
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
                                  {noDefinition ? (
                                    <Chip
                                      size="small"
                                      color="warning"
                                      variant="outlined"
                                      label="暂无释义"
                                    />
                                  ) : null}
                                </Box>
                              }
                              secondary={
                                noDefinition
                                  ? '（暂无释义）— 单击展开可直接编辑补全'
                                  : word.senses.map((sense) => sense.simpleZh).join('；')
                              }
                            />
                          </ListItemButton>
                          {expanded ? (
                            <Box sx={{ pl: 2, pr: 2, pb: 2, display: 'grid', gap: 1.5 }}>
                              <Typography variant="body2" color="text.secondary">
                                下方释义可直接修改，改完点「保存修改」立即生效。
                              </Typography>
                              {(senseDrafts[word.wordId] ?? []).map((draft, index) => (
                                <Box key={draft.senseNo} sx={{ display: 'grid', gap: 1 }}>
                                  <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                                    <Typography variant="body2" color="text.secondary">
                                      义项 {index + 1}
                                    </Typography>
                                    <TextField
                                      size="small"
                                      label="词性"
                                      value={draft.pos}
                                      onChange={(event) =>
                                        updateDraft(word.wordId, index, { pos: event.target.value })
                                      }
                                      sx={{ width: 120 }}
                                    />
                                  </Box>
                                  <TextField
                                    size="small"
                                    label="简明释义"
                                    value={draft.simpleZh}
                                    onChange={(event) =>
                                      updateDraft(word.wordId, index, { simpleZh: event.target.value })
                                    }
                                  />
                                  <TextField
                                    size="small"
                                    label="详细解释（可选）"
                                    value={draft.detailedZh}
                                    onChange={(event) =>
                                      updateDraft(word.wordId, index, { detailedZh: event.target.value })
                                    }
                                    multiline
                                    minRows={2}
                                  />
                                </Box>
                              ))}
                              <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center' }}>
                                <Button
                                  size="small"
                                  variant="contained"
                                  onClick={() => void saveSenses(word)}
                                  disabled={savingSense === word.wordId}
                                >
                                  {savingSense === word.wordId ? '正在保存…' : '保存修改'}
                                </Button>
                                {senseSaved === word.wordId ? (
                                  <Typography variant="body2" color="success.main">
                                    已保存。
                                  </Typography>
                                ) : null}
                              </Box>
                            </Box>
                          ) : null}
                        </Box>
                      );
                    })}
                  </List>
                )}
              </>
            )}
          </Box>
        </Box>
      </Box>

      {activeDeck !== null ? (
        <ImportWordsDialog
          open={importOpen}
          deckId={activeDeck.deckId}
          deckName={activeDeck.name}
          onClose={() => setImportOpen(false)}
          onImported={() => {
            decks.reload();
            words.reload();
          }}
        />
      ) : null}
    </PageShell>
  );
}
