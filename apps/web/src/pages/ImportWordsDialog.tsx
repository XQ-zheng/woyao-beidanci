import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { ReactElement } from 'react';
import { useState } from 'react';
import type { ImportWordsResult } from '@woyao/services';

import { useServices } from '../services/ServiceProvider';

/** 把异常压成可展示的一句话。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 提取出的待导入条目。 */
interface PendingTerm {
  readonly lemma: string;
  readonly phrase: boolean;
}

/** preload 桥（用于文件选择/提取，不属于 Services 接口）。 */
interface Bridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
}

/** 导入弹窗属性。 */
interface ImportWordsDialogProps {
  readonly open: boolean;
  readonly deckId: string;
  readonly deckName: string;
  readonly onClose: () => void;
  /** 导入成功后回调（父组件据此刷新词表）。 */
  readonly onImported: () => void;
}

/** 导入方式页签。 */
type ImportMode = 'text' | 'file';

/**
 * 导入单词弹窗：手动输入英文单词/短语，或选择图片/文档自动识别。
 *
 * 流程：选择方式 → 得到待导入条目 → 预览 → 确认导入 → 显示报告。
 */
export default function ImportWordsDialog(props: ImportWordsDialogProps): ReactElement {
  const { open, deckId, deckName, onClose, onImported } = props;
  const services = useServices();

  const [mode, setMode] = useState<ImportMode>('text');
  const [textInput, setTextInput] = useState('');
  const [terms, setTerms] = useState<PendingTerm[]>([]);
  const [extractVia, setExtractVia] = useState<'document' | 'ocr' | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportWordsResult | null>(null);

  /** 拿 preload 桥（桌面端才有；浏览器模式返回 null）。 */
  function bridge(): Bridge | null {
    return (globalThis as { woyao?: Bridge }).woyao ?? null;
  }

  /** 从文本输入解析条目（每行一个单词或短语）。 */
  function parseTextInput(): PendingTerm[] {
    const out: PendingTerm[] = [];
    const seen = new Set<string>();
    for (const rawLine of textInput.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }
      // 一行里可能是「单词」或「单词 单词 单词」短语；这里按「整行作为一个条目」，
      // 但把行内多余空格折叠。整行超过 4 个英文词则跳过（避免误粘贴整段句子）。
      const words = line.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/gu) ?? [];
      if (words.length === 0 || words.length > 4) {
        continue;
      }
      const lemma = line.replace(/\s+/gu, ' ').trim();
      const key = lemma.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({ lemma, phrase: words.length > 1 });
    }
    return out;
  }

  async function handleTextParse(): Promise<void> {
    const parsed = parseTextInput();
    if (parsed.length === 0) {
      setError('没有识别到有效的英文单词或短语（每行一个，单词或 2-4 词短语）。');
      return;
    }
    setError(null);
    setResult(null);
    setTerms(parsed);
    setExtractVia(null);
  }

  async function handlePickFile(): Promise<void> {
    if (services === null) {
      setError('数据服务未接入，无法导入。');
      return;
    }
    const bridgeApi = bridge();
    if (bridgeApi === null) {
      setError('当前环境不支持文件导入（需在桌面端使用）。');
      return;
    }
    setError(null);
    setResult(null);
    setExtracting(true);
    try {
      const picked = (await bridgeApi.invoke('import.pickFile')) as string | null;
      if (picked === null) {
        setExtracting(false);
        return; // 用户取消
      }
      const extracted = (await bridgeApi.invoke('import.extractFile', { filePath: picked })) as {
        terms: PendingTerm[];
        via: 'document' | 'ocr';
        enhanced?: boolean;
      };
      if (extracted.terms.length === 0) {
        setError('没有从该文件里识别到英文单词（可能是空文件或纯图片里没有英文）。');
        return;
      }
      setTerms(extracted.terms);
      setExtractVia(extracted.via);
    } catch (cause: unknown) {
      setError(`读取文件失败：${describeError(cause)}`);
    } finally {
      setExtracting(false);
    }
  }

  async function handleImport(): Promise<void> {
    if (services === null || terms.length === 0) {
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const report = await services.import.importWords({
        deckId,
        terms: terms.map((term) => ({ lemma: term.lemma, phrase: term.phrase })),
      });
      setResult(report);
      setTerms([]);
      setTextInput('');
      onImported();
    } catch (cause: unknown) {
      setError(`导入失败：${describeError(cause)}`);
    } finally {
      setImporting(false);
    }
  }

  function handleClose(): void {
    setTerms([]);
    setTextInput('');
    setResult(null);
    setError(null);
    setExtractVia(null);
    onClose();
  }

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>导入单词到「{deckName}」</DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, pt: 2 }}>
        <Tabs
          value={mode}
          onChange={(_, value: string) => {
            if (value === 'text' || value === 'file') {
              setMode(value);
              setError(null);
            }
          }}
          aria-label="导入方式"
        >
          <Tab value="text" label="手动输入" />
          <Tab value="file" label="图片 / 文档" />
        </Tabs>

        {mode === 'text' ? (
          <Box sx={{ display: 'grid', gap: 1.5 }}>
            <TextField
              multiline
              minRows={6}
              label="每行一个单词或短语"
              value={textInput}
              onChange={(event) => setTextInput(event.target.value)}
              placeholder={'abandon\ngive up\nlook forward to'}
              helperText="每行一个英文单词或 2-4 词的短语；重复项自动去重，释义会从内置词典自动补全。"
            />
            <Box>
              <Button variant="outlined" onClick={() => void handleTextParse()}>
                解析并预览
              </Button>
            </Box>
          </Box>
        ) : (
          <Box sx={{ display: 'grid', gap: 1.5 }}>
            <Typography variant="body2" color="text.secondary">
              选择图片（自动 OCR 识别英文单词/短语）或文档（Excel / Word / PDF / PPT / 文本），
              应用会自动提取里面的所有英文单词。
            </Typography>
            <Box>
              <Button variant="outlined" onClick={() => void handlePickFile()} disabled={extracting}>
                {extracting ? '正在读取并识别…' : '选择文件'}
              </Button>
            </Box>
          </Box>
        )}

        {extractVia !== null && terms.length > 0 ? (
          <Alert severity="info">
            已从{extractVia === 'ocr' ? '图片' : '文档'}识别到 {terms.length} 个英文条目，请在下方确认后导入。
          </Alert>
        ) : null}

        {error !== null ? <Alert severity="error">{error}</Alert> : null}

        {terms.length > 0 ? (
          <Box>
            <Typography variant="subtitle2" component="h3" sx={{ mb: 1 }}>
              待导入（{terms.length} 条）
            </Typography>
            <Box sx={{ maxHeight: 240, overflow: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
              <List dense>
                {terms.map((term) => (
                  <ListItem key={term.lemma.toLowerCase()} divider>
                    <ListItemText primary={term.lemma} secondary={term.phrase ? '短语' : '单词'} />
                  </ListItem>
                ))}
              </List>
            </Box>
          </Box>
        ) : null}

        {result !== null ? (
          <Alert severity="success">
            导入完成：新增 {result.imported} 个，重复 {result.duplicates} 个，已补释义 {result.withDefinition} 个，
            暂无释义 {result.withoutDefinition} 个。
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={importing}>
          关闭
        </Button>
        <Button
          variant="contained"
          onClick={() => void handleImport()}
          disabled={terms.length === 0 || importing || services === null}
        >
          {importing ? '正在导入…' : `导入 ${terms.length > 0 ? `${terms.length} 个词` : ''}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
