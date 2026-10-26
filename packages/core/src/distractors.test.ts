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

  it('也剔除同义候选（employ 同样表“采用”，选了也是对的）', () => {
    // 池里只放 3 个候选，其中一个与目标同义：若同义剔除没生效，返回的会是 3 项且含 employ；
    // 剔除生效后只剩 2 个可用干扰项（宁少不编造）。
    const synonymPool: WordWithSenses[] = [
      { wordId: 'w-employ', lemma: 'employ', pos: 'v.', senses: ['采用', '雇佣'] },
      { wordId: 'w-adapt', lemma: 'adapt', pos: 'v.', senses: ['适应'] },
      { wordId: 'w-adept', lemma: 'adept', pos: 'adj.', senses: ['熟练的'] },
    ];

    const distractors = generateDistractors(target, synonymPool, 'ZH_TO_EN', 'seed-zh-synonym');

    expect(distractors).not.toContain('employ');
    expect([...distractors].sort()).toEqual(['adapt', 'adept']);
  });

  it.each([
    { name: '全角分号', sense: '采用；雇佣' },
    { name: '半角逗号', sense: '采用, 雇佣' },
    { name: '斜杠', sense: '采用/雇佣' },
    { name: '顿号', sense: '采用、雇佣' },
    { name: '全角逗号', sense: '采用，雇佣' },
  ])('复合义项（$name）按分隔符切分后仍能识别交集', ({ sense }) => {
    // 复合义项若没被切分，"采用；雇佣" 整体不等于 "采用"，employ 会被当成合法干扰项。
    const synonymPool: WordWithSenses[] = [
      { wordId: 'w-employ', lemma: 'employ', pos: 'v.', senses: [sense] },
      { wordId: 'w-adapt', lemma: 'adapt', pos: 'v.', senses: ['适应'] },
      { wordId: 'w-adept', lemma: 'adept', pos: 'adj.', senses: ['熟练的'] },
    ];

    const distractors = generateDistractors(target, synonymPool, 'ZH_TO_EN', 'seed-zh-compound');

    expect(distractors).not.toContain('employ');
    expect(distractors).toHaveLength(2);
  });

  it('目标本身带复合义项时，同样剔除命中任一义项的候选', () => {
    const compoundTarget: WordWithSenses = {
      wordId: 'w-adopt',
      lemma: 'adopt',
      pos: 'v.',
      senses: ['采用；收养'],
    };
    const synonymPool: WordWithSenses[] = [
      { wordId: 'w-employ', lemma: 'employ', pos: 'v.', senses: ['采用'] },
      { wordId: 'w-adapt', lemma: 'adapt', pos: 'v.', senses: ['适应'] },
      { wordId: 'w-adept', lemma: 'adept', pos: 'adj.', senses: ['熟练的'] },
    ];

    const distractors = generateDistractors(compoundTarget, synonymPool, 'ZH_TO_EN', 'seed-zh-target');

    expect(distractors).not.toContain('employ');
    expect(distractors).toHaveLength(2);
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

  it('同一 session seed 下按 wordId 派生，8 题里两种方向都会出现', () => {
    const wordIds = ['w-1', 'w-2', 'w-3', 'w-4', 'w-5', 'w-6', 'w-7', 'w-8'];

    const modes = wordIds.map((wordId) => resolveDistractorMode('MIXED', 'session-1', wordId));

    // 关键回归点：如果派生键只含 seed，8 题会退化成同一个方向。
    expect(modes).toContain('EN_TO_ZH');
    expect(modes).toContain('ZH_TO_EN');
    expect(modes).toEqual(
      wordIds.map((wordId) => resolveDistractorMode('MIXED', 'session-1', wordId)),
    );
  });

  it('同一 (seed, wordId) 跨端跨次调用结果一致', () => {
    expect(resolveDistractorMode('MIXED', 'session-1', 'w-3')).toBe(
      resolveDistractorMode('MIXED', 'session-1', 'w-3'),
    );
    expect(resolveDistractorMode('MIXED', 'session-2', 'w-3')).toBe(
      resolveDistractorMode('MIXED', 'session-2', 'w-3'),
    );
  });

  it('区分大小写/不同 seed 会改变方向分布，但不是恒定同一方向', () => {
    const modes = new Set(
      Array.from({ length: 8 }, (_unused, index) =>
        resolveDistractorMode('MIXED', 'another-session', `word-${index}`),
      ),
    );

    expect(modes.size).toBe(2);
  });
});

describe('generateDistractors：MIXED 在会话内逐题切换方向', () => {
  /** 候选池：英文 lemma 全为纯字母，中文义项全为“义项N”，便于按形态区分方向。 */
  const MIXED_POOL: WordWithSenses[] = [
    { wordId: 'p-1', lemma: 'alpha', pos: 'v.', senses: ['义项1'] },
    { wordId: 'p-2', lemma: 'bravo', pos: 'v.', senses: ['义项2'] },
    { wordId: 'p-3', lemma: 'charlie', pos: 'v.', senses: ['义项3'] },
    { wordId: 'p-4', lemma: 'delta', pos: 'v.', senses: ['义项4'] },
    { wordId: 'p-5', lemma: 'echo', pos: 'v.', senses: ['义项5'] },
    { wordId: 'p-6', lemma: 'foxtrot', pos: 'v.', senses: ['义项6'] },
  ];

  it('同一 session seed 下 8 个目标词同时出现中文选项与英文选项', () => {
    const targets: WordWithSenses[] = Array.from({ length: 8 }, (_unused, index) => ({
      wordId: `t-${index + 1}`,
      lemma: `target${index + 1}`,
      pos: 'v.',
      senses: [`目标义项${index + 1}`],
    }));

    const directions = targets.map((target) => {
      const distractors = generateDistractors(target, MIXED_POOL, 'MIXED', 'session-mixed');
      expect(distractors).toHaveLength(3);
      // 纯字母 = 英文 lemma（ZH_TO_EN），否则是中文义项（EN_TO_ZH）。
      const isEnglish = distractors.every((answer) => /^[a-z]+$/u.test(answer));
      const allChinese = distractors.every((answer) => /^义项\d$/u.test(answer));
      expect(isEnglish || allChinese).toBe(true);
      return isEnglish ? 'ZH_TO_EN' : 'EN_TO_ZH';
    });

    expect(new Set(directions).size).toBe(2);
  });

  it('同一 (seed, wordId) 结果完全可重放', () => {
    const target: WordWithSenses = { wordId: 't-1', lemma: 'target1', pos: 'v.', senses: ['目标义项1'] };

    expect(generateDistractors(target, MIXED_POOL, 'MIXED', 'session-mixed')).toEqual(
      generateDistractors(target, MIXED_POOL, 'MIXED', 'session-mixed'),
    );
  });
});

describe('generateDistractors：并列项顺序（锁定洗牌序，M1）', () => {
  /** 3 个同词性、义项长度相同的候选 → `EN_TO_ZH` 相似度完全并列。 */
  const TIE_POOL: WordWithSenses[] = [
    { wordId: 'w-a', lemma: 'accept', pos: 'v.', senses: ['接受'] },
    { wordId: 'w-b', lemma: 'borrow', pos: 'v.', senses: ['借入'] },
    { wordId: 'w-c', lemma: 'collect', pos: 'v.', senses: ['收集'] },
  ];

  it('相似度并列时按洗牌序输出，固定期望值锁定该行为', () => {
    // 三个候选都是 v. 且义项长度相同 → similarity 全等（0.45 + 0.20 * 1）。
    // 因此输出顺序由 `seededShuffle(pool, seed)` 决定；本用例锁定当前实现，
    // 若未来改动 PRNG/洗牌算法，这里会失败并提醒复核“同 seed 可重放”的承诺。
    expect(generateDistractors(TARGET, TIE_POOL, 'EN_TO_ZH', 'seed-tie')).toEqual([
      '收集',
      '借入',
      '接受',
    ]);
  });

  it('相邻 seed 的并列顺序可能不同（证明顺序确实来自种子而非固定规则）', () => {
    const orders = new Set(
      ['seed-tie-1', 'seed-tie-2', 'seed-tie-3', 'seed-tie-4', 'seed-tie-5'].map((seed) =>
        generateDistractors(TARGET, TIE_POOL, 'EN_TO_ZH', seed).join('|'),
      ),
    );

    expect(orders.size).toBeGreaterThan(1);
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
