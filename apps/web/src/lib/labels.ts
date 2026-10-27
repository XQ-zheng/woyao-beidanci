/** 界面文案映射：把服务层枚举翻成中文，避免各页面各写一份。 */

/** 词频重要性；`UNKNOWN` 返回 `null`——**不展示**，不把“未知”当“低频”。 */
export function frequencyLabel(importance: 'HIGH' | 'MEDIUM' | 'BASIC' | 'UNKNOWN'): string | null {
  switch (importance) {
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

/** 词库种类。 */
export function deckKindLabel(kind: 'BUILTIN' | 'CUSTOM' | 'NOTEBOOK'): string {
  switch (kind) {
    case 'BUILTIN':
      return '内置';
    case 'CUSTOM':
      return '自建';
    case 'NOTEBOOK':
      return '生词本';
  }
}

/** 训练模式。 */
export function trainingModeLabel(mode: string): string {
  const labels: Readonly<Record<string, string>> = {
    MIXED: '双向混合',
    EN_TO_ZH: '英译中',
    ZH_TO_EN: '中译英',
  };
  return labels[mode] ?? mode;
}

/** 题型。 */
export function questionStyleLabel(style: string): string {
  const labels: Readonly<Record<string, string>> = {
    CHOICE: '选择题',
    REVEAL: '自评回忆',
  };
  return labels[style] ?? style;
}

/** 评估等级；`INSUFFICIENT_SAMPLE` 单独说明，不给分数排名。 */
export function assessmentLevelLabel(level: string): string {
  const labels: Readonly<Record<string, string>> = {
    STABLE: '稳定',
    SOLID: '扎实',
    BUILDING: '积累中',
    NEEDS_WORK: '需要加强',
    INSUFFICIENT_SAMPLE: '样本不足',
  };
  return labels[level] ?? level;
}

/**
 * 把毫秒折成可读时长。
 *
 * @param milliseconds 毫秒。
 * @returns 形如 `2 分 5 秒` / `42 秒`。
 */
export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

/**
 * 把 UTC ISO 时刻按本地时区显示为 `YYYY-MM-DD HH:mm`。
 *
 * @param iso UTC ISO 毫秒串。
 * @param timeZone IANA 时区。
 * @returns 可读本地时间；非法输入原样返回。
 */
export function formatLocalDateTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}
