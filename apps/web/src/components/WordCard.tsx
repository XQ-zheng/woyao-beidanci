import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Slider from '@mui/material/Slider';
import Typography from '@mui/material/Typography';
import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import type { CardView } from '@woyao/services';

import { useServices } from '../services/ServiceProvider';
import { isChoiceCard } from './wordCardModel';

/** 词卡入参（作答状态由 StudyPage 编排）。 */
export interface WordCardProps {
  readonly card: CardView;
  /** CHOICE 已选中的选项；REVEAL（或退化题型）恒为 `null`。 */
  readonly selected: string | null;
  /** REVEAL 是否已显示答案。 */
  readonly revealed: boolean;
  /**
   * 是否锁定作答区（已提交/正在提交）。
   *
   * 锁定只影响“选项/显示答案”，工具栏（发音、音量、收藏、详解）仍然可用——
   * 已经提交后再改选项会造成“作答已记下、界面却还在变”的错觉。
   */
  readonly locked?: boolean;
  readonly onSelect: (option: string) => void;
  readonly onReveal: () => void;
}

/** 播放音频（jsdom/无音频设备环境下静默跳过播放本身，不影响学习流程）。 */
function tryPlay(url: string | null, volume: number): void {
  if (url === null) {
    return;
  }
  try {
    const AudioConstructor = (globalThis as { Audio?: typeof Audio }).Audio;
    if (typeof AudioConstructor === 'undefined') {
      return;
    }
    const audio = new AudioConstructor(url);
    audio.volume = volume;
    void audio.play().catch(() => undefined);
  } catch {
    // 播放失败不打断学习：音标始终可见，按钮状态已经说明音频是否可用。
  }
}

/** 词频标签；`UNKNOWN` 时不展示（不把“未知”当“低频”）。 */
function frequencyLabel(card: CardView): string | null {
  switch (card.frequency.importance) {
    case 'HIGH':
      return '高频';
    case 'MEDIUM':
      return '中频';
    case 'BASIC':
      return '基础';
    case 'UNKNOWN':
      return null;
  }
}

/** 把异常压成一句话；用于工具栏的可见失败提示（不静默吞掉真实服务错误）。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 词卡：词形、音标、题干、选项/答案、工具栏（英/美音、音量、收藏、详解）。
 * 工具栏全部经 `useServices()` 拿服务，不直接 import 具体实例。
 */
export function WordCard({
  card,
  selected,
  revealed,
  locked = false,
  onSelect,
  onReveal,
}: WordCardProps): ReactElement {
  const services = useServices();
  const [accent, setAccent] = useState<'uk' | 'us'>('uk');
  const [volume, setVolume] = useState(1);
  const [favorite, setFavorite] = useState(card.isFavorite);
  const [expanded, setExpanded] = useState(false);
  const [audioUrlUk, setAudioUrlUk] = useState<string | null>(null);
  const [audioUrlUs, setAudioUrlUs] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 初始加载：设置（音量/默认口音）、收藏态、英/美音频 URL。
  // URL 为 null 时对应按钮禁用，但音标始终按口音展示——发音缺失不能连音标一起消失。
  useEffect(() => {
    if (services === null) {
      return;
    }
    let active = true;
    setExpanded(false);
    setNotice(null);
    setFavorite(card.isFavorite);
    setAudioUrlUk(null);
    setAudioUrlUs(null);

    void services.settings
      .getSnapshot()
      .then((snapshot) => {
        if (!active) {
          return;
        }
        setVolume(snapshot.volume);
        setAccent(snapshot.accent);
      })
      .catch((error: unknown) => {
        if (active) {
          setNotice(`读取设置失败：${describeError(error)}`);
        }
      });

    void services.library
      .isInNotebook(card.wordId)
      .then((value) => {
        if (active) {
          setFavorite(value);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setNotice(`读取收藏状态失败：${describeError(error)}`);
        }
      });

    void services.content
      .getPronunciation({ wordId: card.wordId, accent: 'uk' })
      .then((result) => {
        if (active) {
          setAudioUrlUk(result.url);
        }
      })
      .catch(() => {
        // 音频查询失败按“无音频”处理：音标仍在，学习可继续。
        if (active) {
          setAudioUrlUk(null);
        }
      });

    void services.content
      .getPronunciation({ wordId: card.wordId, accent: 'us' })
      .then((result) => {
        if (active) {
          setAudioUrlUs(result.url);
        }
      })
      .catch(() => {
        if (active) {
          setAudioUrlUs(null);
        }
      });

    return () => {
      active = false;
    };
  }, [services, card.wordId, card.isFavorite]);

  if (services === null) {
    return <Typography variant="body1">数据服务未接入</Typography>;
  }

  async function switchAccent(next: 'uk' | 'us'): Promise<void> {
    setAccent(next);
    tryPlay(next === 'uk' ? audioUrlUk : audioUrlUs, volume);
    try {
      await services?.settings.update({ accent: next });
    } catch (error: unknown) {
      setNotice(`口音偏好保存失败：${describeError(error)}`);
    }
  }

  async function toggleFavorite(): Promise<void> {
    const next = !favorite;
    try {
      if (next) {
        await services?.library.addWordToNotebook(card.wordId);
      } else {
        await services?.library.removeWordFromNotebook(card.wordId);
      }
      setFavorite(next);
    } catch (error: unknown) {
      setNotice(`收藏操作失败：${describeError(error)}`);
    }
  }

  function changeVolume(value: number): void {
    setVolume(value);
    void services?.settings.update({ volume: value }).catch((error: unknown) => {
      setNotice(`音量保存失败：${describeError(error)}`);
    });
  }

  const phoneticText = accent === 'uk' ? card.phoneticUk : card.phoneticUs;
  const frequencyText = frequencyLabel(card);
  const choice = isChoiceCard(card);

  return (
    <Box component="article" aria-label="单词卡片" sx={{ display: 'grid', gap: 2 }}>
      {/* 词形 + 音标 + 词频 */}
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="h4" component="h3">
          {card.prompt}
        </Typography>
        {phoneticText !== null ? (
          <Typography variant="body1" color="text.secondary">
            /{phoneticText}/
          </Typography>
        ) : null}
        {frequencyText !== null ? <Chip label={frequencyText} size="small" variant="outlined" /> : null}
      </Box>

      {/* 工具栏：英音 / 美音 / 音量 / 收藏 / 详解 */}
      <Box
        component="div"
        role="toolbar"
        aria-label="单词工具栏"
        sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}
      >
        <Button
          size="small"
          variant={accent === 'uk' ? 'contained' : 'outlined'}
          disabled={audioUrlUk === null}
          onClick={() => void switchAccent('uk')}
          aria-label="英音"
        >
          英音
        </Button>
        <Button
          size="small"
          variant={accent === 'us' ? 'contained' : 'outlined'}
          disabled={audioUrlUs === null}
          onClick={() => void switchAccent('us')}
          aria-label="美音"
        >
          美音
        </Button>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            // 给滑块一个确定宽度：只写 minWidth 时 Slider 的绝对定位轨道会溢出工具栏，
            // 在真实浏览器里压到下方选项上（jsdom 不做布局，测不出来）。
            width: { xs: '100%', sm: 200 },
            maxWidth: 240,
          }}
        >
          <Typography variant="caption" sx={{ whiteSpace: 'nowrap' }}>
            音量
          </Typography>
          <Slider
            size="small"
            min={0}
            max={1}
            step={0.1}
            value={volume}
            onChange={(_, value) => changeVolume(typeof value === 'number' ? value : value[0])}
            aria-label="音量"
          />
        </Box>
        <Button
          size="small"
          variant={favorite ? 'contained' : 'outlined'}
          onClick={() => void toggleFavorite()}
          aria-label={favorite ? '取消收藏' : '收藏'}
          aria-pressed={favorite}
        >
          {favorite ? '已收藏' : '收藏'}
        </Button>
        <Button
          size="small"
          variant="outlined"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label="详解"
        >
          详解
        </Button>
      </Box>

      {notice !== null ? (
        <Typography variant="body2" color="error" role="status">
          {notice}
        </Typography>
      ) : null}

      {/* 题干交互区 */}
      {choice ? (
        <Box sx={{ display: 'grid', gap: 1 }}>
          {card.options.map((option) => (
            <Button
              key={option}
              variant={selected === option ? 'contained' : 'outlined'}
              onClick={() => onSelect(option)}
              disabled={locked}
              aria-pressed={selected === option}
              data-testid="word-option"
              sx={{ justifyContent: 'flex-start', textAlign: 'left' }}
            >
              {option}
            </Button>
          ))}
        </Box>
      ) : (
        <Box sx={{ display: 'grid', gap: 1 }}>
          {revealed ? (
            <Typography variant="h6" component="p" data-testid="revealed-answer">
              {card.answer}
            </Typography>
          ) : (
            <Button variant="contained" onClick={onReveal} disabled={locked}>
              显示答案
            </Button>
          )}
        </Box>
      )}

      {/* 详解展开区 */}
      {expanded ? (
        <Box
          component="section"
          aria-label="详解"
          sx={{ display: 'grid', gap: 1, borderTop: 1, borderColor: 'divider', pt: 1 }}
        >
          {card.senses.map((sense) => (
            <Box key={sense.senseNo} sx={{ display: 'grid', gap: 0.5 }}>
              <Typography variant="body2" color="text.secondary">
                {sense.senseNo}. {sense.pos}
              </Typography>
              <Typography variant="body1">{sense.simpleZh}</Typography>
              {sense.detailedZh !== null ? <Typography variant="body2">{sense.detailedZh}</Typography> : null}
              {sense.contextText !== null ? (
                <Typography variant="body2" color="text.secondary">
                  例：{sense.contextText}
                </Typography>
              ) : null}
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
