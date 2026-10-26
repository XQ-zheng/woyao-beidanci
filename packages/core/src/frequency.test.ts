import { describe, expect, it } from 'vitest';

import type { FrequencyEntry } from './frequency';
import {
  classifyByPercentile,
  classifyFrequencyImportance,
  FREQUENCY_HIGH_PERCENTILE,
  FREQUENCY_MEDIUM_PERCENTILE,
  frequencyPercentile,
} from './frequency';

/** 构造一条完整的词频记录。 */
function makeEntry(overrides: Partial<FrequencyEntry> = {}): FrequencyEntry {
  return {
    wordId: 'w-1',
    frequency: 120,
    rank: 10,
    corpusVersion: 'netem-2024-01',
    sourceId: 'src-netem',
    ...overrides,
  };
}

/** 该语料版本中频次大于 0 的词条总数。 */
const KNOWN_WORD_COUNT = 100;

describe('classifyFrequencyImportance：百分位分级', () => {
  it.each([
    { rank: 1, expected: 'HIGH' },
    { rank: 10, expected: 'HIGH' },
    { rank: 11, expected: 'MEDIUM' },
    { rank: 40, expected: 'MEDIUM' },
    { rank: 41, expected: 'BASIC' },
    { rank: 100, expected: 'BASIC' },
  ])('名次 $rank（共 100 个有频率词）→ $expected', ({ rank, expected }) => {
    expect(
      classifyFrequencyImportance(makeEntry({ rank }), KNOWN_WORD_COUNT),
    ).toBe(expected);
  });

  it('P90 边界：percentile 0.905 为高，0.895 为中', () => {
    // rank 10 → (90 + 0.5)/100 = 0.905；rank 11 → 0.895
    expect(frequencyPercentile(makeEntry({ rank: 10 }), 100)).toBeCloseTo(0.905, 10);
    expect(frequencyPercentile(makeEntry({ rank: 11 }), 100)).toBeCloseTo(0.895, 10);
  });

  it('P60 边界：percentile 0.605 为中，0.595 为基础', () => {
    expect(frequencyPercentile(makeEntry({ rank: 40 }), 100)).toBeCloseTo(0.605, 10);
    expect(frequencyPercentile(makeEntry({ rank: 41 }), 100)).toBeCloseTo(0.595, 10);
  });

  it('词条规模不同也按百分位而非绝对次数分级', () => {
    // 1000 词里的第 50 名 → (950 + 0.5)/1000 = 0.9505 → 高
    expect(classifyFrequencyImportance(makeEntry({ rank: 50 }), 1000)).toBe('HIGH');
    // 1000 词里的第 500 名 → 0.5005 → 基础
    expect(classifyFrequencyImportance(makeEntry({ rank: 500 }), 1000)).toBe('BASIC');
  });
});

describe('classifyFrequencyImportance：未知一律 UNKNOWN', () => {
  it('没有记录 → UNKNOWN', () => {
    expect(classifyFrequencyImportance(null, KNOWN_WORD_COUNT)).toBe('UNKNOWN');
  });

  it.each([
    { name: '缺少来源', entry: makeEntry({ sourceId: '' }) },
    { name: '缺少语料版本', entry: makeEntry({ corpusVersion: '   ' }) },
    { name: '频次为 0', entry: makeEntry({ frequency: 0 }) },
    { name: '频次为负', entry: makeEntry({ frequency: -3 }) },
    { name: '频次为 NaN', entry: makeEntry({ frequency: Number.NaN }) },
    { name: '缺少名次', entry: makeEntry({ rank: undefined }) },
    { name: '名次为小数', entry: makeEntry({ rank: 1.5 }) },
    { name: '名次为 0', entry: makeEntry({ rank: 0 }) },
    { name: '名次超过已知词数', entry: makeEntry({ rank: 101 }) },
  ])('$name → UNKNOWN', ({ entry }) => {
    expect(classifyFrequencyImportance(entry, KNOWN_WORD_COUNT)).toBe('UNKNOWN');
  });

  it.each([
    { name: '已知词数为 0', knownWordCount: 0 },
    { name: '已知词数为负', knownWordCount: -10 },
    { name: '已知词数为小数', knownWordCount: 10.5 },
  ])('$name → UNKNOWN', ({ knownWordCount }) => {
    expect(classifyFrequencyImportance(makeEntry(), knownWordCount)).toBe('UNKNOWN');
  });

  it('未知不会被当成低频（不会返回 BASIC）', () => {
    expect(classifyFrequencyImportance(null, KNOWN_WORD_COUNT)).not.toBe('BASIC');
    expect(classifyFrequencyImportance(makeEntry({ frequency: 0 }), KNOWN_WORD_COUNT)).not.toBe('BASIC');
  });

  it('频率为 0 时百分位不可计算', () => {
    expect(frequencyPercentile(makeEntry({ frequency: 0 }), KNOWN_WORD_COUNT)).toBeNull();
  });
});

describe('classifyByPercentile', () => {
  it.each([
    { percentile: 1, expected: 'HIGH' },
    { percentile: FREQUENCY_HIGH_PERCENTILE, expected: 'HIGH' },
    { percentile: 0.899, expected: 'MEDIUM' },
    { percentile: FREQUENCY_MEDIUM_PERCENTILE, expected: 'MEDIUM' },
    { percentile: 0.599, expected: 'BASIC' },
    { percentile: 0, expected: 'BASIC' },
    { percentile: Number.NaN, expected: 'UNKNOWN' },
  ])('$percentile → $expected', ({ percentile, expected }) => {
    expect(classifyByPercentile(percentile)).toBe(expected);
  });
});

describe('frequencyPercentile', () => {
  it('按 (less + 0.5*equal) / knownWordCount 计算', () => {
    // rank 4 / 10 → less=6 → (6 + 0.5)/10 = 0.65
    expect(frequencyPercentile(makeEntry({ rank: 4 }), 10)).toBeCloseTo(0.65, 10);
  });

  it('唯一名次（rank=1）给出接近 1 的百分位', () => {
    expect(frequencyPercentile(makeEntry({ rank: 1 }), 1)).toBeCloseTo(0.5, 10);
    expect(frequencyPercentile(makeEntry({ rank: 1 }), 1000)).toBeCloseTo(0.9995, 10);
  });

  it('并列组按 equal 折算：less 不含并列组自身', () => {
    // rank 4、并列 3 个、共 10 个 → less = 10 - 4 - 2 = 4 → (4 + 1.5)/10 = 0.55
    expect(frequencyPercentile(makeEntry({ rank: 4, equalCount: 3 }), 10)).toBeCloseTo(0.55, 10);
  });

  it('并列组等于全体（rank=1、equal=10）→ 0.5', () => {
    expect(frequencyPercentile(makeEntry({ rank: 1, equalCount: 10 }), 10)).toBeCloseTo(0.5, 10);
  });

  it.each([
    { name: '并列数为 0', equalCount: 0 },
    { name: '并列数为负', equalCount: -2 },
    { name: '并列数为小数', equalCount: 1.5 },
    { name: '并列数为 NaN', equalCount: Number.NaN },
  ])('$name → 无法计算（null）', ({ equalCount }) => {
    expect(frequencyPercentile(makeEntry({ rank: 4, equalCount }), 10)).toBeNull();
  });

  it('并列组超出已知词数（自相矛盾）→ null', () => {
    // rank 9 + equal 3 - 1 = 11 > 10
    expect(frequencyPercentile(makeEntry({ rank: 9, equalCount: 3 }), 10)).toBeNull();
  });
});

describe('并列（equalCount）跨越分位数边界', () => {
  it('并列组跨越 P90：正确判 MEDIUM（不提供 equalCount 会被虚高成 HIGH）', () => {
    // rank 10、并列 5 个、共 100 个：
    // 正确 → less = 100 - 10 - 4 = 86 → (86 + 2.5)/100 = 0.885 → MEDIUM
    // 若误把并列组算进 less（equal=1）→ (90 + 0.5)/100 = 0.905 → 被误判为 HIGH
    const entry = makeEntry({ rank: 10, equalCount: 5 });

    expect(frequencyPercentile(entry, 100)).toBeCloseTo(0.885, 10);
    expect(classifyFrequencyImportance(entry, 100)).toBe('MEDIUM');
    expect(frequencyPercentile(makeEntry({ rank: 10 }), 100)).toBeCloseTo(0.905, 10);
  });

  it('并列组跨越 P60：正确判 BASIC（不提供 equalCount 会被虚高成 MEDIUM）', () => {
    // rank 40、并列 5 个、共 100 个：
    // 正确 → less = 100 - 40 - 4 = 56 → (56 + 2.5)/100 = 0.585 → BASIC
    // 若按 equal=1 → (60 + 0.5)/100 = 0.605 → 被误判为 MEDIUM
    const entry = makeEntry({ rank: 40, equalCount: 5 });

    expect(frequencyPercentile(entry, 100)).toBeCloseTo(0.585, 10);
    expect(classifyFrequencyImportance(entry, 100)).toBe('BASIC');
    expect(frequencyPercentile(makeEntry({ rank: 40 }), 100)).toBeCloseTo(0.605, 10);
  });

  it('并列组恰好整体落在 P90 以上 → 仍为 HIGH', () => {
    // rank 1、并列 4 个、共 100 个 → less = 100 - 1 - 3 = 96 → (96 + 2)/100 = 0.98
    const entry = makeEntry({ rank: 1, equalCount: 4 });

    expect(frequencyPercentile(entry, 100)).toBeCloseTo(0.98, 10);
    expect(classifyFrequencyImportance(entry, 100)).toBe('HIGH');
  });

  it('并列组大小为 1（默认）时与原公式一致', () => {
    expect(frequencyPercentile(makeEntry({ rank: 10, equalCount: 1 }), 100)).toBeCloseTo(
      frequencyPercentile(makeEntry({ rank: 10 }), 100) ?? Number.NaN,
      12,
    );
  });

  it('并列组越界时降级为 UNKNOWN，而不是当成低频', () => {
    const entry = makeEntry({ rank: 98, equalCount: 5 });

    expect(frequencyPercentile(entry, 100)).toBeNull();
    expect(classifyFrequencyImportance(entry, 100)).toBe('UNKNOWN');
    expect(classifyFrequencyImportance(entry, 100)).not.toBe('BASIC');
  });
});
