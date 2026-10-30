import { afterEach, describe, expect, it, vi } from 'vitest';

import { LOCAL_OWNER_SCOPE } from '@woyao/data';

import {
  ServiceConflictError,
  createImportService,
  createLibraryService,
  type ImportService,
  type LibraryService,
} from './index';
import { createServiceTestHarness, type ServiceTestHarness } from './testSupport';

const harnesses: ServiceTestHarness[] = [];

afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.close();
  }
});

/** 假 LLM：defineWord 给出固定义项（收藏自动建词走这条链路）。 */
function makeLlm() {
  return {
    translate: vi.fn(async () => '译文'),
    defineWord: vi.fn(async (input: { lemma: string }) => [
      { pos: 'n.', simpleZh: `${input.lemma} 的意思`, detailedZh: null },
    ]),
    generateDistractorWords: vi.fn(async () => []),
  };
}

/** 建一套 library + import 服务（与 runtime 相同的装配关系）。 */
function makeService(options: { llm?: ReturnType<typeof makeLlm> | null } = {}): {
  harness: ServiceTestHarness;
  service: LibraryService;
  importService: ImportService;
  llm: ReturnType<typeof makeLlm>;
} {
  const llm = options.llm === null ? makeLlm() : (options.llm ?? makeLlm());
  const harness = createServiceTestHarness({ llm });
  harnesses.push(harness);
  harness.seedSource();
  const service = createLibraryService({ context: harness.context, ownerScope: LOCAL_OWNER_SCOPE });
  const importService = createImportService({
    context: harness.context,
    library: service,
    ownerScope: LOCAL_OWNER_SCOPE,
  });
  // collectWord 通过注入的转发函数复用导入链路（runtime 同款晚绑定）。
  const wired = createLibraryService({
    context: harness.context,
    ownerScope: LOCAL_OWNER_SCOPE,
    importWords: (input) => importService.importWords(input),
  });
  return { harness, service: wired, importService, llm };
}

describe('libraryService：collectWord（R4 收藏干扰词）', () => {
  it('新词形：走 LLM 建词并挂入「我的单词本」，返回 wordId', async () => {
    const { harness, service, llm } = makeService();

    const result = await service.collectWord({ lemma: 'flabbergast' });

    expect(result.collected).toBe(true);
    const word = harness.sync.words.getWordByLemma('flabbergast', LOCAL_OWNER_SCOPE);
    expect(word?.id).toBe(result.wordId);
    // 义项来自 LLM（词典没有这个词）。
    expect(harness.sync.words.listSenses(result.wordId).map((sense) => sense.simpleZh)).toEqual([
      'flabbergast 的意思',
    ]);
    // 词挂在生词本（NOTEBOOK 词库）里。
    const decks = harness.sync.words.listDecks(LOCAL_OWNER_SCOPE);
    const notebook = decks.find((deck) => deck.kind === 'NOTEBOOK');
    expect(notebook).toBeDefined();
    expect(harness.sync.words.listDeckWordIds(notebook!.id)).toContain(result.wordId);
    expect(llm.defineWord).toHaveBeenCalledWith({ lemma: 'flabbergast', phrase: false });
  });

  it('词已在生词本：直接返回，不再调用导入链路', async () => {
    const { service, llm } = makeService();
    await service.collectWord({ lemma: 'flabbergast' });
    const first = llm.defineWord.mock.calls.length;

    const again = await service.collectWord({ lemma: ' flabbergast ' });

    expect(again.collected).toBe(true);
    // 幂等：LLM 未再被调用（含首尾空白的词形也已归一化匹配）。
    expect(llm.defineWord.mock.calls.length).toBe(first);
  });

  it('内置词典已有的词：直接挂入生词本，不重复建词、不烧 LLM', async () => {
    const { harness, service, llm } = makeService();
    const dictionaryId = harness.seedWord({
      id: 'dict-abandon',
      lemma: 'abandon',
      ownerScope: LOCAL_OWNER_SCOPE,
      senses: [{ pos: 'v.', simpleZh: '放弃' }],
    });

    const result = await service.collectWord({ lemma: 'abandon' });

    expect(result.wordId).toBe(dictionaryId);
    expect(llm.defineWord).not.toHaveBeenCalled();
    // 词形归一化：大小写不同也命中同一词条。
    const again = await service.collectWord({ lemma: 'Abandon' });
    expect(again.wordId).toBe(dictionaryId);
  });

  it('LLM 失败且词典没有：抛 CONFLICT（绝不建「暂无释义」占位词条）', async () => {
    const llm = makeLlm();
    llm.defineWord.mockRejectedValue(new Error('离线'));
    const { harness, service } = makeService({ llm });

    await expect(service.collectWord({ lemma: 'flabbergast' })).rejects.toBeInstanceOf(
      ServiceConflictError,
    );
    expect(harness.sync.words.getWordByLemma('flabbergast', LOCAL_OWNER_SCOPE)).toBeNull();
  });
});
