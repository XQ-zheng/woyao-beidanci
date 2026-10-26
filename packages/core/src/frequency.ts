/**
 * 考研词频 → 重要性的公开分级（设计 8）。
 *
 * 原则：
 * - `frequency` 是数据集里该词在指定语料版本中的**原始出现次数**，不是模型估计；
 * - 只对 `frequency > 0`、且来源与版本完整、词形已可靠映射的词分级；
 * - 百分位只在该版本**有频率词条集合**内计算：`percentile = (less + 0.5*equal) / knownWordCount`；
 * - 阈值：`P90–P100 = 高`、`P60–<P90 = 中`、`P0–<P60 = 基础`；
 * - 无记录、频次为 0、来源/版本缺失或词形无法映射时一律 `UNKNOWN`，
 *   **绝不把“未知”当成低频**（那会把未导入的词误标成“基础词”）。
 *
 * 关于 `less` / `equal`：本层拿到的只有单个词条与“有频率词条总数”，
 * 因此用该词条的降序名次 `rank`（1 = 该版本中频次最高）与并列组大小 `equalCount` 折算：
 * `less = knownWordCount - rank - (equalCount - 1)`，`equal = equalCount`（默认 1，即无并列）。
 *
 * 并列必须如实记录：若把并列组自身算进 `less`（`equal` 恒为 1），
 * 百分位会被**抬高** `(equal-1)*0.5/n`，把 P60–P90 的词误判为高频——
 * 这与“绝不虚报重要性”的方向相反，因此 `equalCount` 与 `rank` 都强烈建议入库。
 */

/** 一条词频记录（对应 `frequency_entries`）。 */
export interface FrequencyEntry {
  /** 词条 ID。 */
  wordId: string;
  /** 该词在语料版本中的原始出现次数。 */
  frequency: number;
  /**
   * 该词在“有频率词条”中的降序名次（1 = 频次最高）。
   *
   * 存在并列时请写**并列组内的最小名次**（competition rank），并同时给出 `equalCount`。
   */
  rank?: number;
  /**
   * 与该词频次**相同**的词条个数（含自身，即并列组大小），默认 1。
   *
   * 并列组跨越分位数边界时必须提供，否则百分位会被系统性抬高（见 `frequencyPercentile`）。
   */
  equalCount?: number;
  /** 语料版本标识。 */
  corpusVersion: string;
  /** 来源 ID。 */
  sourceId: string;
}

/** 重要性分级。 */
export type FrequencyImportance = 'HIGH' | 'MEDIUM' | 'BASIC' | 'UNKNOWN';

/** 高重要性的百分位下限（P90）。 */
export const FREQUENCY_HIGH_PERCENTILE = 0.9;

/** 中重要性的百分位下限（P60）。 */
export const FREQUENCY_MEDIUM_PERCENTILE = 0.6;

/**
 * 判断来源与版本是否完整（缺任何一项都不分级）。
 *
 * @param entry 词频记录。
 * @returns 是否完整。
 */
function hasCompleteSource(entry: FrequencyEntry): boolean {
  return (
    typeof entry.sourceId === 'string' &&
    entry.sourceId.trim() !== '' &&
    typeof entry.corpusVersion === 'string' &&
    entry.corpusVersion.trim() !== ''
  );
}

/**
 * 计算该词条的百分位；无法可靠计算时返回 `null`。
 *
 * 公式（设计 §8）：`percentile = (less + 0.5*equal) / knownWordCount`，
 * 其中
 * - `equal` = 与该词频次相同的词条数（并列组大小，含自身）；
 * - `less`  = 频次**严格更低**的词条数 = `knownWordCount - rank - (equal - 1)`。
 *
 * 并列时若漏掉 `(equal - 1)`（把并列组自身算进 `less`），百分位会被抬高
 * `(equal-1)*0.5/n`，把 P60–P90 的词误判为高频——因此并列组大小不是可省略的细节。
 *
 * @param entry 词频记录。
 * @param knownWordCount 该语料版本中频次大于 0 的词条总数。
 * @returns `[0, 1]` 之间的百分位，或 `null`。
 */
export function frequencyPercentile(
  entry: FrequencyEntry | null,
  knownWordCount: number,
): number | null {
  if (entry === null || typeof entry !== 'object') {
    return null;
  }
  if (!hasCompleteSource(entry)) {
    return null;
  }
  if (typeof entry.frequency !== 'number' || !Number.isFinite(entry.frequency) || entry.frequency <= 0) {
    // 频次为 0 的语义在设计里是“未定义”，不得当成低频。
    return null;
  }
  if (typeof knownWordCount !== 'number' || !Number.isInteger(knownWordCount) || knownWordCount <= 0) {
    return null;
  }
  if (
    typeof entry.rank !== 'number' ||
    !Number.isInteger(entry.rank) ||
    entry.rank < 1 ||
    entry.rank > knownWordCount
  ) {
    // 名次缺失或与已知词数不一致 → 词形/记录未能可靠映射。
    return null;
  }

  const equalCandidate = entry.equalCount ?? 1;
  if (!Number.isInteger(equalCandidate) || equalCandidate < 1) {
    return null;
  }
  if (entry.rank + equalCandidate - 1 > knownWordCount) {
    // 并列组超出了“有频率词条”总数：记录自相矛盾，宁可视为未知。
    return null;
  }

  const equal = equalCandidate;
  const less = knownWordCount - entry.rank - (equal - 1);
  return (less + 0.5 * equal) / knownWordCount;
}

/**
 * 按百分位给出重要性分级。
 *
 * @param percentile `[0, 1]` 之间的百分位；非有限数字视为无法分级。
 * @returns `HIGH` / `MEDIUM` / `BASIC`（无法分级时为 `UNKNOWN`）。
 */
export function classifyByPercentile(percentile: number): FrequencyImportance {
  if (!Number.isFinite(percentile)) {
    return 'UNKNOWN';
  }
  if (percentile >= FREQUENCY_HIGH_PERCENTILE) {
    return 'HIGH';
  }
  if (percentile >= FREQUENCY_MEDIUM_PERCENTILE) {
    return 'MEDIUM';
  }
  return 'BASIC';
}

/**
 * 把词频记录分级为可展示的重要性。
 *
 * @param entry 词频记录，缺失时为 `null`。
 * @param knownWordCount 该语料版本中频次大于 0 的词条总数。
 * @returns `HIGH` / `MEDIUM` / `BASIC` / `UNKNOWN`。
 */
export function classifyFrequencyImportance(
  entry: FrequencyEntry | null,
  knownWordCount: number,
): FrequencyImportance {
  const percentile = frequencyPercentile(entry, knownWordCount);
  if (percentile === null) {
    return 'UNKNOWN';
  }
  return classifyByPercentile(percentile);
}
