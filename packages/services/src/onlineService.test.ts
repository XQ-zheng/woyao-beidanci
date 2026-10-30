import { afterEach, describe, expect, it } from 'vitest';

import {
  NotConfiguredError,
  ProviderError,
  createOnlineService,
  type HttpPort,
  type LlmPort,
  type NetworkMonitorPort,
  type OnlineService,
} from './index';
import { createServiceTestHarness, type ServiceTestHarness } from './testSupport';

const harnesses: ServiceTestHarness[] = [];

afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.close();
  }
});

/** 装配在线服务（全部假端口，禁止真实联网）。 */
function makeOnline(options: {
  http?: HttpPort;
  llm?: LlmPort;
  network?: NetworkMonitorPort;
  associationProviderUrl?: string;
} = {}): { harness: ServiceTestHarness; service: OnlineService; calls: string[] } {
  const harness = createServiceTestHarness({
    http: options.http,
    llm: options.llm,
    network: options.network,
  });
  harnesses.push(harness);
  const service = createOnlineService({
    context: harness.context,
    ...(options.associationProviderUrl === undefined
      ? {}
      : { associationProviderUrl: options.associationProviderUrl }),
  });
  return { harness, service, calls: [] };
}

/** dictionaryapi.dev 的一份合法响应（含 license 等未知字段，验证非 strict 容忍）。 */
const VALID_DICTIONARY_RESPONSE = [
  {
    word: 'abandon',
    phonetic: '/əˈbændən/',
    phonetics: [
      { text: '/əˈbændən/', audio: 'https://example.com/abandon-uk.mp3', license: { name: 'CC' } },
      { text: '/əˈbændən/', audio: 'https://example.com/abandon-us.mp3' },
    ],
    meanings: [
      {
        partOfSpeech: 'verb',
        definitions: [{ definition: 'to leave someone or something' }],
        synonyms: ['desert'],
      },
    ],
    sourceUrls: ['https://example.com'],
  },
];

describe('onlineService：lookupDictionary', () => {
  it('正常响应正确映射（音标去重、音频分 UK/US、义项平铺）', async () => {
    const { service } = makeOnline({
      http: {
        getJson: async () => ({ status: 200, data: VALID_DICTIONARY_RESPONSE }),
        getText: async () => ({ status: 200, body: '' }),
      },
    });

    const entry = await service.lookupDictionary({ lemma: 'abandon' });

    expect(entry).toMatchObject({
      lemma: 'abandon',
      // 两份音标相同 → 不硬造第二个，us 为 null。
      phoneticUk: '/əˈbændən/',
      phoneticUs: null,
      audioUrlUk: 'https://example.com/abandon-uk.mp3',
      audioUrlUs: 'https://example.com/abandon-us.mp3',
    });
    expect(entry?.senses).toEqual([{ pos: 'verb', definitionZh: 'to leave someone or something' }]);
  });

  it('404 返回 null（不是抛错）', async () => {
    const { service } = makeOnline({
      http: {
        getJson: async () => ({ status: 404, data: null }),
        getText: async () => ({ status: 404, body: '' }),
      },
    });

    expect(await service.lookupDictionary({ lemma: 'notaword' })).toBeNull();
  });

  it('畸形 JSON / 缺字段返回 null（不编造义项）', async () => {
    const { service } = makeOnline({
      http: {
        getJson: async () => ({ status: 200, data: { not: 'an array' } }),
        getText: async () => ({ status: 200, body: '' }),
      },
    });

    expect(await service.lookupDictionary({ lemma: 'abandon' })).toBeNull();
  });

  it('definition 换成别的字段名 → null（锁定字段名，上游改名就降级）', async () => {
    const { service } = makeOnline({
      http: {
        getJson: async () => ({
          status: 200,
          data: [
            {
              word: 'abandon',
              meanings: [{ partOfSpeech: 'verb', definitions: [{ def: 'to leave someone' }] }],
            },
          ],
        }),
        getText: async () => ({ status: 404, body: '' }),
      },
    });

    expect(await service.lookupDictionary({ lemma: 'abandon' })).toBeNull();
  });

  it('meanings 不是数组 → null', async () => {
    const { service } = makeOnline({
      http: {
        getJson: async () => ({
          status: 200,
          data: [{ word: 'abandon', meanings: 'verb' }],
        }),
        getText: async () => ({ status: 404, body: '' }),
      },
    });

    expect(await service.lookupDictionary({ lemma: 'abandon' })).toBeNull();
  });

  it('isOnline()===false 直接返回 null，且不发起请求', async () => {
    let called = 0;
    const { service } = makeOnline({
      network: { isOnline: () => false },
      http: {
        getJson: async () => {
          called += 1;
          return { status: 200, data: VALID_DICTIONARY_RESPONSE };
        },
        getText: async () => ({ status: 404, body: '' }),
      },
    });

    expect(await service.lookupDictionary({ lemma: 'abandon' })).toBeNull();
    expect(called).toBe(0);
  });

  it('网络异常降级为 null（不把异常当成功）', async () => {
    const { service } = makeOnline({
      http: {
        getJson: async () => {
          throw new Error('ECONNRESET');
        },
        getText: async () => ({ status: 404, body: '' }),
      },
    });

    expect(await service.lookupDictionary({ lemma: 'abandon' })).toBeNull();
  });
});

describe('onlineService：translate', () => {
  it('未配 llm → NotConfiguredError', async () => {
    const { service } = makeOnline();

    await expect(service.translate({ text: 'abandon', target: 'zh' })).rejects.toBeInstanceOf(
      NotConfiguredError,
    );
  });

  it('已配 llm 正常返回；llm 抛错 → ProviderError', async () => {
    const ok = makeOnline({
      llm: {
          translate: async () => '放弃',
          defineWord: async () => [],
          generateDistractorWords: async () => [],
      },
    });
    await expect(ok.service.translate({ text: 'abandon', target: 'zh' })).resolves.toBe('放弃');

    const failing = makeOnline({
      llm: {
          translate: async () => {
              throw new Error('upstream down');
          },
          defineWord: async () => [],
          generateDistractorWords: async () => [],
      },
    });
    await expect(failing.service.translate({ text: 'abandon', target: 'zh' })).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});

describe('onlineService：lookupAssociations', () => {
  it('未配 provider → []', async () => {
    const { service } = makeOnline();

    expect(await service.lookupAssociations({ lemma: 'abandon', kind: 'MEANING' })).toEqual([]);
  });

  it('配 provider 且响应合法 → 映射出 kind + originUrl；畸形 → []', async () => {
    const ok = makeOnline({
      associationProviderUrl: 'https://assoc.example.com',
      http: {
        getJson: async () => ({
          status: 200,
          data: [
            { text: '阿爸，别抛弃我', originUrl: 'https://example.com/1' },
            { text: '谐音：阿班顿' },
          ],
        }),
        getText: async () => ({ status: 404, body: '' }),
      },
    });
    expect(await ok.service.lookupAssociations({ lemma: 'abandon', kind: 'HOMOPHONE' })).toEqual([
      { kind: 'HOMOPHONE', text: '阿爸，别抛弃我', originUrl: 'https://example.com/1' },
      { kind: 'HOMOPHONE', text: '谐音：阿班顿', originUrl: null },
    ]);

    const malformed = makeOnline({
      associationProviderUrl: 'https://assoc.example.com',
      http: {
        getJson: async () => ({ status: 200, data: { nope: true } }),
        getText: async () => ({ status: 404, body: '' }),
      },
    });
    expect(await malformed.service.lookupAssociations({ lemma: 'abandon', kind: 'MEANING' })).toEqual([]);
  });
});
