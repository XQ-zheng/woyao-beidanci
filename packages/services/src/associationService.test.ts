import { afterEach, describe, expect, it } from 'vitest';

import {
  ServiceNotFoundError,
  ServiceValidationError,
  asyncify,
  createAssociationService,
  createOnlineService,
  type AssociationService,
  type HttpPort,
  type NetworkMonitorPort,
} from './index';
import { createServiceTestHarness, type ServiceTestHarness } from './testSupport';

const harnesses: ServiceTestHarness[] = [];

afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.close();
  }
});

/** 装配联想服务。 */
function makeAssoc(options: {
  http?: HttpPort;
  network?: NetworkMonitorPort;
  associationProviderUrl?: string;
} = {}): { harness: ServiceTestHarness; service: AssociationService } {
  const harness = createServiceTestHarness({ http: options.http, network: options.network });
  harnesses.push(harness);
  const online = createOnlineService({
    context: harness.context,
    ...(options.associationProviderUrl === undefined
      ? {}
      : { associationProviderUrl: options.associationProviderUrl }),
  });
  const service = createAssociationService({
    context: harness.context,
    associations: asyncify(harness.sync.associations),
    online,
  });
  return { harness, service };
}

/** 播种一个词（联想有外键）。 */
function seedWord(harness: ServiceTestHarness, id = 'w-1', lemma = 'abandon'): void {
  harness.seedWord({ id, lemma });
}

describe('associationService：本地增删查', () => {
  it('add → list → remove，且 add 会复用 local-user 来源引导', async () => {
    const { harness, service } = makeAssoc();
    seedWord(harness);

    const created = await service.addAssociation({
      wordId: 'w-1',
      kind: 'MEANING',
      text: 'abandon → 阿爸，别抛弃我',
      originUrl: 'https://example.com/abandon',
    });
    expect(created).toMatchObject({
      wordId: 'w-1',
      kind: 'MEANING',
      text: 'abandon → 阿爸，别抛弃我',
      originUrl: 'https://example.com/abandon',
      generatedBy: 'USER',
    });

    expect((await service.listAssociations({ wordId: 'w-1' })).map((item) => item.id)).toEqual([
      created.id,
    ]);

    // 复用 libraryService 的来源引导：同一份 local-user，type=USER。
    const source = harness.db
      .prepare('SELECT type, name FROM sources WHERE id = ?')
      .get('local-user') as { type: string; name: string } | undefined;
    expect(source).toEqual({ type: 'USER', name: '本地自建内容' });

    await service.removeAssociation({ id: created.id });
    expect(await service.listAssociations({ wordId: 'w-1' })).toEqual([]);
  });

  it('词条不存在时 add 抛 NOT_FOUND', async () => {
    const { service } = makeAssoc();

    await expect(
      service.addAssociation({ wordId: 'ghost', kind: 'MEANING', text: 'x' }),
    ).rejects.toBeInstanceOf(ServiceNotFoundError);
  });

  it('originUrl 落库，assetUri 不进入服务写入（公开入参拒收 assetUri）', async () => {
    const { harness, service } = makeAssoc();
    seedWord(harness);

    await service.addAssociation({
      wordId: 'w-1',
      kind: 'PICTOGRAPH',
      text: '画一座被抛弃的岛',
      originUrl: 'https://example.com/pic',
    });
    const [record] = await service.listAssociations({ wordId: 'w-1' });
    expect(record?.originUrl).toBe('https://example.com/pic');
    // 服务写入的 assetUri 恒为 null（二进制只存本机，绝不经公开入参/同步 payload）。
    expect(record?.assetUri).toBeNull();

    // strictObject：带 assetUri 的入参直接 VALIDATION_FAILED，保证服务层永远不写它。
    await expect(
      service.addAssociation({
        wordId: 'w-1',
        kind: 'MEANING',
        text: 'x',
        assetUri: 'file:///tmp/leak.png',
      } as unknown as Parameters<AssociationService['addAssociation']>[0]),
    ).rejects.toBeInstanceOf(ServiceValidationError);
  });
});

describe('associationService：enrichOnline', () => {
  it('去重：同 kind+text 已在本地则不再落库；重复 enrich 不再新增', async () => {
    const { harness, service } = makeAssoc({
      associationProviderUrl: 'https://assoc.example.com',
      http: {
        getJson: async () => ({
          status: 200,
          data: [
            { text: '已有联想', originUrl: null },
            { text: '新联想', originUrl: 'https://example.com/new' },
          ],
        }),
        getText: async () => ({ status: 404, body: '' }),
      },
    });
    seedWord(harness);

    await service.addAssociation({ wordId: 'w-1', kind: 'MEANING', text: '已有联想' });

    const first = await service.enrichOnline({ wordId: 'w-1', kind: 'MEANING' });
    // 两条联想的 created_at 相同，排序会落到 UUID 决胜——断言只看集合，不看顺序。
    expect([...first.map((item) => item.text)].sort()).toEqual(['已有联想', '新联想']);
    expect(first.find((item) => item.text === '新联想')?.generatedBy).toBe('ONLINE');
    expect(first.find((item) => item.text === '新联想')?.originUrl).toBe('https://example.com/new');

    const count = harness.db.prepare('SELECT COUNT(*) AS n FROM associations').get() as {
      n: number;
    };
    expect(count.n).toBe(2);

    const second = await service.enrichOnline({ wordId: 'w-1', kind: 'MEANING' });
    expect([...second.map((item) => item.text)].sort()).toEqual(['已有联想', '新联想']);
    const after = harness.db.prepare('SELECT COUNT(*) AS n FROM associations').get() as {
      n: number;
    };
    expect(after.n).toBe(2);
  });

  it('离线/无 provider → 只返回本地，不报错', async () => {
    const { harness, service } = makeAssoc({ network: { isOnline: () => false } });
    seedWord(harness);
    await service.addAssociation({ wordId: 'w-1', kind: 'MEANING', text: '本地联想' });

    const result = await service.enrichOnline({ wordId: 'w-1', kind: 'MEANING' });

    expect(result.map((item) => item.text)).toEqual(['本地联想']);
  });
});
