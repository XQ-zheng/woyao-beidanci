import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Slider from '@mui/material/Slider';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  VOLUME_MAX,
  VOLUME_MIN,
  type SettingsSnapshot,
  type StudyWindowView,
} from '@woyao/services';
import type { TrainingMode } from '@woyao/core';

import { useServiceData } from '../hooks/useServiceData';
import DataLocationSection from '../components/DataLocationSection';
import { applyFontScale } from '../lib/fontScale';
import { questionStyleLabel, trainingModeLabel } from '../lib/labels';
import { useServices } from '../services/ServiceProvider';
import { PageShell } from './PageShell';

/** 每日上限的取值范围（与设置服务 schema 一致）。 */
const LIMIT_MIN = 0;
const LIMIT_MAX = 500;
/** 复习节点的取值范围（与 core 的 `ReviewPlan` 一致）。 */
const INTERVAL_MIN = 1;
const INTERVAL_MAX = 365;
const INTERVAL_COUNT_MAX = 12;

/** 把异常压成可展示的一句话。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 校验并解析整数输入；非法时返回 null。 */
function parseIntStrict(value: string): number | null {
  if (!/^-?\d+$/.test(value.trim())) {
    return null;
  }
  return Number.parseInt(value.trim(), 10);
}

/**
 * 把复习节点文本（`1,2,4` 或 `1 / 2 / 4`）解析成数字数组。
 *
 * @param value 用户输入。
 * @returns 成功返回数组，失败返回错误文案。
 */
function parseIntervals(value: string): number[] | string {
  const parts = value
    .split(/[,，/\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return '复习节点不能为空。';
  }
  if (parts.length > INTERVAL_COUNT_MAX) {
    return `复习节点最多 ${INTERVAL_COUNT_MAX} 个。`;
  }
  const numbers: number[] = [];
  for (const part of parts) {
    const parsed = parseIntStrict(part);
    if (parsed === null) {
      return `“${part}”不是整数。`;
    }
    if (parsed < INTERVAL_MIN || parsed > INTERVAL_MAX) {
      return `复习节点必须在 ${INTERVAL_MIN}–${INTERVAL_MAX} 天之间。`;
    }
    numbers.push(parsed);
  }
  for (let index = 1; index < numbers.length; index += 1) {
    if (numbers[index] <= numbers[index - 1]) {
      return '复习节点必须严格递增（例如 1,2,4,7,15,30）。';
    }
  }
  return numbers;
}

/** 设置页（`/settings`）：计划、学习偏好、外观、桌面行为与数据储存位置。 */
export default function SettingsPage(): ReactElement {
  const services = useServices();
  const snapshot = useServiceData('settings', (service) => service.settings.getSnapshot());
  const windows = useServiceData('study-windows', (service) => service.settings.listStudyWindows());
  // 数据位置属桌面能力，直接走 preload 桥（与 ImportWordsDialog 同一模式）。
  const bridge = (globalThis as { woyao?: { invoke(channel: string, payload?: unknown): Promise<unknown> } }).woyao ?? null;

  const [draft, setDraft] = useState<SettingsSnapshot | null>(null);
  const [intervalsText, setIntervalsText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 已保存的字号：离开设置页时用它还原，避免“预览了但没保存”的字号留在应用里。
  const savedFontScale = useRef(1);

  // 数据到达后灌入草稿（只灌一次，避免用户正在编辑时被后台刷新覆盖）。
  useEffect(() => {
    if (snapshot.data !== null && draft === null) {
      setDraft(snapshot.data);
      setIntervalsText(snapshot.data.intervalsDays.join(','));
      savedFontScale.current = snapshot.data.fontScale;
    }
  }, [snapshot.data, draft]);

  // 拖动滑块时即时预览；离开页面时还原成“已保存”的字号（可能是刚保存的新值）。
  useEffect(() => {
    applyFontScale(draft?.fontScale ?? 1);
    return () => {
      applyFontScale(savedFontScale.current);
    };
  }, [draft?.fontScale]);

  if (services === null) {
    return <PageShell title="设置" headingId="settings-page-heading" />;
  }

  if (snapshot.loading) {
    return (
      <PageShell title="设置" headingId="settings-page-heading">
        <CircularProgress size={20} aria-label="正在加载设置" />
      </PageShell>
    );
  }

  if (snapshot.error !== null) {
    return (
      <PageShell title="设置" headingId="settings-page-heading">
        <Alert severity="error">{snapshot.error}</Alert>
      </PageShell>
    );
  }

  if (draft === null) {
    return <PageShell title="设置" headingId="settings-page-heading" />;
  }
  const activeServices = services;

  /** 局部更新草稿。 */
  function update<K extends keyof SettingsSnapshot>(key: K, value: SettingsSnapshot[K]): void {
    setDraft((current) => (current === null ? current : { ...current, [key]: value }));
    setMessage(null);
  }

  async function save(): Promise<void> {
    if (draft === null) {
      return;
    }
    const intervals = parseIntervals(intervalsText);
    if (typeof intervals === 'string') {
      setError(`复习节点：${intervals}`);
      return;
    }
    for (const [label, value] of [
      ['每日新词上限', draft.dailyNewLimit],
      ['每日复习上限', draft.dailyReviewLimit],
    ] as const) {
      if (!Number.isInteger(value) || value < LIMIT_MIN || value > LIMIT_MAX) {
        setError(`${label}必须是 ${LIMIT_MIN}–${LIMIT_MAX} 的整数。`);
        return;
      }
    }

    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await activeServices.settings.update({
        dailyNewLimit: draft.dailyNewLimit,
        dailyReviewLimit: draft.dailyReviewLimit,
        trainingMode: draft.trainingMode,
        questionStyle: draft.questionStyle,
        accent: draft.accent,
        volume: draft.volume,
        fontScale: draft.fontScale,
        autoStart: draft.autoStart,
        minimizeToTray: draft.minimizeToTray,
      });
      const plan = await activeServices.settings.saveReviewPlan({
        dailyNewLimit: saved.dailyNewLimit,
        dailyReviewLimit: saved.dailyReviewLimit,
        intervalsDays: intervals,
        timeZone: saved.timeZone,
      });
      setDraft({ ...saved, intervalsDays: plan.intervalsDays });
      setIntervalsText(plan.intervalsDays.join(','));
      savedFontScale.current = saved.fontScale;
      setMessage('已保存。');
    } catch (cause: unknown) {
      setError(`保存失败：${describeError(cause)}`);
    } finally {
      setSaving(false);
    }
  }

  const studyWindows: readonly StudyWindowView[] = windows.data ?? [];

  return (
    <PageShell title="设置" headingId="settings-page-heading">
      <Box sx={{ display: 'grid', gap: 3, maxWidth: 640 }}>
        {message !== null ? <Alert severity="success">{message}</Alert> : null}
        {error !== null ? <Alert severity="error">{error}</Alert> : null}

        <Box sx={{ display: 'grid', gap: 1.5 }}>
          <Typography variant="subtitle1" component="h3">
            学习计划
          </Typography>
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            <TextField
              label="每日新词上限"
              type="number"
              size="small"
              value={String(draft.dailyNewLimit)}
              onChange={(event) => {
                const parsed = parseIntStrict(event.target.value);
                update('dailyNewLimit', parsed ?? 0);
              }}
              slotProps={{ htmlInput: { min: LIMIT_MIN, max: LIMIT_MAX } }}
              sx={{ width: 160 }}
            />
            <TextField
              label="每日复习上限"
              type="number"
              size="small"
              value={String(draft.dailyReviewLimit)}
              onChange={(event) => {
                const parsed = parseIntStrict(event.target.value);
                update('dailyReviewLimit', parsed ?? 0);
              }}
              slotProps={{ htmlInput: { min: LIMIT_MIN, max: LIMIT_MAX } }}
              sx={{ width: 160 }}
            />
          </Box>
          <TextField
            label="复习节点（天，逗号分隔）"
            size="small"
            value={intervalsText}
            onChange={(event) => {
              setIntervalsText(event.target.value);
              setMessage(null);
            }}
            helperText="必须严格递增，最多 12 个，例如 1,2,4,7,15,30"
          />
          <Typography variant="body2" color="text.secondary">
            时区：{draft.timeZone}（由系统提供，不在界面里手改，避免到期时间按错误的日历日计算）
          </Typography>
        </Box>

        <Divider />

        <Box sx={{ display: 'grid', gap: 1.5 }}>
          <Typography variant="subtitle1" component="h3">
            学习偏好
          </Typography>
          <TextField
            select
            size="small"
            label="训练模式"
            value={draft.trainingMode}
            onChange={(event) => update('trainingMode', event.target.value as TrainingMode)}
            sx={{ maxWidth: 240 }}
          >
            {(['MIXED', 'EN_TO_ZH', 'ZH_TO_EN'] as const).map((mode) => (
              <MenuItem key={mode} value={mode}>
                {trainingModeLabel(mode)}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label="题型"
            value={draft.questionStyle}
            onChange={(event) => update('questionStyle', event.target.value as 'CHOICE' | 'REVEAL')}
            sx={{ maxWidth: 240 }}
          >
            {(['CHOICE', 'REVEAL'] as const).map((style) => (
              <MenuItem key={style} value={style}>
                {questionStyleLabel(style)}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label="默认口音"
            value={draft.accent}
            onChange={(event) => update('accent', event.target.value as 'uk' | 'us')}
            sx={{ maxWidth: 240 }}
          >
            <MenuItem value="uk">英音</MenuItem>
            <MenuItem value="us">美音</MenuItem>
          </TextField>
        </Box>

        <Divider />

        <Box sx={{ display: 'grid', gap: 1.5 }}>
          <Typography variant="subtitle1" component="h3">
            外观与声音
          </Typography>
          <Box>
            <Typography variant="body2">字号缩放：{draft.fontScale.toFixed(1)}×</Typography>
            <Slider
              min={FONT_SCALE_MIN}
              max={FONT_SCALE_MAX}
              step={0.1}
              value={draft.fontScale}
              onChange={(_, value) => update('fontScale', typeof value === 'number' ? value : value[0])}
              aria-label="字号缩放"
            />
          </Box>
          <Box>
            <Typography variant="body2">音量：{Math.round(draft.volume * 100)}%</Typography>
            <Slider
              min={VOLUME_MIN}
              max={VOLUME_MAX}
              step={0.05}
              value={draft.volume}
              onChange={(_, value) => update('volume', typeof value === 'number' ? value : value[0])}
              aria-label="音量"
            />
          </Box>
        </Box>

        <Divider />

        <Box sx={{ display: 'grid', gap: 1 }}>
          <Typography variant="subtitle1" component="h3">
            桌面行为
          </Typography>
          <FormControlLabel
            control={
              <Switch
                checked={draft.autoStart}
                onChange={(event) => update('autoStart', event.target.checked)}
                slotProps={{ input: { 'aria-label': '开机自启' } }}
              />
            }
            label="开机自启"
          />
          <FormControlLabel
            control={
              <Switch
                checked={draft.minimizeToTray}
                onChange={(event) => update('minimizeToTray', event.target.checked)}
                slotProps={{ input: { 'aria-label': '关闭窗口时最小化到托盘' } }}
              />
            }
            label="关闭窗口时最小化到托盘"
          />
          <Typography variant="body2" color="text.secondary">
            这两项只在桌面端生效；网页预览里保存的是偏好，不会真的改系统的自启项。
          </Typography>
        </Box>

        <Divider />

        <DataLocationSection bridge={bridge} />

        <Divider />

        <Box sx={{ display: 'grid', gap: 1 }}>
          <Typography variant="subtitle1" component="h3">
            学习时段
          </Typography>
          {windows.loading ? (
            <CircularProgress size={18} aria-label="正在加载学习时段" />
          ) : windows.error !== null ? (
            <Alert severity="error">{windows.error}</Alert>
          ) : studyWindows.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              还没有设置学习时段。时段编辑与提醒会在桌面端接入后提供。
            </Typography>
          ) : (
            <Box component="ul" sx={{ m: 0, pl: 3 }}>
              {studyWindows.map((window) => (
                <Typography component="li" variant="body2" key={window.windowId}>
                  {window.effectiveLocalDate} · {String(Math.floor(window.startMinute / 60)).padStart(2, '0')}:
                  {String(window.startMinute % 60).padStart(2, '0')}–
                  {String(Math.floor(window.endMinute / 60)).padStart(2, '0')}:
                  {String(window.endMinute % 60).padStart(2, '0')}（{window.timeZone}）
                </Typography>
              ))}
            </Box>
          )}
        </Box>

        <Box>
          <Button variant="contained" onClick={() => void save()} disabled={saving} sx={{ minHeight: 44 }}>
            {saving ? '正在保存…' : '保存设置'}
          </Button>
        </Box>
      </Box>
    </PageShell>
  );
}
