/**
 * 相似干扰项生成（设计 6）。
 *
 * 规则：
 * - `EN_TO_ZH`：正确答案是目标词的中文义项，干扰项取候选词的义项；
 *   相似度 = `同词性 0.45 + 已许可主题 0.35 + 长度接近 0.20`。
 *   V1.0 核心层没有已核验许可的主题数据，因此“主题”项恒为 0（绝不编造主题标签）。
 * - `ZH_TO_EN`：正确答案是目标词的英文 lemma，干扰项取候选词的 lemma；
 *   相似度 = `编辑距离相似 0.65 + 共同前缀 0.20 + 长度接近 0.15`。
 * - `MIXED`：用**同一个种子**确定本次采用哪种模式（设计：每个 session 用有种子的 50/50 序列）。
 * - 排序 = `stableShuffle(pool, seed)` 后按相似度降序（同分保持洗牌序），因此同一 seed 完全可重放。
 * - 候选不足时**降级到次要相似层**，绝不编造单词或释义；仍然不足就少返回几个（由 UI 切换为拼写/输入作答）。
 *
 * 与“可接受答案”有关的安全规则：与目标释义有交集的候选一律剔除，
 * 因为同义词会让两个选项都可判对。
 */

import type { TrainingMode } from './models';
import { createSeededRandom, seededShuffle } from './queue';

/** 生成干扰项所需的词条视图（含多义项）。 */
export interface WordWithSenses {
  /** 词条 ID。 */
  wordId: string;
  /** 英文词形。 */
  lemma: string;
  /** 词性，例如 `n.` / `v.` / `adj.`。 */
  pos: string;
  /** 中文义项，按展示顺序排列。 */
  senses: string[];
}

/** 需要的干扰项数量（含正确答案共 4 个选项）。 */
export const REQUIRED_DISTRACTOR_COUNT = 3;

/** `EN_TO_ZH` 相似度权重的词性占比。 */
export const POS_SIMILARITY_WEIGHT = 0.45;

/** `EN_TO_ZH` 相似度权重的主题占比（无已许可主题数据时恒为 0）。 */
export const TOPIC_SIMILARITY_WEIGHT = 0.35;

/** `EN_TO_ZH` 相似度权重的长度占比。 */
export const ANSWER_LENGTH_SIMILARITY_WEIGHT = 0.2;

/** `ZH_TO_EN` 相似度权重的编辑距离占比。 */
export const EDIT_SIMILARITY_WEIGHT = 0.65;

/** `ZH_TO_EN` 相似度权重的共同前缀占比。 */
export const PREFIX_SIMILARITY_WEIGHT = 0.2;

/** `ZH_TO_EN` 相似度权重的长度占比。 */
export const LEMMA_LENGTH_SIMILARITY_WEIGHT = 0.15;

/** `ZH_TO_EN` 判定“拼写相近”的阈值：达到即进入首选层。 */
export const MIN_SPELLING_SIMILARITY = 0.45;

/** 干扰项请求非法时抛出的类型化错误。 */
export class InvalidDistractorRequestError extends Error {
  /** 错误码。 */
  readonly code = 'INVALID_DISTRACTOR_REQUEST';

  /** 出错的字段名。 */
  readonly field: string;

  /**
   * @param field 出错字段。
   * @param message 错误说明。
   */
  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidDistractorRequestError';
    this.field = field;
  }
}

/** 排序用的候选（携带预计算的相似度与洗牌序号）。 */
interface RankedCandidate {
  /** 用于展示的答案字符串。 */
  readonly answer: string;
  /** 归一化后的答案，用于去重与“与正确答案相同”判断。 */
  readonly answerKey: string;
  /** 相似度得分，越大越优先。 */
  readonly similarity: number;
  /** 是否属于首选相似层。 */
  readonly preferred: boolean;
  /** 洗牌序号，作为同分时的确定性次序。 */
  readonly order: number;
}

/**
 * 文本归一化：去首尾空白并转小写。
 *
 * @param value 原始文本。
 * @returns 归一化结果。
 */
function normalizeText(value: string): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * 归一化词性：去掉末尾句点与空白，便于 `n.` 与 `n` 视为同一词性。
 *
 * @param pos 原始词性。
 * @returns 归一化词性。
 */
function normalizePos(pos: string): string {
  return normalizeText(pos).replace(/\.+$/u, '');
}

/**
 * 取目标/候选在该模式下的展示答案。
 *
 * @param word 词条。
 * @param mode 生效模式（不含 `MIXED`）。
 * @returns 展示答案，缺失时返回空字符串。
 */
function displayAnswerOf(word: WordWithSenses, mode: 'EN_TO_ZH' | 'ZH_TO_EN'): string {
  if (mode === 'EN_TO_ZH') {
    const senses = Array.isArray(word.senses) ? word.senses : [];
    const firstSense = senses.find((sense) => typeof sense === 'string' && sense.trim() !== '');
    return typeof firstSense === 'string' ? firstSense.trim() : '';
  }
  return typeof word.lemma === 'string' ? word.lemma.trim() : '';
}

/**
 * 计算两个字符串的编辑距离（Levenshtein，仅插入/删除/替换，代价均为 1）。
 *
 * @param left 左字符串。
 * @param right 右字符串。
 * @returns 编辑距离。
 */
export function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (left.length === 0) {
    return right.length;
  }
  if (right.length === 0) {
    return left.length;
  }

  let previousRow: number[] = Array.from({ length: right.length + 1 }, (_unused, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const currentRow: number[] = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const deletion = (previousRow[rightIndex] ?? 0) + 1;
      const insertion = (currentRow[rightIndex - 1] ?? 0) + 1;
      const substitution = (previousRow[rightIndex - 1] ?? 0) + substitutionCost;
      currentRow.push(Math.min(deletion, insertion, substitution));
    }
    previousRow = currentRow;
  }

  return previousRow[right.length] ?? 0;
}

/**
 * 长度接近度：`1 - |Δlen| / max(len)`，两边都为空时视为 1。
 *
 * @param left 左字符串。
 * @param right 右字符串。
 * @returns `[0, 1]` 之间的接近度。
 */
function lengthSimilarity(left: string, right: string): number {
  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) {
    return 1;
  }
  return 1 - Math.abs(left.length - right.length) / maxLength;
}

/**
 * 共同前缀占比：`共同前缀长度 / max(len)`。
 *
 * @param left 左字符串。
 * @param right 右字符串。
 * @returns `[0, 1]` 之间的占比。
 */
function sharedPrefixScore(left: string, right: string): number {
  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) {
    return 1;
  }
  const limit = Math.min(left.length, right.length);
  let prefixLength = 0;
  while (prefixLength < limit && left[prefixLength] === right[prefixLength]) {
    prefixLength += 1;
  }
  return prefixLength / maxLength;
}

/**
 * 计算候选的相似度得分。
 *
 * @param target 目标词。
 * @param candidate 候选词。
 * @param mode 生效模式。
 * @returns 相似度得分。
 */
function similarityOf(
  target: WordWithSenses,
  candidate: WordWithSenses,
  mode: 'EN_TO_ZH' | 'ZH_TO_EN',
): number {
  if (mode === 'EN_TO_ZH') {
    const targetPos = normalizePos(target.pos);
    const candidatePos = normalizePos(candidate.pos);
    const samePos = targetPos !== '' && targetPos === candidatePos ? 1 : 0;
    // 无不侵犯许可的主题数据可依，相关权重恒为 0，避免编造“主题相近”。
    const sharedTopic = 0;
    const answerLength = lengthSimilarity(
      displayAnswerOf(target, mode),
      displayAnswerOf(candidate, mode),
    );
    return (
      samePos * POS_SIMILARITY_WEIGHT +
      sharedTopic * TOPIC_SIMILARITY_WEIGHT +
      answerLength * ANSWER_LENGTH_SIMILARITY_WEIGHT
    );
  }

  const targetLemma = normalizeText(target.lemma);
  const candidateLemma = normalizeText(candidate.lemma);
  const maxLength = Math.max(targetLemma.length, candidateLemma.length);
  const editScore =
    maxLength === 0 ? 1 : 1 - levenshteinDistance(targetLemma, candidateLemma) / maxLength;
  return (
    editScore * EDIT_SIMILARITY_WEIGHT +
    sharedPrefixScore(targetLemma, candidateLemma) * PREFIX_SIMILARITY_WEIGHT +
    lengthSimilarity(targetLemma, candidateLemma) * LEMMA_LENGTH_SIMILARITY_WEIGHT
  );
}

/**
 * 根据模式与种子确定本次真正使用的模式。
 *
 * `MIXED` 用同一个种子派生的随机数做 50/50 选择，因此同一次 session 可重放；
 * 其它模式原样返回。非法模式抛 `InvalidDistractorRequestError`。
 *
 * @param mode 训练模式。
 * @param seed 字符串种子。
 * @returns `EN_TO_ZH` 或 `ZH_TO_EN`。
 */
export function resolveDistractorMode(
  mode: TrainingMode,
  seed: string,
): 'EN_TO_ZH' | 'ZH_TO_EN' {
  if (mode === 'EN_TO_ZH' || mode === 'ZH_TO_EN') {
    return mode;
  }
  if (mode !== 'MIXED') {
    throw new InvalidDistractorRequestError('mode', `未知的训练模式：${String(mode)}`);
  }
  return createSeededRandom(seed)() < 0.5 ? 'EN_TO_ZH' : 'ZH_TO_EN';
}

/**
 * 生成 3 个互不相同、且都不等于正确答案的干扰项。
 *
 * 步骤：过滤（同词、空答案、与正确答案相同、释义与目标有交集、答案重复）→
 * 种子洗牌 → 按相似度降序 → 先取“同词性/拼写相近”的首选层，不足再取其余候选。
 *
 * @param target 目标词（正确答案的来源）。
 * @param candidates 候选词池（可包含被“不再出现”的词——它们仍可作干扰项）。
 * @param mode 训练模式。
 * @param seed 字符串种子。
 * @returns 干扰项答案数组，最多 3 个；候选不足时返回可用的全部（绝不编造）。
 */
export function generateDistractors(
  target: WordWithSenses,
  candidates: readonly WordWithSenses[],
  mode: TrainingMode,
  seed: string,
): string[] {
  if (target === null || typeof target !== 'object') {
    throw new InvalidDistractorRequestError('target', '目标词不能为空');
  }
  if (typeof seed !== 'string') {
    throw new InvalidDistractorRequestError('seed', 'seed 必须是字符串');
  }

  const effectiveMode = resolveDistractorMode(mode, seed);
  const correctAnswer = displayAnswerOf(target, effectiveMode);
  const correctAnswerKey = normalizeText(correctAnswer);
  if (correctAnswerKey === '') {
    // 没有可用答案就无法给出选项：交给上层切换为拼写/输入作答。
    return [];
  }

  const targetSenseKeys = new Set(
    (Array.isArray(target.senses) ? target.senses : [])
      .map((sense) => normalizeText(sense))
      .filter((sense) => sense !== ''),
  );

  const usableCandidates: WordWithSenses[] = [];
  const seenWordIds = new Set<string>([target.wordId]);
  const seenAnswerKeys = new Set<string>([correctAnswerKey]);
  // 显式标注元素类型：`Array.isArray` 会把 `readonly T[]` 收窄成 `any[]`。
  const candidatePool: readonly WordWithSenses[] = Array.isArray(candidates) ? candidates : [];

  for (const candidate of candidatePool) {
    if (candidate === null || typeof candidate !== 'object') {
      continue;
    }
    if (seenWordIds.has(candidate.wordId)) {
      continue;
    }
    const answer = displayAnswerOf(candidate, effectiveMode);
    const answerKey = normalizeText(answer);
    if (answerKey === '' || seenAnswerKeys.has(answerKey)) {
      continue;
    }
    if (effectiveMode === 'EN_TO_ZH') {
      const candidateSenses = Array.isArray(candidate.senses) ? candidate.senses : [];
      const overlaps = candidateSenses.some((sense) => targetSenseKeys.has(normalizeText(sense)));
      if (overlaps) {
        // 同义/近义项会让两个选项都可判对，直接剔除。
        continue;
      }
    }
    seenWordIds.add(candidate.wordId);
    seenAnswerKeys.add(answerKey);
    usableCandidates.push(candidate);
  }

  const shuffled = seededShuffle(usableCandidates, seed);
  const ranked: RankedCandidate[] = shuffled.map((candidate, order) => {
    const similarity = similarityOf(target, candidate, effectiveMode);
    return {
      answer: displayAnswerOf(candidate, effectiveMode),
      answerKey: normalizeText(displayAnswerOf(candidate, effectiveMode)),
      similarity,
      preferred:
        effectiveMode === 'EN_TO_ZH'
          ? normalizePos(target.pos) !== '' && normalizePos(target.pos) === normalizePos(candidate.pos)
          : similarity >= MIN_SPELLING_SIMILARITY,
      order,
    };
  });

  // 同分时保持洗牌序（即设计里的 stableShuffle → 稳定排序），确保同一 seed 可重放。
  ranked.sort((left, right) => right.similarity - left.similarity || left.order - right.order);

  const preferredCandidates = ranked.filter((candidate) => candidate.preferred);
  const relaxedCandidates = ranked.filter((candidate) => !candidate.preferred);
  const pickedAnswers: string[] = [];
  const pickedKeys = new Set<string>();

  for (const tier of [preferredCandidates, relaxedCandidates]) {
    for (const candidate of tier) {
      if (pickedAnswers.length >= REQUIRED_DISTRACTOR_COUNT) {
        break;
      }
      if (pickedKeys.has(candidate.answerKey)) {
        continue;
      }
      pickedKeys.add(candidate.answerKey);
      pickedAnswers.push(candidate.answer);
    }
  }

  return pickedAnswers;
}
