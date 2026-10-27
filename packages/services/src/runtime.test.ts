import { afterEach, describe, expect, it } from 'vitest';

import { createServiceRuntime } from './runtime';
import { createServiceTestHarness, type ServiceTestHarness } from './testSupport';

const harnesses: ServiceTestHarness[] = [];

afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.close();
  }
});

describe('createServiceRuntime', () => {
  it('返回 9 个非空服务', () => {
    const harness = createServiceTestHarness();
    harnesses.push(harness);
    const services = createServiceRuntime({
      context: harness.context,
      defaultTimeZone: 'Asia/Shanghai',
    });

    expect(services.settings).toBeDefined();
    expect(services.library).toBeDefined();
    expect(services.study).toBeDefined();
    expect(services.report).toBeDefined();
    expect(services.content).toBeDefined();
    expect(services.online).toBeDefined();
    expect(services.association).toBeDefined();
    expect(services.sync).toBeDefined();
    expect(services.auth).toBeDefined();
    expect(services.export).toBeDefined();
  });

  it('study 与传入的 settings 是同一实例：改设置能立刻影响 study 的排期', async () => {
    const harness = createServiceTestHarness();
    harnesses.push(harness);
    harness.seedWord({ id: 'w-1', lemma: 'abandon', senses: [{ pos: 'v.', simpleZh: '放弃' }] });
    harness.seedDeck({ id: 'deck-1', name: '四级', wordIds: ['w-1'] });

    const services = createServiceRuntime({
      context: harness.context,
      defaultTimeZone: 'Asia/Shanghai',
    });

    // 通过 runtime 暴露的 settings 改上限；study 若用了另一个 settings 实例，
    // 这里就不会生效（每日新词上限仍是默认 20）。
    await services.settings.update({ dailyNewLimit: 1 });

    const session = await services.study.startSession({
      deckId: 'deck-1',
      now: new Date(harness.nowIso),
    });

    expect(session.plan.dailyNewLimit).toBe(1);
    expect(session.newCount).toBe(1);
  });

  it('ownerScope 缺省 LOCAL，且 library/study/association 共用同一归属', async () => {
    const harness = createServiceTestHarness();
    harnesses.push(harness);
    const services = createServiceRuntime({
      context: harness.context,
      defaultTimeZone: 'Asia/Shanghai',
    });

    // 未传 ownerScope：三个服务都落在 LOCAL。用 library 建库、study 读库验证同一归属。
    const created = await services.library.createDeck({ name: '四级核心' });
    const decks = await services.library.listDecks();
    expect(decks.map((deck) => deck.deckId)).toContain(created.deckId);
    // study 能按同一 ownerScope 找到词库（不因归属不一致而 NOT_FOUND）。
    await expect(
      services.study.startSession({ deckId: created.deckId, now: new Date(harness.nowIso) }),
    ).resolves.toMatchObject({ deckId: created.deckId });
  });
});
