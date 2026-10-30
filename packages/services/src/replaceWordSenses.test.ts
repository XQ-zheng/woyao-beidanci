import { afterEach, describe, expect, it } from 'vitest';

import { LOCAL_OWNER_SCOPE } from '@woyao/data';

import { ServiceNotFoundError, ServiceValidationError, createLibraryService, type LibraryService } from './index';
import { createServiceTestHarness, type ServiceTestHarness } from './testSupport';

const harnesses: ServiceTestHarness[] = [];

afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.close();
  }
});

/** 建一个跑在真实内存库上的词库服务，并播种一个三义项词条。 */
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
    lemma: 'abandon',
    ownerScope: LOCAL_OWNER_SCOPE,
    senses: [
      { pos: 'v.', simpleZh: '放弃' },
      { pos: 'v.', simpleZh: '抛弃' },
      { pos: 'n.', simpleZh: '放纵' },
    ],
  });
  const service = createLibraryService({ context: harness.context, ownerScope: LOCAL_OWNER_SCOPE });
  return { harness, service, wordId };
}

describe('libraryService：重建义项（R1）', () => {
  it('传入数组就是重建后的全部义项：删一条、改一条、序号重排为 1..N', async () => {
    const { harness, service, wordId } = makeService();

    const result = await service.replaceWordSenses({
      wordId,
      senses: [
        { pos: 'v.', simpleZh: '离弃', detailedZh: '彻底离开并舍弃' },
        { pos: 'n.', simpleZh: '放纵' },
      ],
    });

    expect(result.map((sense) => `${String(sense.senseNo)}:${sense.simpleZh}`)).toEqual([
      '1:离弃',
      '2:放纵',
    ]);
    expect(result[0]?.detailedZh).toBe('彻底离开并舍弃');
    // 数据层真表断言：第三条软删。
    const rows = harness.db
      .prepare('SELECT sense_no, simple_zh, deleted_at FROM word_senses WHERE word_id = ? ORDER BY rowid ASC')
      .all(wordId) as { sense_no: number; simple_zh: string; deleted_at: string | null }[];
    expect(rows[2]).toMatchObject({ sense_no: 3, deleted_at: expect.anything() });
  });

  it('追加义项：不足的部分新 insert，序号接续重排', async () => {
    const { service, wordId } = makeService();

    const result = await service.replaceWordSenses({
      wordId,
      senses: [
        { pos: 'v.', simpleZh: '放弃' },
        { pos: 'v.', simpleZh: '抛弃' },
        { pos: 'n.', simpleZh: '放纵' },
        { pos: 'adj.', simpleZh: '肆意的' },
      ],
    });

    expect(result.map((sense) => sense.senseNo)).toEqual([1, 2, 3, 4]);
    expect(result[3]?.simpleZh).toBe('肆意的');
  });

  it('词条不存在或归属不符抛 NOT_FOUND', async () => {
    const { service } = makeService();

    await expect(
      service.replaceWordSenses({ wordId: 'missing', senses: [{ pos: '', simpleZh: '任意' }] }),
    ).rejects.toBeInstanceOf(ServiceNotFoundError);
  });

  it('空数组 / 超过 10 条 / 空简明释义被校验拦截', async () => {
    const { service, wordId } = makeService();

    await expect(
      service.replaceWordSenses({ wordId, senses: [] }),
    ).rejects.toBeInstanceOf(ServiceValidationError);
    await expect(
      service.replaceWordSenses({
        wordId,
        senses: Array.from({ length: 11 }, (_unused, index) => ({ pos: '', simpleZh: `义项${String(index)}` })),
      }),
    ).rejects.toBeInstanceOf(ServiceValidationError);
    await expect(
      service.replaceWordSenses({ wordId, senses: [{ pos: '', simpleZh: '   ' }] }),
    ).rejects.toBeInstanceOf(ServiceValidationError);
  });
});
