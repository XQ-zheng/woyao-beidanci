import { afterEach, describe, expect, it, vi } from 'vitest';

import { LOCAL_OWNER_SCOPE } from '@woyao/data';

import { ServiceNotFoundError, createImportService, createLibraryService, type ImportService } from './index';
import { createServiceTestHarness, type ServiceTestHarness } from './testSupport';

const harnesses: ServiceTestHarness[] = [];

afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.close();
  }
});

/** 建一个跑在真实内存库上的导入服务（含词库服务）。 */
function makeService(
  llm?: {
    defineWord: (input: { lemma: string; phrase: boolean }) => Promise<
      ReadonlyArray<{ pos: string; simpleZh: string; detailedZh: string | null }>
    >;
  },
): {
  harness: ServiceTestHarness;
  service: ImportService;
  makeDeck: () => Promise<string>;
} {
  const harness = createServiceTestHarness(
    llm === undefined ? {} : { llm: { translate: async () => '', defineWord: llm.defineWord } },
  );
  harnesses.push(harness);
  const library = createLibraryService({ context: harness.context, ownerScope: LOCAL_OWNER_SCOPE });
  const service = createImportService({ context: harness.context, library, ownerScope: LOCAL_OWNER_SCOPE });
  const makeDeck = async (): Promise<string> => {
    const deck = await library.createDeck({ name: '测试词库', kind: 'CUSTOM' });
    return deck.deckId;
  };
  return { harness, service, makeDeck };
}

describe('importService：批量导入（内置词典）', () => {
  it('命中内置词典的词条直接复用释义（视为已存在）', async () => {
    const { harness, service, makeDeck } = makeService();
    const deckId = await makeDeck();

    harness.seedWord({
      id: 'dict-abandon',
      lemma: 'abandon',
      ownerScope: LOCAL_OWNER_SCOPE,
      senses: [{ pos: 'v.', simpleZh: '放弃' }],
    });

    const result = await service.importWords({
      deckId,
      terms: [{ lemma: 'abandon' }],
    });

    expect(result.duplicates).toBe(1);
    expect(result.imported).toBe(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.rows[0]?.senses[0]?.simpleZh).toBe('放弃');
  });

  it('导入到不存在的词库抛 NOT_FOUND', async () => {
    const { service } = makeService();

    await expect(
      service.importWords({ deckId: 'missing', terms: [{ lemma: 'apple' }] }),
    ).rejects.toBeInstanceOf(ServiceNotFoundError);
  });
});

describe('importService：云端 LLM 补释义', () => {
  it('词典查不到时调 LLM 生成义项并建词（不产生占位词条）', async () => {
    const defineWord = vi.fn(async () => [{ pos: 'n.', simpleZh: '苹果', detailedZh: null }]);
    const { harness, service, makeDeck } = makeService({ defineWord });
    const deckId = await makeDeck();

    const result = await service.importWords({ deckId, terms: [{ lemma: 'apple' }] });

    expect(defineWord).toHaveBeenCalledWith({ lemma: 'apple', phrase: false });
    expect(result.imported).toBe(1);
    expect(result.skipped).toHaveLength(0);
    expect(result.rows[0]?.senses[0]?.simpleZh).toBe('苹果');
    // 数据库里确实有释义（不再有占位文案）
    const senses = harness.sync.words.listSenses(harness.sync.words.listDeckWordIds(deckId)[0] ?? '');
    expect(senses[0]?.simpleZh).toBe('苹果');
  });

  it('LLM 失败时跳过该词并在报告里给出原因（不建占位词条）', async () => {
    const defineWord = vi.fn(async () => {
      throw new Error('额度用尽');
    });
    const { service, makeDeck } = makeService({ defineWord });
    const deckId = await makeDeck();

    const result = await service.importWords({
      deckId,
      terms: [{ lemma: 'mystery' }, { lemma: 'apple' }],
    });

    // mystery 和 apple 词典都没有，LLM 又失败，两个都跳过（不建占位词条）
    expect(result.skipped.map((item) => item.lemma)).toEqual(['mystery', 'apple']);
    expect(result.imported).toBe(0);
  });

  it('LLM 未配置时跳过并说明原因', async () => {
    const { service, makeDeck } = makeService(); // 不注入 LLM
    const deckId = await makeDeck();

    const result = await service.importWords({ deckId, terms: [{ lemma: 'apple' }] });

    expect(result.imported).toBe(0);
    expect(result.skipped[0]?.reason).toContain('云端 AI 未配置');
  });

  it('LLM 同时给单词和短语生成释义', async () => {
    const defineWord = vi.fn(async ({ phrase }: { lemma: string; phrase: boolean }) => [
      phrase
        ? { pos: 'phr.', simpleZh: '期待；期盼', detailedZh: null }
        : { pos: 'v.', simpleZh: '期待', detailedZh: null },
    ]);
    const { service, makeDeck } = makeService({ defineWord });
    const deckId = await makeDeck();

    const result = await service.importWords({
      deckId,
      terms: [{ lemma: 'look forward to', phrase: true }],
    });

    expect(defineWord).toHaveBeenCalledWith({ lemma: 'look forward to', phrase: true });
    expect(result.imported).toBe(1);
    expect(result.rows[0]?.senses[0]?.simpleZh).toBe('期待；期盼');
  });
});

describe('importService：占位词条补全', () => {
  it('历史占位词条再次导入时用 LLM 补全释义（backfilled）', async () => {
    const harness0 = createServiceTestHarness({
      llm: {
        translate: async () => '',
        defineWord: async () => [{ pos: 'n.', simpleZh: '苹果', detailedZh: null }],
      },
    });
    harnesses.push(harness0);
    // 先用旧口径建一个「占位」词条（模拟历史数据）
    harness0.seedSource();
    harness0.seedWord({
      id: 'placeholder-apple',
      lemma: 'apple',
      ownerScope: LOCAL_OWNER_SCOPE,
      senses: [{ pos: '', simpleZh: '（暂无释义）' }],
    });

    const library = createLibraryService({ context: harness0.context, ownerScope: LOCAL_OWNER_SCOPE });
    const service = createImportService({ context: harness0.context, library, ownerScope: LOCAL_OWNER_SCOPE });
    const deck = await library.createDeck({ name: '测试词库', kind: 'CUSTOM' });

    const result = await service.importWords({
      deckId: deck.deckId,
      terms: [{ lemma: 'apple' }],
    });

    expect(result.backfilled).toBe(1);
    expect(result.duplicates).toBe(0);
    expect(result.rows[0]?.backfilled).toBe(true);
    // 义项已被真实释义替换
    const senses = harness0.sync.words.listSenses('placeholder-apple');
    expect(senses.some((sense) => sense.simpleZh === '苹果')).toBe(true);
  });
});
