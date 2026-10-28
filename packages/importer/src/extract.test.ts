import { describe, expect, it } from 'vitest';

import { extractByLines, extractWords } from './extract';

describe('extractByLines（一行一个条目）', () => {
  it('每行一个单词，去重、保留原始大小写', () => {
    const result = extractByLines('Apple\nbanana\nApple\ncherry');
    expect(result.map((t) => t.lemma)).toEqual(['Apple', 'banana', 'cherry']);
  });

  it('识别 2-4 词的短语', () => {
    const result = extractByLines('look forward to\ngive up\nhello');
    expect(result.map((t) => ({ lemma: t.lemma, phrase: t.phrase }))).toEqual([
      { lemma: 'look forward to', phrase: true },
      { lemma: 'give up', phrase: true },
      { lemma: 'hello', phrase: false },
    ]);
  });

  it('超过 4 词的句子退化为按单词拆', () => {
    const result = extractByLines('The quick brown fox jumps over the lazy dog');
    expect(result.some((t) => t.phrase)).toBe(false);
    expect(result.map((t) => t.lemma)).toContain('quick');
  });

  it('过滤高频虚词', () => {
    const result = extractByLines('the\na\nabandon\nknowledge');
    expect(result.map((t) => t.lemma)).toEqual(['abandon', 'knowledge']);
  });

  it('保留连字符与撇号单词', () => {
    const result = extractByLines("well-known\ndon't\ncooperate");
    expect(result.map((t) => t.lemma)).toEqual(['well-known', "don't", 'cooperate']);
  });

  it('遵守 max 上限', () => {
    const words = Array.from({ length: 100 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${Math.floor(i / 26)}`).join('\n');
    const result = extractByLines(words, { max: 10 });
    expect(result).toHaveLength(10);
  });
});

describe('extractWords（正文筛单词）', () => {
  it('从整段文字里筛出英文单词，不识别短语', () => {
    const result = extractWords('The quick brown fox jumps over the lazy dog');
    expect(result.some((t) => t.phrase)).toBe(false);
    expect(result.map((t) => t.lemma)).toContain('quick');
    expect(result.map((t) => t.lemma)).toContain('jumps');
  });

  it('过滤停用词', () => {
    const result = extractWords('the apple and a banana');
    expect(result.map((t) => t.lemma)).toEqual(['apple', 'banana']);
  });

  it('忽略数字与符号', () => {
    const result = extractWords('123 456 apple! @#$ banana');
    expect(result.map((t) => t.lemma)).toEqual(['apple', 'banana']);
  });
});
