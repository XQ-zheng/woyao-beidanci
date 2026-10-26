import { afterEach, describe, expect, it } from 'vitest';

import {
  LOCAL_USER_SOURCE_ID,
  USER_SOURCE_NAME,
  ServiceConflictError,
  ServiceNotFoundError,
  ServiceValidationError,
  createLibraryService,
  type DeckWordView,
  type LibraryService,
} from './index';
import { createServiceTestHarness, type ServiceTestHarness } from './testSupport';

const harnesses: ServiceTestHarness[] = [];

afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.close();
  }
});

/** 建一个跑在真实内存库上的词库服务。 */
function makeService(): {
  harness: ServiceTestHarness;
  service: LibraryService;
} {
  const harness = createServiceTestHarness();
  harnesses.push(harness);
  // 刻意**不**播种 `sources`：自建词的本地来源由服务层自己在写词前创建（5B 修正）。
  const service = createLibraryService({ context: harness.context });
  return { harness, service };
}

/** 把现有词条塞进词库（走数据层，模拟“导入/收藏”）。 */
function addWordsToDeck(harness: ServiceTestHarness, deckId: string, wordIds: readonly string[]): void {
  for (const wordId of wordIds) {
    harness.sync.words.addDeckWord(deckId, wordId, harness.deviceId, new Date(harness.nowIso));
  }
}

/** 从视图里挑出某个词的词频字段，便于断言。 */
function frequencyOf(words: readonly DeckWordView[], wordId: string): DeckWordView['frequency'] {
  const found = words.find((word) => word.wordId === wordId);
  if (found === undefined) {
    throw new Error(`词库里没有 ${wordId}`);
  }
  return found.frequency;
}

describe('libraryService：词库的增改删', () => {
  it('建库返回摘要（词数 0），listDecks 里能查到', async () => {
    const { service } = makeService();

    const created = await service.createDeck({ name: '四级核心' });
    const decks = await service.listDecks();

    expect(created.name).toBe('四级核心');
    expect(created.kind).toBe('CUSTOM');
    expect(created.wordCount).toBe(0);
    expect(decks.map((deck) => deck.deckId)).toEqual([created.deckId]);
  });

  it('空名字被拒（校验落在服务层，而不是等 SQLite 的 CHECK 报错）', async () => {
    const { service } = makeService();

    await expect(service.createDeck({ name: '   ' })).rejects.toBeInstanceOf(ServiceValidationError);
  });

  it('改名后摘要跟着变；词库不存在时抛 NOT_FOUND', async () => {
    const { service } = makeService();
    const created = await service.createDeck({ name: '旧名字' });

    const renamed = await service.renameDeck({ deckId: created.deckId, name: '新名字' });

    expect(renamed.deckId).toBe(created.deckId);
    expect(renamed.name).toBe('新名字');

    await expect(service.renameDeck({ deckId: 'missing', name: '随便' })).rejects.toBeInstanceOf(
      ServiceNotFoundError,
    );
  });

  it('软删后 listDecks 不含它，但库里的词仍可查（软删不级联硬删）', async () => {
    const { harness, service } = makeService();
    harness.seedWord({ id: 'w-1', lemma: 'abandon' });
    harness.seedWord({ id: 'w-2', lemma: 'ability' });
    const created = await service.createDeck({ name: '待删库' });
    addWordsToDeck(harness, created.deckId, ['w-1', 'w-2']);

    await service.deleteDeck(created.deckId);

    expect(await service.listDecks()).toEqual([]);
    const words = await service.listDeckWords({ deckId: created.deckId });
    expect(words.map((word) => word.wordId)).toEqual(['w-1', 'w-2']);
    // 词库行还在（只是 deleted_at 有值），不是物理删除。
    const decks = harness.db.prepare('SELECT COUNT(*) AS total FROM decks').get() as { total: number };
    expect(decks.total).toBe(1);
  });

  it('删除不存在的词库抛 NOT_FOUND', async () => {
    const { service } = makeService();

    await expect(service.deleteDeck('missing')).rejects.toBeInstanceOf(ServiceNotFoundError);
  });
});

describe('libraryService：生词本', () => {
  it('收藏是幂等的：连续两次不报错、词数不变', async () => {
    const { harness, service } = makeService();
    harness.seedWord({ id: 'w-1', lemma: 'abandon' });

    await service.addWordToNotebook('w-1');
    await service.addWordToNotebook('w-1');

    const decks = await service.listDecks();
    const notebook = decks.find((deck) => deck.kind === 'NOTEBOOK');
    expect(notebook).toBeDefined();
    expect(notebook?.wordCount).toBe(1);
    expect(await service.isInNotebook('w-1')).toBe(true);
  });

  it('取消收藏是幂等的：不在生词本时调用不报错', async () => {
    const { harness, service } = makeService();
    harness.seedWord({ id: 'w-1', lemma: 'abandon' });

    await expect(service.removeWordFromNotebook('w-1')).resolves.toBeUndefined();
    expect(await service.isInNotebook('w-1')).toBe(false);

    await service.addWordToNotebook('w-1');
    await service.removeWordFromNotebook('w-1');
    await service.removeWordFromNotebook('w-1');
    expect(await service.isInNotebook('w-1')).toBe(false);
  });

  it('收藏不存在的词条抛 NOT_FOUND（而不是让外键报 SQL 错误）', async () => {
    const { service } = makeService();

    await expect(service.addWordToNotebook('ghost')).rejects.toBeInstanceOf(ServiceNotFoundError);
  });
});

describe('libraryService：自建词', () => {
  it('多义项按 senseNo 升序返回，created 为 true', async () => {
    const { service } = makeService();

    const created = await service.createWord({
      lemma: 'abandon',
      senses: [
        { pos: 'n.', simpleZh: '放任' },
        { pos: 'v.', simpleZh: '放弃', detailedZh: '放弃某物/某人' },
      ],
    });

    expect(created.created).toBe(true);
    expect(created.lemma).toBe('abandon');
    expect(created.senses.map((sense) => sense.senseNo)).toEqual([1, 2]);
    expect(created.senses.map((sense) => sense.simpleZh)).toEqual(['放任', '放弃']);
    expect(created.senses[1]?.detailedZh).toBe('放弃某物/某人');
  });

  it('重复词返回既有记录（created:false），并更新义项而不是插一条新词', async () => {
    const { service } = makeService();
    const first = await service.createWord({
      lemma: 'abandon',
      senses: [{ pos: 'v.', simpleZh: '放弃' }],
    });

    const second = await service.createWord({
      lemma: 'ABANDON ', // 数据层负责 trim + 小写，服务层不重复实现标准化
      senses: [{ pos: 'v.', simpleZh: '放弃；抛弃' }],
    });

    expect(second.created).toBe(false);
    expect(second.wordId).toBe(first.wordId);
    expect(second.senses).toHaveLength(1);
    expect(second.senses[0]?.simpleZh).toBe('放弃；抛弃');
  });

  it('没有义项时被拒（需求要求自建词至少一个义项）', async () => {
    const { service } = makeService();

    await expect(service.createWord({ lemma: 'abandon', senses: [] })).rejects.toBeInstanceOf(
      ServiceValidationError,
    );
  });

  it('义项的简明释义为空时被拒', async () => {
    const { service } = makeService();

    await expect(
      service.createWord({ lemma: 'abandon', senses: [{ pos: 'v.', simpleZh: '   ' }] }),
    ).rejects.toBeInstanceOf(ServiceValidationError);
  });

  it('首次自建词就可用：服务层自己建本地来源（type USER、不许再分发），无需任何预热', async () => {
    const { harness, service } = makeService();

    // 库里一开始一行来源都没有——这正是 5A 里“自建词等于不可用”的现场。
    const before = harness.db.prepare('SELECT COUNT(*) AS total FROM sources').get() as {
      total: number;
    };
    expect(before.total).toBe(0);

    const created = await service.createWord({
      lemma: 'abandon',
      senses: [{ pos: 'v.', simpleZh: '放弃' }],
    });

    const source = harness.db
      .prepare(
        `SELECT owner_scope, type, name, redistribution_allowed
           FROM sources WHERE id = ?`,
      )
      .get(LOCAL_USER_SOURCE_ID) as
      | { owner_scope: string; type: string; name: string; redistribution_allowed: number }
      | undefined;
    expect(source).toEqual({
      owner_scope: 'LOCAL',
      type: 'USER',
      name: USER_SOURCE_NAME,
      redistribution_allowed: 0,
    });

    // 义项真的挂在这个来源上（不是“外键没报错”就算过）。
    const sense = harness.db
      .prepare('SELECT source_id FROM word_senses WHERE word_id = ? AND sense_no = 1')
      .get(created.wordId) as { source_id: string } | undefined;
    expect(sense?.source_id).toBe(LOCAL_USER_SOURCE_ID);
  });

  it('本地来源只建一次：连续自建两个词不会多出一行，也不推 revision', async () => {
    const { harness, service } = makeService();

    await service.createWord({ lemma: 'abandon', senses: [{ pos: 'v.', simpleZh: '放弃' }] });
    const first = harness.db
      .prepare('SELECT revision, updated_at FROM sources WHERE id = ?')
      .get(LOCAL_USER_SOURCE_ID) as { revision: number; updated_at: string };
    await service.createWord({ lemma: 'ability', senses: [{ pos: 'n.', simpleZh: '能力' }] });

    const rows = harness.db.prepare('SELECT COUNT(*) AS total FROM sources').get() as {
      total: number;
    };
    const second = harness.db
      .prepare('SELECT revision, updated_at FROM sources WHERE id = ?')
      .get(LOCAL_USER_SOURCE_ID) as { revision: number; updated_at: string };

    expect(rows.total).toBe(1);
    // 数据层的 upsertSource 对“内容一致”的行是空操作：revision 与 updated_at 都不动，
    // 否则同步侧会持续看到“来源变了”，而其实什么都没变。
    expect(second).toEqual(first);
  });

  it('义项序号重复时报校验错误，而不是静默丢掉一个义项', async () => {
    const { harness, service } = makeService();

    await expect(
      service.createWord({
        lemma: 'abandon',
        senses: [
          { senseNo: 1, pos: 'v.', simpleZh: '放弃' },
          { senseNo: 1, pos: 'n.', simpleZh: '放任' },
        ],
      }),
    ).rejects.toBeInstanceOf(ServiceValidationError);

    // 关键：**一行都没写**。数据层按 (wordId, senseNo, sourceId) upsert，
    // 若放过去，用户会发现自己填的第二个义项凭空消失且没有任何提示。
    const words = harness.db.prepare('SELECT COUNT(*) AS total FROM words').get() as {
      total: number;
    };
    expect(words.total).toBe(0);
    const senses = harness.db.prepare('SELECT COUNT(*) AS total FROM word_senses').get() as {
      total: number;
    };
    expect(senses.total).toBe(0);
  });

  it('省略 senseNo 时按数组序补齐 1..n（不因补齐后的序号“重复”误报）', async () => {
    const { service } = makeService();

    const created = await service.createWord({
      lemma: 'abandon',
      senses: [
        { pos: 'n.', simpleZh: '放任' },
        { senseNo: 3, pos: 'v.', simpleZh: '放弃' },
      ],
    });

    // 第二个义项用显式 3，第一个按序补 1 —— 互不冲突。
    expect(created.senses.map((sense) => sense.senseNo)).toEqual([1, 3]);
  });

  it('显式指定不存在的来源时报 CONFLICT（这条只服务于导入/脚本，不是默认路径的兜底）', async () => {
    const { harness, service } = makeService();

    try {
      await service.createWord({
        lemma: 'abandon',
        sourceId: 'src-does-not-exist',
        senses: [{ pos: 'v.', simpleZh: '放弃' }],
      });
      throw new Error('期望抛出 ServiceConflictError，但调用成功了');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ServiceConflictError);
      expect((error as ServiceConflictError).code).toBe('CONFLICT');
      expect((error as ServiceConflictError).subject).toBe('source');
    }

    // 显式来源不存在时**不**顺手建它（那样会把拼错的 id 永久写进库），也不建本地来源。
    const rows = harness.db.prepare('SELECT COUNT(*) AS total FROM sources').get() as {
      total: number;
    };
    expect(rows.total).toBe(0);
  });
});

describe('libraryService：词频分级', () => {
  it('没有语料时返回 UNKNOWN 且各字段为 null（绝不把未知当低频）', async () => {
    const { harness, service } = makeService();
    harness.seedWord({ id: 'w-1', lemma: 'abandon' });
    const created = await service.createDeck({ name: '词库' });
    addWordsToDeck(harness, created.deckId, ['w-1']);

    const words = await service.listDeckWords({ deckId: created.deckId });
    expect(words[0]?.frequency).toEqual({
      importance: 'UNKNOWN',
      frequency: null,
      rank: null,
      totalTokens: null,
      corpusVersion: null,
      sourceId: null,
    });

    // 即使指定了语料版本，只要该版本里没有这个词，也仍是 UNKNOWN。
    const withCorpus = await service.listDeckWords({
      deckId: created.deckId,
      exam: 'CET4',
      corpusVersion: 'ngsl-1.2',
    });
    expect(withCorpus[0]?.frequency.importance).toBe('UNKNOWN');
    expect(withCorpus[0]?.frequency.frequency).toBeNull();
  });

  it('导入语料后按 core 的百分位口径分级（10 词语料覆盖 HIGH/MEDIUM/BASIC/UNKNOWN 四端）', async () => {
    const { harness, service } = makeService();
    harness.seedSource('src-freq');

    // 10 个词，频次严格递减 → rank 1..10、equalCount 全为 1。
    const wordIds = Array.from({ length: 10 }, (_, index) => `w-${String(index + 1)}`);
    for (const [index, wordId] of wordIds.entries()) {
      harness.seedWord({ id: wordId, lemma: `word-${String(index + 1)}` });
    }
    // 第 11 个词不在语料里，用于断言 UNKNOWN。
    harness.seedWord({ id: 'w-outside', lemma: 'outside' });

    harness.sync.words.writeFrequencyCorpus({
      exam: 'CET4',
      corpusVersion: 'ngsl-1.2',
      sourceId: 'src-freq',
      totalTokens: 1000,
      knownWordCount: 10,
      entries: wordIds.map((wordId, index) => ({
        wordId,
        frequency: 1000 - index * 10,
        rank: index + 1,
        equalCount: 1,
      })),
    });

    const created = await service.createDeck({ name: '词库' });
    addWordsToDeck(harness, created.deckId, [...wordIds, 'w-outside']);

    const words = await service.listDeckWords({
      deckId: created.deckId,
      exam: 'CET4',
      corpusVersion: 'ngsl-1.2',
    });

    // 百分位 = (n - rank - (equal-1) + 0.5*equal) / n，n = 10：
    // rank 1 → 0.95（>= 0.9 HIGH）；rank 3 → 0.75（>= 0.6 MEDIUM）；rank 6 → 0.45（BASIC）。
    expect(frequencyOf(words, 'w-1')).toMatchObject({
      importance: 'HIGH',
      frequency: 1000,
      rank: 1,
      // 语料级字段，由 `getFrequencyCorpusMeta` 提供（5A 时这里恒为 null）。
      totalTokens: 1000,
      corpusVersion: 'ngsl-1.2',
      sourceId: 'src-freq',
    });
    expect(frequencyOf(words, 'w-3').importance).toBe('MEDIUM');
    expect(frequencyOf(words, 'w-6').importance).toBe('BASIC');
    expect(frequencyOf(words, 'w-outside')).toEqual({
      importance: 'UNKNOWN',
      frequency: null,
      rank: null,
      totalTokens: null,
      corpusVersion: null,
      sourceId: null,
    });
  });

  it('getFrequency 对同一个词给出与列表一致的分级；入参非法时报校验错误', async () => {
    const { harness, service } = makeService();
    harness.seedSource('src-freq');
    // 用 10 词语料：`knownWordCount = 1` 时百分位恒为 0.5（永远是 BASIC），
    // 只有多词语料才能验证“分母取的是语料词数，而不是词库词数”。
    const wordIds = Array.from({ length: 10 }, (_, index) => `w-${String(index + 1)}`);
    for (const [index, wordId] of wordIds.entries()) {
      harness.seedWord({ id: wordId, lemma: `word-${String(index + 1)}` });
    }
    harness.sync.words.writeFrequencyCorpus({
      exam: 'CET4',
      corpusVersion: 'ngsl-1.2',
      sourceId: 'src-freq',
      totalTokens: null,
      knownWordCount: 10,
      entries: wordIds.map((wordId, index) => ({
        wordId,
        frequency: 1000 - index * 10,
        rank: index + 1,
        equalCount: 1,
      })),
    });

    const frequency = await service.getFrequency({
      wordId: 'w-1',
      exam: 'CET4',
      corpusVersion: 'ngsl-1.2',
    });
    // 百分位 = (10 - 1 - 0 + 0.5 * 1) / 10 = 0.95 → HIGH。
    expect(frequency.importance).toBe('HIGH');
    expect(frequency.frequency).toBe(1000);
    expect(frequency.rank).toBe(1);
    // 这份语料导入时没给 `totalTokens`，所以是 null——不拿别的数字顶上。
    expect(frequency.totalTokens).toBeNull();

    // 语料之外的词是 UNKNOWN，不是 BASIC。
    expect(
      (
        await service.getFrequency({ wordId: 'w-outside', exam: 'CET4', corpusVersion: 'ngsl-1.2' })
      ).importance,
    ).toBe('UNKNOWN');

    await expect(
      service.getFrequency({ wordId: '', exam: 'CET4', corpusVersion: 'ngsl-1.2' }),
    ).rejects.toBeInstanceOf(ServiceValidationError);
  });
});
