import { afterEach, describe, expect, it } from 'vitest';

import {
  ServiceNotFoundError,
  asyncify,
  createContentService,
  createOnlineService,
  type ContentService,
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

/** 在线词典的正常响应。 */
const DICTIONARY_RESPONSE = [
  {
    word: 'abandon',
    phonetics: [{ text: '/əˈbændən/', audio: 'https://example.com/abandon-uk.mp3' }],
    meanings: [{ partOfSpeech: 'verb', definitions: [{ definition: 'to leave someone' }] }],
  },
];

/** 装配内容服务（默认 404 假 http，按需覆盖）。 */
function makeContent(options: {
  http?: HttpPort;
  network?: NetworkMonitorPort;
} = {}): { harness: ServiceTestHarness; service: ContentService; calls: number } {
  const harness = createServiceTestHarness({ http: options.http, network: options.network });
  harnesses.push(harness);
  const online = createOnlineService({ context: harness.context });
  const service = createContentService({
    context: harness.context,
    contentCache: asyncify(harness.sync.contentCache),
    online,
  });
  return { harness, service, calls: 0 };
}

/** 造一个没有义项、但带音标的词（用于发音回退与在线命中路径）。 */
function seedBareWord(harness: ServiceTestHarness): void {
  harness.sync.words.createWord({
    id: 'w-1',
    ownerScope: 'LOCAL',
    lemma: 'abandon',
    phoneticUk: '/əˈbændən/',
    phoneticUs: null,
    senses: [],
    deviceId: harness.deviceId,
    now: new Date(harness.nowIso),
  });
}

describe('contentService：getWordContent', () => {
  it('本地有义项 → source=LOCAL，且不触发在线', async () => {
    let onlineCalls = 0;
    const { harness, service } = makeContent({
      http: {
        getJson: async () => {
          onlineCalls += 1;
          return { status: 200, data: DICTIONARY_RESPONSE };
        },
        getText: async () => ({ status: 404, body: '' }),
      },
    });
    harness.seedWord({
      id: 'w-1',
      lemma: 'abandon',
      senses: [{ pos: 'v.', simpleZh: '放弃', detailedZh: '放弃某物' }],
    });

    const result = await service.getWordContent({ wordId: 'w-1' });

    expect(result.source).toBe('LOCAL');
    expect(result.senses).toEqual([
      { senseNo: 1, pos: 'v.', simpleZh: '放弃', detailedZh: '放弃某物', contextText: null },
    ]);
    expect(onlineCalls).toBe(0);
  });

  it('本地无义项 + 在线命中 → source=ONLINE 且落缓存', async () => {
    const { harness, service } = makeContent({
      http: {
        getJson: async () => ({ status: 200, data: DICTIONARY_RESPONSE }),
        getText: async () => ({ status: 404, body: '' }),
      },
    });
    seedBareWord(harness);

    const result = await service.getWordContent({ wordId: 'w-1' });

    expect(result.source).toBe('ONLINE');
    expect(result.senses.map((sense) => sense.simpleZh)).toEqual(['to leave someone']);
    // 已落缓存（key 用 lemma）。
    expect(harness.sync.contentCache.get('content:word:abandon')).not.toBeNull();
  });

  it('离线/在线失败 → source=NONE 空义项，不抛错', async () => {
    const { harness, service } = makeContent({ network: { isOnline: () => false } });
    seedBareWord(harness);

    const result = await service.getWordContent({ wordId: 'w-1' });

    expect(result.source).toBe('NONE');
    expect(result.senses).toEqual([]);
    // 本地音标仍返回（不因在线失败丢失）。
    expect(result.phoneticUk).toBe('/əˈbændən/');
  });

  it('缓存命中不重复调 Http', async () => {
    let onlineCalls = 0;
    const { harness, service } = makeContent({
      http: {
        getJson: async () => {
          onlineCalls += 1;
          return { status: 200, data: DICTIONARY_RESPONSE };
        },
        getText: async () => ({ status: 404, body: '' }),
      },
    });
    seedBareWord(harness);

    await service.getWordContent({ wordId: 'w-1' });
    await service.getWordContent({ wordId: 'w-1' });

    expect(onlineCalls).toBe(1);
  });

  it('词条不存在 → NOT_FOUND', async () => {
    const { service } = makeContent();

    await expect(service.getWordContent({ wordId: 'ghost' })).rejects.toBeInstanceOf(
      ServiceNotFoundError,
    );
  });
});

describe('contentService：getPronunciation', () => {
  it('在线失败回退本地音标（url=null，phoneticText 来自 words 表）', async () => {
    const { harness, service } = makeContent();
    seedBareWord(harness);

    const result = await service.getPronunciation({ wordId: 'w-1', accent: 'uk' });

    expect(result.url).toBeNull();
    expect(result.phoneticText).toBe('/əˈbændən/');
    expect(result.accent).toBe('uk');
  });

  it('在线命中返回音频 URL 并缓存', async () => {
    const { harness, service } = makeContent({
      http: {
        getJson: async () => ({ status: 200, data: DICTIONARY_RESPONSE }),
        getText: async () => ({ status: 404, body: '' }),
      },
    });
    seedBareWord(harness);

    const result = await service.getPronunciation({ wordId: 'w-1', accent: 'uk' });

    expect(result.url).toBe('https://example.com/abandon-uk.mp3');
    expect(harness.sync.contentCache.get('audio:abandon:uk')).not.toBeNull();
  });
});
