import { afterEach, describe, expect, it } from 'vitest';

import { LOCAL_OWNER_SCOPE } from '@woyao/data';

import { ServiceNotFoundError, createLibraryService, type LibraryService } from './index';
import { createServiceTestHarness, type ServiceTestHarness } from './testSupport';

const harnesses: ServiceTestHarness[] = [];

afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.close();
  }
});

/** 建一个跑在真实内存库上的词库服务，并播种一个词条（带一个占位义项）。 */
function makeService(): {
  harness: ServiceTestHarness;
  service: LibraryService;
  wordId: string;
} {
  const harness = createServiceTestHarness();
  harnesses.push(harness);
  harness.seedSource();
  const wordId = harness.seedWord({
    id: 'w-1',
    lemma: 'LLM',
    ownerScope: LOCAL_OWNER_SCOPE,
    senses: [{ pos: '', simpleZh: '（暂无释义）' }],
  });
  const service = createLibraryService({ context: harness.context, ownerScope: LOCAL_OWNER_SCOPE });
  return { harness, service, wordId };
}

describe('libraryService：编辑义项', () => {
  it('更新义项后读回新值（词性/简明/详细全部生效）', async () => {
    const { service, wordId } = makeService();

    const updated = await service.updateWordSense({
      wordId,
      senseNo: 1,
      pos: 'n.',
      simpleZh: '大型语言模型',
      detailedZh: 'Large Language Model 的缩写',
    });

    expect(updated.simpleZh).toBe('大型语言模型');
    expect(updated.pos).toBe('n.');
    expect(updated.detailedZh).toBe('Large Language Model 的缩写');

    // 直接从仓储读回，确认真实落库（而不是只改了返回值）
    const harness = harnesses[harnesses.length - 1];
    const senses = harness.sync.words.listSenses(wordId);
    expect(senses[0]?.simpleZh).toBe('大型语言模型');
    expect(senses[0]?.revision).toBeGreaterThan(0);
  });

  it('词条不存在抛 NOT_FOUND', async () => {
    const { service } = makeService();

    await expect(
      service.updateWordSense({
        wordId: 'missing',
        senseNo: 1,
        pos: 'n.',
        simpleZh: '任意',
      }),
    ).rejects.toBeInstanceOf(ServiceNotFoundError);
  });

  it('义项序号不存在抛 NOT_FOUND', async () => {
    const { service, wordId } = makeService();

    await expect(
      service.updateWordSense({
        wordId,
        senseNo: 9,
        pos: 'n.',
        simpleZh: '任意',
      }),
    ).rejects.toBeInstanceOf(ServiceNotFoundError);
  });

  it('简明释义为空时校验拦截', async () => {
    const { service, wordId } = makeService();

    await expect(
      service.updateWordSense({ wordId, senseNo: 1, pos: 'n.', simpleZh: '   ' }),
    ).rejects.toThrow(/简明释义不能为空/u);
  });
});
