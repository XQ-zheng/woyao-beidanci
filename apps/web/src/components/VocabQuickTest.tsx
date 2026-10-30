import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';

/** 一次自测的抽词数（50 词约 5–10 分钟，符合用户要求的时长与题量上限）。 */
const SAMPLE_SIZE = 50;

/** 自测时间上限（毫秒）：到时自动结算，避免无限测试。 */
const TIME_LIMIT_MS = 10 * 60 * 1000;

/** 抽样词表（自测期间只给词形，答完才给释义）。 */
interface SampleWord {
  readonly lemma: string;
  readonly meaning: string;
}

/** 参考标准：目标考试 ↔ 建议掌握的词汇量（公认的大纲/备考经验值）。 */
const REFERENCE_STANDARDS: ReadonlyArray<{ label: string; vocabulary: number; note: string }> = [
  { label: '中考', vocabulary: 1600, note: '初中毕业水平' },
  { label: '高考', vocabulary: 3500, note: '高中毕业水平' },
  { label: '大学英语四级 425 分', vocabulary: 4500, note: '四级大纲词汇量' },
  { label: '大学英语六级 425 分', vocabulary: 6000, note: '六级大纲词汇量' },
  { label: '考研英语（一）60 分', vocabulary: 5500, note: '过线常用备考量' },
  { label: '考研英语（一）70 分', vocabulary: 6500, note: '中上水平' },
  { label: '雅思 6.5', vocabulary: 7000, note: '留学常用门槛' },
];

/** 抽样词库并集规模的估算值（四级+六级+考研去重后约 6500 词），用于把认识率折算成词汇量。 */
const POOL_ESTIMATE = 6500;

/**
 * 词汇量快速自测。
 *
 * 设计取舍：
 * - **限时限量**：50 词 / 10 分钟封顶，超时自动结算（用户明确要求「不能无限测试」）；
 * - **只判认识与否**：不考拼写/选择，符合「由系统提供单词，自己回答是否认识」的要求；
 * - **估算口径**：用内置四六级/考研词库并集抽样，认识率 × 词库规模，并对高认识率
 *   做上浮（样本只覆盖常用词，全认识的人实际词汇量高于词库规模），结果标注「估算」。
 *
 * @returns 自测面板（含参考标准表）。
 */
export function VocabQuickTest(): ReactElement {
  const [phase, setPhase] = useState<'idle' | 'testing' | 'done'>('idle');
  const [words, setWords] = useState<readonly SampleWord[]>([]);
  const [index, setIndex] = useState(0);
  const [knownCount, setKnownCount] = useState(0);
  const [unknownLemmas, setUnknownLemmas] = useState<readonly SampleWord[]>([]);
  const [remainingMs, setRemainingMs] = useState(TIME_LIMIT_MS);
  const [error, setError] = useState<string | null>(null);
  const deadlineRef = useRef<number>(0);

  // 倒计时：每 500ms 刷新，到 0 自动结算
  useEffect(() => {
    if (phase !== 'testing') {
      return;
    }
    const timer = window.setInterval(() => {
      const left = deadlineRef.current - Date.now();
      setRemainingMs(Math.max(0, left));
      if (left <= 0) {
        setPhase('done');
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [phase]);

  /** 从内置词库抽样开始自测。 */
  async function start(): Promise<void> {
    const bridge = (globalThis as { woyao?: { invoke(c: string, p?: unknown): Promise<unknown> } }).woyao;
    if (bridge === undefined) {
      setError('词汇量自测仅在桌面端可用。');
      return;
    }
    setError(null);
    try {
      const raw = (await bridge.invoke('assessment.sampleWords', { count: SAMPLE_SIZE })) as
        | { ok: true; data: readonly SampleWord[] }
        | { ok: false; error: { message: string } };
      if (!raw.ok) {
        throw new Error(raw.error.message);
      }
      if (raw.data.length === 0) {
        setError('没有可抽样的词库，请先在词库页导入常用词库。');
        return;
      }
      setWords(raw.data);
      setIndex(0);
      setKnownCount(0);
      setUnknownLemmas([]);
      setRemainingMs(TIME_LIMIT_MS);
      deadlineRef.current = Date.now() + TIME_LIMIT_MS;
      setPhase('testing');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  /** 记录「认识 / 不认识」并进入下一个词。 */
  function answer(known: boolean): void {
    const current = words[index];
    if (current === undefined) {
      return;
    }
    if (known) {
      setKnownCount((prev) => prev + 1);
    } else {
      setUnknownLemmas((prev) => [...prev, current]);
    }
    if (index + 1 >= words.length) {
      setPhase('done');
      return;
    }
    setIndex(index + 1);
  }

  /** 认识率 → 估算词汇量（>90% 时上浮，避免把「全认识」卡在词库规模上）。 */
  function estimateVocabulary(): number {
    if (words.length === 0) {
      return 0;
    }
    const rate = knownCount / words.length;
    const base = rate * POOL_ESTIMATE;
    // 认识率极高说明样本词表已不够测：按经验上浮（最高约 12000 词）
    const bonus = rate > 0.9 ? (rate - 0.9) * 10 * 6000 : 0;
    return Math.min(12000, Math.round((base + bonus) / 100) * 100);
  }

  const current = words[index];
  const answered = index + (phase === 'done' ? 1 : 0);
  const estimated = estimateVocabulary();

  return (
    <Box sx={{ display: 'grid', gap: 2, border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="subtitle1" component="h3">
          词汇量自测
        </Typography>
        <Chip size="small" variant="outlined" label={`${String(SAMPLE_SIZE)} 词 / ${String(TIME_LIMIT_MS / 60000)} 分钟`} />
      </Box>

      {phase === 'idle' ? (
        <>
          <Typography variant="body2" color="text.secondary">
            系统从内置四六级/考研词库里随机抽 {SAMPLE_SIZE} 个单词，你只需判断「认识 / 不认识」。
            限时 {TIME_LIMIT_MS / 60000} 分钟，结束后给出词汇量估算与达标参考。
          </Typography>
          <Box>
            <Button variant="contained" onClick={() => void start()}>
              开始自测
            </Button>
          </Box>
        </>
      ) : null}

      {phase === 'testing' && current !== undefined ? (
        <Box sx={{ display: 'grid', gap: 2, justifyItems: 'center' }}>
          <Box sx={{ width: '100%' }}>
            <LinearProgress variant="determinate" value={(answered / words.length) * 100} />
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              第 {index + 1} / {words.length} 词 · 剩余 {Math.ceil(remainingMs / 1000)} 秒
            </Typography>
          </Box>
          <Typography sx={{ fontSize: 48, fontWeight: 700, wordBreak: 'break-word', textAlign: 'center' }}>
            {current.lemma}
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, width: '100%', maxWidth: 480 }}>
            <Button
              variant="contained"
              color="success"
              onClick={() => answer(true)}
              sx={{ minHeight: 64, fontSize: 18, fontWeight: 700 }}
            >
              认识
            </Button>
            <Button
              variant="outlined"
              onClick={() => answer(false)}
              sx={{ minHeight: 64, fontSize: 18, fontWeight: 700, borderWidth: 2 }}
            >
              不认识
            </Button>
          </Box>
        </Box>
      ) : null}

      {phase === 'done' ? (
        <Box sx={{ display: 'grid', gap: 1.5 }}>
          <Alert severity="success">
            自测完成：共 {words.length} 词，认识 {knownCount} 个，估算词汇量约{' '}
            <strong>{estimated}</strong> 词（样本估算，供参考）。
          </Alert>
          {unknownLemmas.length > 0 ? (
            <Box>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                不认识的词（{unknownLemmas.length} 个，可对照释义复习）：
              </Typography>
              <Box sx={{ display: 'grid', gap: 0.5, maxHeight: 180, overflow: 'auto' }}>
                {unknownLemmas.map((word) => (
                  <Typography key={word.lemma} variant="body2">
                    <strong>{word.lemma}</strong>
                    {word.meaning === '' ? '' : ` — ${word.meaning}`}
                  </Typography>
                ))}
              </Box>
            </Box>
          ) : null}
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button variant="outlined" onClick={() => void start()}>
              再测一次
            </Button>
            <Button
              onClick={() => {
                setPhase('idle');
                setWords([]);
                setUnknownLemmas([]);
                setIndex(0);
                setKnownCount(0);
              }}
            >
              关闭
            </Button>
          </Box>
        </Box>
      ) : null}

      {error !== null ? <Alert severity="error">{error}</Alert> : null}

      <Box sx={{ borderTop: '1px solid', borderColor: 'divider', pt: 1.5 }}>
        <Typography variant="subtitle2" component="h4" sx={{ mb: 0.5 }}>
          词汇量参考标准
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          以下是各考试常见的目标词汇量（大纲/备考经验值，仅供对照）：
        </Typography>
        <Box component="ul" sx={{ m: 0, pl: 3, display: 'grid', gap: 0.25 }}>
          {REFERENCE_STANDARDS.map((standard) => (
            <li key={standard.label}>
              <Typography variant="body2">
                {standard.label}：约 <strong>{standard.vocabulary}</strong> 词（{standard.note}）
              </Typography>
            </li>
          ))}
        </Box>
      </Box>
    </Box>
  );
}
