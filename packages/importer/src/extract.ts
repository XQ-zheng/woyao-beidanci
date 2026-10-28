/**
 * 从英文文本里提取「要背的单词或短语」。
 *
 * 两种使用场景、两种口径：
 * - `extractByLines`：**一行一个条目**（用户手动输入，或「每行一个词/短语」的清单）。
 *   一行可能是一个单词，也可能是 2-4 个单词组成的短语（如 `look forward to`）。
 * - `extractWords`：**从正文里筛单词**（文档/图片识别出的整段文字），只取英文单词，
 *   不把整句吞成短语。
 */

/** 一个英文字符（含连字符/撇号连接）。 */
const WORD_RE = /[A-Za-z]+(?:[-'][A-Za-z]+)*/gu;

/** 停用词：高频虚词不该当「要背的词」导入。 */
const STOP_WORDS = new Set(
  (
    'a an the and or but if then else of in on at to for with by from as is are was were be been being ' +
    'i you he she it we they me him her us them my your his its our their this that these those ' +
    'do does did have has had can could will would shall should may might must not no nor so too very just only also such'
  ).split(/\s+/u),
);

/** 提取结果里的一条。 */
export interface ExtractedTerm {
  /** 原始词形（保留大小写），如 `Abandon`、`look forward to`。 */
  readonly lemma: string;
  /** 是否被识别为短语（含空格）。 */
  readonly phrase: boolean;
}

/** 提取选项。 */
export interface ExtractOptions {
  /** 是否过滤高频虚词（默认 true）。 */
  readonly filterStopWords?: boolean;
  /** 词形统一为小写（默认 true）。 */
  readonly lower?: boolean;
  /** 最大返回条数（防止整本书级文档撑爆，默认 5000）。 */
  readonly max?: number;
}

/** 去重容器：保证保序去重。 */
class OrderedDedupe {
  private readonly seen = new Set<string>();

  constructor(
    private readonly filterStopWords: boolean,
    private readonly max: number,
    private readonly lower: boolean,
  ) {}

  /** 尝试加入；返回是否真的新增了（未达上限、未重复、未被停用词过滤）。 */
  push(raw: string, isPhrase: boolean): boolean {
    if (this.seen.size >= this.max) {
      return false;
    }
    const lemma = this.lower ? raw.toLowerCase() : raw;
    if (this.filterStopWords && !isPhrase && STOP_WORDS.has(lemma)) {
      return false;
    }
    const key = isPhrase ? `p:${lemma}` : `w:${lemma}`;
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.add(key);
    return true;
  }
}

/**
 * 按行提取：一行一个条目（单词或短语）。
 *
 * 适合「用户手动输入 / 每行一个词或短语的清单」。每行取「整行去头尾空白后的
 * 内容」作为一个条目；若一行内有多于 4 个单词，则退化为按单词提取（视为误粘贴
 * 了整段句子）。
 *
 * @param text 输入文本。
 * @param options 选项。
 * @returns 条目列表（保序、去重）。
 */
export function extractByLines(text: string, options: ExtractOptions = {}): ExtractedTerm[] {
  const filterStopWords = options.filterStopWords ?? true;
  const lower = options.lower ?? true;
  const max = options.max ?? 5000;

  const dedupe = new OrderedDedupe(filterStopWords, max, lower);
  const result: ExtractedTerm[] = [];

  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const words = trimmed.match(WORD_RE);
    if (words === null || words.length === 0) {
      continue;
    }
    // 一行 2-4 个单词且整行就是纯英文 → 当作短语；>4 词按单词拆。
    const isPureEnglishLine = /^[A-Za-z][A-Za-z' -]*$/u.test(trimmed);
    const isPhrase = isPureEnglishLine && words.length >= 2 && words.length <= 4;

    if (isPhrase) {
      if (dedupe.push(trimmed.replace(/\s+/gu, ' '), true)) {
        result.push({ lemma: trimmed.replace(/\s+/gu, ' '), phrase: true });
      }
    } else {
      for (const word of words) {
        if (dedupe.push(word, false)) {
          result.push({ lemma: word, phrase: false });
        }
      }
    }
  }

  return result;
}

/**
 * 从正文里筛单词（不识别短语）。
 *
 * 适合「文档/图片识别出的整段文字」。
 *
 * @param text 正文文本。
 * @param options 选项。
 * @returns 单词列表（保序、去重）。
 */
export function extractWords(text: string, options: ExtractOptions = {}): ExtractedTerm[] {
  const filterStopWords = options.filterStopWords ?? true;
  const lower = options.lower ?? true;
  const max = options.max ?? 5000;

  const dedupe = new OrderedDedupe(filterStopWords, max, lower);
  const result: ExtractedTerm[] = [];

  for (const match of text.matchAll(WORD_RE)) {
    if (dedupe.push(match[0], false)) {
      result.push({ lemma: match[0], phrase: false });
    }
  }

  return result;
}
