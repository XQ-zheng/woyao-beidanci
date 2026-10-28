import { afterEach, describe, expect, it } from 'vitest';

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
function makeService(): {
  harness: ServiceTestHarness;
  service: ImportService;
  makeDeck: () => Promise<string>;
} {
  const harness = createServiceTestHarness();
  harnesses.push(harness);
  const library = createLibraryService({ context: harness.context, ownerScope: LOCAL_OWNER_SCOPE });
  const service = createImportService({ context: harness.context, library, ownerScope: LOCAL_OWNER_SCOPE });
  const makeDeck = async (): Promise<string> => {
    const deck = await library.createDeck({ name: '测试词库', kind: 'CUSTOM' });
    return deck.deckId;
  };
  return { harness, service, makeDeck };
}

describe('importService：批量导入', () => {
  it('导入一批无词典释义的词，返回 imported 计数并挂到词库', async () => {
    const { harness, service, makeDeck } = makeService();
    const deckId = await makeDeck();

    const result = await service.importWords({
      deckId,
      terms: [{ lemma: 'apple' }, { lemma: 'banana' }, { lemma: 'apple' }],
    });

    expect(result.imported).toBe(2); // apple 重复只算一次
    expect(result.duplicates).toBe(1);
    expect(result.withDefinition).toBe(0);
    expect(result.withoutDefinition).toBe(2); // apple + banana 两个新词，都无释义

    // 词确实挂到了词库
    const wordIds = harness.sync.words.listDeckWordIds(deckId);
    expect(wordIds).toHaveLength(2);
  });

  it('命中内置词典时复用释义并标记 withDefinition', async () => {
    const { harness, service, makeDeck } = makeService();
    const deckId = await makeDeck();

    // 播种一个「内置词典」词条（LOCAL 归属，义项 sourceId 默认 local-user）
    harness.seedWord({
      id: 'dict-abandon',
      lemma: 'abandon',
      ownerScope: LOCAL_OWNER_SCOPE,
      senses: [{ pos: 'v.', simpleZh: '放弃' }],
    });

    const result = await service.importWords({
      deckId,
      terms: [{ lemma: 'abandon' }, { lemma: 'unknownwordxyz' }],
    });

    // abandon 命中词典词条（LOCAL 归属），createWord 视为「已存在」→ 复用释义、算重复；
    // unknownwordxyz 词典没有 → 新建空释义词条。
    expect(result.imported).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(result.withDefinition).toBe(0); // 释义词是「重复」不是「新建」，不计入 withDefinition
    expect(result.withoutDefinition).toBe(1);

    const abandonRow = result.rows.find((row) => row.lemma === 'abandon');
    expect(abandonRow?.hasDefinition).toBe(true);
    expect(abandonRow?.senses[0]?.simpleZh).toBe('放弃');
    expect(abandonRow?.imported).toBe(false);
  });

  it('导入到不存在的词库抛 NOT_FOUND', async () => {
    const { service } = makeService();

    await expect(
      service.importWords({ deckId: 'missing', terms: [{ lemma: 'apple' }] }),
    ).rejects.toBeInstanceOf(ServiceNotFoundError);
  });

  it('短语条目正常建词', async () => {
    const { service, makeDeck } = makeService();
    const deckId = await makeDeck();

    const result = await service.importWords({
      deckId,
      terms: [{ lemma: 'give up', phrase: true }],
    });

    expect(result.imported).toBe(1);
    expect(result.rows[0]?.lemma).toBe('give up');
  });
});
