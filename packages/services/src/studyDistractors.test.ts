import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  asyncify,
  createContentService,
  createLibraryService,
  createOnlineService,
  createStudyService,
  selectAnswerSenseIndex,
  type ContentService,
  type StudyService,
} from './index';
import { createSettingsService } from './settingsService';
import { createServiceTestHarness, type ServiceTestHarness } from './testSupport';

const harnesses: ServiceTestHarness[] = [];

afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.close();
  }
});

const NOW_ISO = '2025-03-01T08:00:00.000Z';

/** 假 LLM：按目标词形返回固定的相近干扰词池（可按用例覆盖）。 */
function makeLlm(pool: (lemma: string) => { lemma: string; meaningZh: string }[] = () => []) {
  return {
    translate: vi.fn(async () => '译文'),
    defineWord: vi.fn(async () => []),
    generateDistractorWords: vi.fn(async (input: { lemma: string; count: number }) =>
      pool(input.lemma),
    ),
  };
}

/** 播种 4 个多义项词进一个词库（词库候选机制的数据基础）。 */
function seedDeck(harness: ServiceTestHarness): string {
  const wordIds: string[] = [];
  for (let index = 1; index <= 4; index += 1) {
    const wordId = `w-${String(index)}`;
    harness.seedWord({
      id: wordId,
      lemma: `word${String(index)}`,
      senses: [
        { pos: 'v.', simpleZh: `释义${String(index)}甲` },
        { pos: 'n.', simpleZh: `释义${String(index)}乙` },
      ],
    });
    wordIds.push(wordId);
  }
  return harness.seedDeck({ id: 'deck-1', name: '四级核心', wordIds });
}

/** 装配一套 study + content（`withLlm: false` 模拟 LLM 未配置）。 */
function makeEnv(options: { withLlm?: boolean } = {}): {
  harness: ServiceTestHarness;
  study: StudyService;
  content: ContentService;
  llm: ReturnType<typeof makeLlm>;
} {
  const llm = makeLlm();
  const harness = createServiceTestHarness(options.withLlm === false ? {} : { llm });
  harnesses.push(harness);
  const settings = createSettingsService({
    context: harness.context,
    defaultTimeZone: 'Asia/Shanghai',
  });
  const content = createContentService({
    context: harness.context,
    contentCache: asyncify(harness.sync.contentCache),
    online: createOnlineService({ context: harness.context }),
  });
  const study = createStudyService({ context: harness.context, settings, content });
  return { harness, study, content, llm };
}

/** 与 runtime 同款装配：library 注入 content（预热）与转发 importWords。 */
function makeLibrary(harness: ServiceTestHarness, content: ContentService) {
  return createLibraryService({ context: harness.context, content });
}

describe('studyService：AI 干扰项（R3）', () => {
  it('AI 池够 3 个时优先用 AI 干扰项，词库候选一次都不读；池落缓存、两次会话选项一致', async () => {
    const { harness, study, llm } = makeEnv();
    llm.generateDistractorWords.mockImplementation(async () => [
      { lemma: 'abdicate', meaningZh: '退位' },
      { lemma: 'abduct', meaningZh: '绑架' },
      { lemma: 'abash', meaningZh: '使羞愧' },
    ]);
    const deckId = seedDeck(harness);

    const first = await study.startSession({ deckId, now: new Date(NOW_ISO) });
    const card = first.cards[0]!;
    expect(card.style).toBe('CHOICE');

    // 选项 = 正确答案（该词全部义项拼接）+ 3 个 AI 释义；每个干扰项都能映射回来源词形。
    expect(card.answer).toBe('释义1甲；释义1乙');
    expect(selectAnswerSenseIndex('deck-1|2025-03-01', 'w-1', 2)).toBeGreaterThanOrEqual(0);
    expect(card.options).toHaveLength(4);
    const distractorTexts = card.options.filter((text) => text !== card.answer);
    expect(new Set(distractorTexts)).toEqual(new Set(['退位', '绑架', '使羞愧']));
    const lemmaByText = new Map(card.distractorWords?.map((item) => [item.text, item.lemma]));
    expect(lemmaByText.get('退位')).toBe('abdicate');
    expect(lemmaByText.get('绑架')).toBe('abduct');

    // AI 池已落缓存：重开会话不再烧 LLM，选项完全一致（种子确定性不因 AI 而破坏）。
    const callsAfterFirst = llm.generateDistractorWords.mock.calls.length;
    const second = await study.startSession({ deckId, now: new Date(NOW_ISO) });
    const secondCard = second.cards[0]!;
    expect(llm.generateDistractorWords.mock.calls.length).toBe(callsAfterFirst);
    expect(secondCard.options).toEqual(card.options);
  });

  it('LLM 未配置：回退词库候选机制（绝不编造），不抛错', async () => {
    const { harness, study } = makeEnv({ withLlm: false });
    const deckId = seedDeck(harness);

    const session = await study.startSession({ deckId, now: new Date(NOW_ISO) });
    const card = session.cards[0]!;

    // 正确答案 + 词库候选的释义。
    expect(card.options).toContain(card.answer);
    expect(card.options.length).toBeGreaterThan(1);
    const distractor = card.distractorWords?.find((item) => item.text !== card.answer);
    expect(distractor).toBeDefined();
    // 词库候选的来源词形可回查（收藏五角星按它建词）。
    expect(distractor?.lemma).toMatch(/^word\d$/u);
  });
});

describe('studyService：自定义干扰词（R5）', () => {
  it('自定义词必占一席（文本取其 AI 池释义，词形记用户指定的词形），AI 池补足其余席位', async () => {
    const { harness, study, llm } = makeEnv();
    llm.generateDistractorWords.mockImplementation(async (input: { lemma: string }) =>
      input.lemma === 'zzz'
        ? [{ lemma: 'zzz-like', meaningZh: '自定义词的相近释义' }]
        : [{ lemma: 'abdicate', meaningZh: '退位' }],
    );
    const deckId = seedDeck(harness);
    harness.sync.words.setWordDistractors({
      wordId: 'w-1',
      lemmas: ['zzz'],
      deviceId: harness.deviceId,
      now: new Date(harness.nowIso),
    });

    const session = await study.startSession({ deckId, now: new Date(NOW_ISO) });
    const card = session.cards[0]!;

    expect(card.options).toContain('自定义词的相近释义');
    expect(card.options).toContain('退位');
    const lemmaByText = new Map(card.distractorWords?.map((item) => [item.text, item.lemma]));
    // 关键：收藏五角星拿到的是用户指定的词形 zzz，而不是相近词 zzz-like。
    expect(lemmaByText.get('自定义词的相近释义')).toBe('zzz');
    expect(lemmaByText.get('退位')).toBe('abdicate');
  });

  it('自定义词的 AI 池为空时放弃该席（绝不编造），回退词库候选', async () => {
    const { harness, study, llm } = makeEnv();
    llm.generateDistractorWords.mockImplementation(async (input: { lemma: string }) =>
      input.lemma === 'zzz' ? [] : [{ lemma: 'abdicate', meaningZh: '退位' }],
    );
    const deckId = seedDeck(harness);
    harness.sync.words.setWordDistractors({
      wordId: 'w-1',
      lemmas: ['zzz'],
      deviceId: harness.deviceId,
      now: new Date(harness.nowIso),
    });

    const session = await study.startSession({ deckId, now: new Date(NOW_ISO) });
    const card = session.cards[0]!;

    expect(card.options).not.toContain('zzz');
    expect(card.options).toContain('退位');
    // 不足 3 个干扰项：词库候选补足。
    expect(card.options.length).toBeGreaterThanOrEqual(2);
  });
});

describe('libraryService：setWordDistractors / listWordDistractors（R5 服务层）', () => {
  it('去重、剔除自身、落库并预热 AI 池（落 content_cache）', async () => {
    const { harness, content, llm } = makeEnv();
    seedDeck(harness);
    llm.generateDistractorWords.mockImplementation(async (input: { lemma: string }) => [
      { lemma: `${input.lemma}-like`, meaningZh: `${input.lemma} 的相近释义` },
    ]);
    const library = makeLibrary(harness, content);

    const saved = await library.setWordDistractors({
      wordId: 'w-1',
      lemmas: ['Zzz', 'zzz', 'yyy'],
    });

    // 去重（大小写口径）、剔除自身 word1。
    expect(saved).toEqual(['Zzz', 'yyy']);
    expect(harness.sync.words.listWordDistractors('w-1')).toEqual(['Zzz', 'yyy']);
    // 每个干扰词都预热了 AI 池。
    expect(llm.generateDistractorWords).toHaveBeenCalledWith({ lemma: 'Zzz', count: 6 });
    expect(llm.generateDistractorWords).toHaveBeenCalledWith({ lemma: 'yyy', count: 6 });
    expect(harness.sync.contentCache.get('distractors:zzz')).not.toBeNull();
    expect(harness.sync.contentCache.get('distractors:yyy')).not.toBeNull();
  });

  it('listWordDistractors 读回保存的词形（未设置时为空数组）', async () => {
    const { harness, content } = makeEnv();
    seedDeck(harness);
    const library = makeLibrary(harness, content);

    expect(await library.listWordDistractors({ wordId: 'w-1' })).toEqual([]);

    await library.setWordDistractors({ wordId: 'w-1', lemmas: ['zzz'] });
    expect(await library.listWordDistractors({ wordId: 'w-1' })).toEqual(['zzz']);
  });
});
