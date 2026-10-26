import { describe, expect, it } from 'vitest';

import type { WordWithSenses } from './distractors';
import {
  generateDistractors,
  InvalidDistractorRequestError,
  levenshteinDistance,
  resolveDistractorMode,
} from './distractors';

/** 目标词：动词，“放弃 / 抛弃”。 */
const TARGET: WordWithSenses = {
  wordId: 'w-target',
  lemma: 'abandon',
  pos: 'v.',
  senses: ['放弃', '抛弃'],
};

/**
 * `EN_TO_ZH` 候选池：3 个同词性 + 3 个不同词性（长度更接近，但词性不同）。
 */
const EN_CANDIDATES: WordWithSenses[] = [
  { wordId: 'w-1', lemma: 'accept', pos: 'v.', senses: ['接受'] },
  { wordId: 'w-2', lemma: 'borrow', pos: 'v.', senses: ['借入'] },
  { wordId: 'w-3', lemma: 'collect', pos: 'v.', senses: ['收集'] },
  { wordId: 'w-4', lemma: 'abdomen', pos: 'n.', senses: ['腹部'] },
  { wordId: 'w-5', lemma: 'ability', pos: 'n.', senses: ['能力'] },
  { wordId: 'w-6', lemma: 'abroad', pos: 'adv.', senses: ['在国外'] },
];

describe('generateDistractors：EN_TO_ZH', () => {
  it('返回 3 个互不相同、且都不等于正确答案的干扰项', () => {
    const distractors = generateDistractors(TARGET, EN_CANDIDATES, 'EN_TO_ZH', 'seed-a');

    expect(distractors).toHaveLength(3);
    expect(new Set(distractors).size).toBe(3);
    expect(distractors).not.toContain('放弃');
    expect(distractors).not.toContain('抛弃');
  });

  it('优先同词性的候选', () => {
    const distractors = generateDistractors(TARGET, EN_CANDIDATES, 'EN_TO_ZH', 'seed-a');

    expect([...distractors].sort()).toEqual(['借入', '接受', '收集'].sort());
  });

  it('同词性不足 3 个时降级到其余候选，而不是编造', () => {
    const candidates: WordWithSenses[] = [
      { wordId: 'w-1', lemma: 'accept', pos: 'v.', senses: ['接受'] },
      { wordId: 'w-2', lemma: 'abdomen', pos: 'n.', senses: ['腹部'] },
      { wordId: 'w-3', lemma: 'ability', pos: 'n.', senses: ['能力'] },
    ];

    const distractors = generateDistractors(TARGET, candidates, 'EN_TO_ZH', 'seed-a');

    expect(distractors).toHaveLength(3);
    expect(distractors).toContain('接受');
    expect([...distractors].sort()).toEqual(['接受', '能力', '腹部'].sort());
  });

  it('剔除与目标释义有交集的候选（同义项会让两个选项都可判对）', () => {
    const candidates: WordWithSenses[] = [
      { wordId: 'w-1', lemma: 'desert', pos: 'v.', senses: ['抛弃'] },
      { wordId: 'w-2', lemma: 'accept', pos: 'v.', senses: ['接受'] },
      { wordId: 'w-3', lemma: 'borrow', pos: 'v.', senses: ['借入'] },
      { wordId: 'w-4', lemma: 'collect', pos: 'v.', senses: ['收集'] },
    ];

    const distractors = generateDistractors(TARGET, candidates, 'EN_TO_ZH', 'seed-a');

    expect(distractors).not.toContain('抛弃');
    expect(distractors).toHaveLength(3);
  });

  it('剔除目标词自身、空答案与重复答案', () => {
    const candidates: WordWithSenses[] = [
      TARGET,
      { wordId: 'w-empty', lemma: 'blank', pos: 'v.', senses: [] },
      { wordId: 'w-dup-1', lemma: 'receive', pos: 'v.', senses: ['接受'] },
      { wordId: 'w-dup-2', lemma: 'accept', pos: 'v.', senses: ['接受'] },
      { wordId: 'w-2', lemma: 'borrow', pos: 'v.', senses: ['借入'] },
      { wordId: 'w-3', lemma: 'collect', pos: 'v.', senses: ['收集'] },
    ];

    const distractors = generateDistractors(TARGET, candidates, 'EN_TO_ZH', 'seed-a');

    expect(distractors).toHaveLength(3);
    expect(distractors.filter((answer) => answer === '接受')).toHaveLength(1);
    expect(distractors).not.toContain('');
  });

  it('目标没有可用义项时返回空数组（交给上层切换作答方式）', () => {
    const target: WordWithSenses = { wordId: 'w-x', lemma: 'void', pos: 'v.', senses: [] };

    expect(generateDistractors(target, EN_CANDIDATES, 'EN_TO_ZH', 'seed-a')).toEqual([]);
  });
});

describe('generateDistractors：ZH_TO_EN', () => {
  const target: WordWithSenses = { wordId: 'w-adopt', lemma: 'adopt', pos: 'v.', senses: ['采用'] };
  const candidates: WordWithSenses[] = [
    { wordId: 'w-adapt', lemma: 'adapt', pos: 'v.', senses: ['适应'] },
    { wordId: 'w-adept', lemma: 'adept', pos: 'adj.', senses: ['熟练的'] },
    { wordId: 'w-zebra', lemma: 'zebra', pos: 'n.', senses: ['斑马'] },
    { wordId: 'w-yacht', lemma: 'yacht', pos: 'n.', senses: ['游艇'] },
    { wordId: 'w-banana', lemma: 'banana', pos: 'n.', senses: ['香蕉'] },
  ];

  it('优先拼写相近的候选，并返回 3 个英文 lemma', () => {
    const distractors = generateDistractors(target, candidates, 'ZH_TO_EN', 'seed-b');

    expect(distractors).toHaveLength(3);
    expect(distractors).not.toContain('adopt');
    expect(distractors.slice(0, 2).sort()).toEqual(['adapt', 'adept']);
    distractors.forEach((distractor) => {
      expect(candidates.map((candidate) => candidate.lemma)).toContain(distractor);
    });
  });

  it('拼写相近不足时用其余候选补齐', () => {
    const smallPool = candidates.slice(2);

    const distractors = generateDistractors(target, smallPool, 'ZH_TO_EN', 'seed-b');

    expect(distractors).toHaveLength(3);
    expect([...distractors].sort()).toEqual(['banana', 'yacht', 'zebra']);
  });
});

describe('generateDistractors：确定性与池不足', () => {
  it('同一 seed 结果完全一致', () => {
    const first = generateDistractors(TARGET, EN_CANDIDATES, 'EN_TO_ZH', 'seed-x');
    const second = generateDistractors(TARGET, EN_CANDIDATES, 'EN_TO_ZH', 'seed-x');

    expect(second).toEqual(first);
  });

  it('候选不足 3 个时只返回可用的部分，绝不编造', () => {
    const candidates: WordWithSenses[] = [
      { wordId: 'w-1', lemma: 'accept', pos: 'v.', senses: ['接受'] },
      { wordId: 'w-2', lemma: 'borrow', pos: 'v.', senses: ['借入'] },
    ];

    expect(generateDistractors(TARGET, candidates, 'EN_TO_ZH', 'seed-a')).toHaveLength(2);
    expect(generateDistractors(TARGET, [], 'EN_TO_ZH', 'seed-a')).toEqual([]);
  });

  it('不修改候选数组', () => {
    const candidates = [...EN_CANDIDATES];

    generateDistractors(TARGET, candidates, 'EN_TO_ZH', 'seed-a');

    expect(candidates).toEqual(EN_CANDIDATES);
  });

  it('非法模式抛类型化错误', () => {
    expect(() =>
      generateDistractors(TARGET, EN_CANDIDATES, 'AUDIO' as unknown as 'EN_TO_ZH', 'seed-a'),
    ).toThrow(InvalidDistractorRequestError);
  });
});

describe('resolveDistractorMode', () => {
  it('非 MIXED 模式原样返回', () => {
    expect(resolveDistractorMode('EN_TO_ZH', 'seed')).toBe('EN_TO_ZH');
    expect(resolveDistractorMode('ZH_TO_EN', 'seed')).toBe('ZH_TO_EN');
  });

  it('MIXED 用种子做确定性的 50/50 选择', () => {
    const first = resolveDistractorMode('MIXED', 'seed-mixed');
    const second = resolveDistractorMode('MIXED', 'seed-mixed');

    expect(second).toBe(first);

    const modes = new Set(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((seed) => resolveDistractorMode('MIXED', seed)),
    );
    expect(modes.size).toBe(2);
  });
});

describe('levenshteinDistance', () => {
  it.each([
    { left: 'adopt', right: 'adopt', expected: 0 },
    { left: 'adopt', right: 'adapt', expected: 1 },
    { left: '', right: 'abc', expected: 3 },
    { left: 'abc', right: '', expected: 3 },
    { left: 'kitten', right: 'sitting', expected: 3 },
  ])('$left → $right = $expected', ({ left, right, expected }) => {
    expect(levenshteinDistance(left, right)).toBe(expected);
  });
});
