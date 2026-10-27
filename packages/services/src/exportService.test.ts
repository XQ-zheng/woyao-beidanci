import { afterEach, describe, expect, it } from 'vitest';

import type { LearningState } from '@woyao/core';
import type { LearningEventRecord } from '@woyao/data';

import {
  ServiceValidationError,
  createExportService,
  type CloudPort,
  type DocumentWriterPort,
  type ExportModel,
  type ExportService,
  type HttpPort,
  type LlmPort,
  type NetworkMonitorPort,
} from './index';
import { createServiceTestHarness, type ServiceTestHarness } from './testSupport';

const harnesses: ServiceTestHarness[] = [];

afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.close();
  }
});

/** 假 writer：捕获收到的 model，并按 model 自算回执。 */
function fakeWriter(): { writer: DocumentWriterPort; models: ExportModel[] } {
  const models: ExportModel[] = [];
  const writer: DocumentWriterPort = {
    write: async (model, format, destination) => {
      models.push(model);
      return {
        kind: model.kind,
        format,
        destination,
        rowCount: model.rows.length,
        generatedAt: model.generatedAt,
      };
    },
  };
  return { writer, models };
}

/** 装配导出服务。 */
function makeExport(options: {
  writer?: DocumentWriterPort;
  cloud?: CloudPort;
  http?: HttpPort;
  llm?: LlmPort;
  network?: NetworkMonitorPort;
  timeZone?: string;
} = {}): { harness: ServiceTestHarness; service: ExportService } {
  const harness = createServiceTestHarness({
    writer: options.writer,
    cloud: options.cloud,
    http: options.http,
    llm: options.llm,
    network: options.network,
  });
  harnesses.push(harness);
  const service = createExportService({
    context: harness.context,
    defaultTimeZone: options.timeZone ?? 'Asia/Shanghai',
  });
  return { harness, service };
}

/** 造一条学习事件 + 状态（供 listDailyStats 用）。 */
function seedEvent(harness: ServiceTestHarness, eventId: string, localDate: string): void {
  const state: LearningState = {
    userWordId: 'deck-1:w-1',
    deckId: 'deck-1',
    wordId: 'w-1',
    stage: 0,
    dueAt: '2025-03-02T09:00:00.000Z',
    lastReviewedAt: '2025-03-01T03:00:00.000Z',
    correctCount: 0,
    wrongCount: 1,
    streakCorrect: 0,
    weight: 1,
    suppressedAt: null,
  };
  const event: LearningEventRecord = {
    eventId,
    userWordId: 'deck-1:w-1',
    sessionId: null,
    mode: 'EN_TO_ZH',
    prompt: 'abandon',
    answer: 'x',
    isCorrect: false,
    recognition: 'UNKNOWN',
    stageBefore: 0,
    stageAfter: 0,
    dueAt: null,
    answeredAt: '2025-03-01T03:00:00.000Z',
    localDate,
    timeZone: 'Asia/Shanghai',
    durationMs: 1000,
    deviceId: harness.deviceId,
    syncedAt: null,
  };
  harness.sync.learning.appendEventAndUpdateState(event, state);
}

describe('exportService：exportDeck', () => {
  it('2 词 × 2 义项：词序与 deck 一致、义项按 senseNo 升序、writer 收到正确 model、回执正确', async () => {
    const { writer, models } = fakeWriter();
    const { harness, service } = makeExport({ writer });
    harness.seedWord({
      id: 'w-1',
      lemma: 'abandon',
      senses: [
        { senseNo: 2, pos: 'n.', simpleZh: '放任' },
        { senseNo: 1, pos: 'v.', simpleZh: '放弃', detailedZh: '放弃某物' },
      ],
    });
    harness.seedWord({
      id: 'w-2',
      lemma: 'ability',
      senses: [{ pos: 'n.', simpleZh: '能力' }],
    });
    harness.seedDeck({ id: 'deck-1', name: '四级核心', wordIds: ['w-1', 'w-2'] });

    const receipt = await service.exportDeck({
      format: 'EXCEL',
      deckId: 'deck-1',
      destination: '/tmp/out.xlsx',
    });

    const model = models[0] as ExportModel;
    expect(model.kind).toBe('DECK');
    expect(model.title).toBe('四级核心');
    expect(model.columns).toEqual(['词条', '义项序号', '词性', '简明释义', '详细释义', '例句']);
    // 词序 = 词库加入顺序；义项按 senseNo 升序（w-1 的 senseNo 2 在前、1 在后 → 输出 1 在前）。
    expect(model.rows).toEqual([
      ['abandon', '1', 'v.', '放弃', '放弃某物', ''],
      ['abandon', '2', 'n.', '放任', '', ''],
      ['ability', '1', 'n.', '能力', '', ''],
    ]);
    expect(receipt).toMatchObject({
      kind: 'DECK',
      format: 'EXCEL',
      destination: '/tmp/out.xlsx',
      rowCount: 3,
    });
  });

  it('词库不存在 → NOT_FOUND', async () => {
    const { service } = makeExport({ writer: fakeWriter().writer });

    await expect(
      service.exportDeck({ format: 'WORD', deckId: 'ghost', destination: '/tmp/x.docx' }),
    ).rejects.toThrow();
  });
});

describe('exportService：exportNotebook', () => {
  it('kind=NOTEBOOK，标题用单词本名', async () => {
    const { writer, models } = fakeWriter();
    const { harness, service } = makeExport({ writer });
    harness.seedWord({ id: 'w-1', lemma: 'abandon', senses: [{ pos: 'v.', simpleZh: '放弃' }] });
    harness.seedDeck({ id: 'nb-1', name: '生词本', kind: 'NOTEBOOK', wordIds: ['w-1'] });

    const receipt = await service.exportNotebook({
      format: 'PDF',
      notebookId: 'nb-1',
      destination: '/tmp/notebook.pdf',
    });

    const model = models[0] as ExportModel;
    expect(model.kind).toBe('NOTEBOOK');
    expect(model.title).toBe('生词本');
    expect(receipt.kind).toBe('NOTEBOOK');
    expect(receipt.format).toBe('PDF');
  });
});

describe('exportService：exportHistory', () => {
  it('只含 range 内的行，区间端点含边界', async () => {
    const { writer, models } = fakeWriter();
    const { harness, service } = makeExport({ writer, timeZone: 'Asia/Shanghai' });
    harness.seedWord({ id: 'w-1', lemma: 'abandon' });
    harness.seedDeck({ id: 'deck-1', name: '四级', wordIds: ['w-1'] });

    const range = { fromIso: '2025-03-01T00:00:00.000Z', toIso: '2025-03-01T12:00:00.000Z' };

    // 造 3 条 session：边界（= toIso，应含）、界内、界外（= toIso + 1ms，应排除）。
    harness.sync.learning.upsertSession({
      sessionId: 's-boundary',
      deckId: 'deck-1',
      startedAt: '2025-03-01T12:00:00.000Z',
      endedAt: null,
      localDate: '2025-03-01',
      timeZone: 'Asia/Shanghai',
      newCount: 1,
      reviewCount: 0,
      activeDurationMs: 0,
      planSnapshotJson: null,
      deviceId: harness.deviceId,
      revision: 0,
    });
    harness.sync.learning.upsertSession({
      sessionId: 's-in',
      deckId: 'deck-1',
      startedAt: '2025-03-01T06:00:00.000Z',
      endedAt: null,
      localDate: '2025-03-01',
      timeZone: 'Asia/Shanghai',
      newCount: 1,
      reviewCount: 0,
      activeDurationMs: 0,
      planSnapshotJson: null,
      deviceId: harness.deviceId,
      revision: 0,
    });
    harness.sync.learning.upsertSession({
      sessionId: 's-out',
      deckId: 'deck-1',
      startedAt: '2025-03-01T12:00:00.001Z',
      endedAt: null,
      localDate: '2025-03-01',
      timeZone: 'Asia/Shanghai',
      newCount: 1,
      reviewCount: 0,
      activeDurationMs: 0,
      planSnapshotJson: null,
      deviceId: harness.deviceId,
      revision: 0,
    });

    // 造两条日统计事件：一条 localDate 在区间（03-01），一条在区间外（03-02）。
    seedEvent(harness, 'evt-in', '2025-03-01');
    seedEvent(harness, 'evt-out', '2025-03-02');

    await service.exportHistory({ format: 'EXCEL', range, destination: '/tmp/history.xlsx' });

    const model = models[0] as ExportModel;
    const sessionRows = model.rows.filter((row) => row[0] === '会话');
    const dailyRows = model.rows.filter((row) => row[0] === '日统计');

    // 会话：边界 + 界内各一条，界外被排除。
    expect(sessionRows).toHaveLength(2);
    expect(sessionRows.some((row) => row[2] === '2025-03-01T12:00:00.000Z')).toBe(true); // 端点含边界
    expect(sessionRows.some((row) => row[2] === '2025-03-01T12:00:00.001Z')).toBe(false);
    // 日统计：只有 03-01 一行，03-02 被排除。
    expect(dailyRows).toHaveLength(1);
    expect(dailyRows[0]?.[1]).toBe('2025-03-01');
  });

  it('fromIso > toIso / 空 destination → ServiceValidationError', async () => {
    const { service } = makeExport({ writer: fakeWriter().writer });

    await expect(
      service.exportHistory({
        format: 'EXCEL',
        range: { fromIso: '2025-03-02T00:00:00.000Z', toIso: '2025-03-01T00:00:00.000Z' },
        destination: '/tmp/x.xlsx',
      }),
    ).rejects.toBeInstanceOf(ServiceValidationError);

    await expect(
      service.exportHistory({
        format: 'EXCEL',
        range: { fromIso: '2025-03-01T00:00:00.000Z', toIso: '2025-03-02T00:00:00.000Z' },
        destination: '   ',
      }),
    ).rejects.toBeInstanceOf(ServiceValidationError);
  });
});

describe('exportService：离线', () => {
  it('整条导出路径只碰 writer，不碰 cloud/http/llm/network', async () => {
    const { writer, models } = fakeWriter();
    const boom = async (): Promise<never> => {
      throw new Error('export 路径不该碰我');
    };
    const { harness, service } = makeExport({
      writer,
      cloud: {
        configured: true,
        auth: { signIn: boom, refresh: boom, signOut: boom },
        sync: { push: boom, pull: boom },
      },
      http: { getJson: boom, getText: boom },
      llm: { translate: boom },
      network: {
        isOnline: (): boolean => {
          throw new Error('export 路径不该查网络');
        },
      },
    });
    harness.seedWord({ id: 'w-1', lemma: 'abandon', senses: [{ pos: 'v.', simpleZh: '放弃' }] });
    harness.seedDeck({ id: 'deck-1', name: '四级', wordIds: ['w-1'] });

    await expect(
      service.exportDeck({ format: 'WORD', deckId: 'deck-1', destination: '/tmp/x.docx' }),
    ).resolves.toMatchObject({ kind: 'DECK' });
    expect(models).toHaveLength(1);
  });
});

describe('exportService：公式注入防护', () => {
  it('义项以 = + - @ 开头 → 单元格被加 单引号 前缀', async () => {
    const { writer, models } = fakeWriter();
    const { harness, service } = makeExport({ writer });
    harness.seedWord({
      id: 'w-1',
      lemma: 'abandon',
      senses: [
        { pos: 'v.', simpleZh: '=SUM(A1:A9)' },
        { pos: 'n.', simpleZh: '+1' },
      ],
    });
    harness.seedWord({
      id: 'w-2',
      lemma: 'ability',
      senses: [{ pos: 'n.', simpleZh: '-2' }],
    });
    harness.seedWord({
      id: 'w-3',
      lemma: 'accept',
      senses: [{ pos: 'v.', simpleZh: '@x' }],
    });
    harness.seedDeck({ id: 'deck-1', name: '四级', wordIds: ['w-1', 'w-2', 'w-3'] });

    await service.exportDeck({ format: 'EXCEL', deckId: 'deck-1', destination: '/tmp/x.xlsx' });

    const model = models[0] as ExportModel;
    const simpleZhColumn = model.columns.indexOf('简明释义');
    const simpleZhs = model.rows.map((row) => row[simpleZhColumn]);
    expect(simpleZhs).toEqual(["'=SUM(A1:A9)", "'+1", "'-2", "'@x"]);
  });
});

describe('exportService：词频来源标注', () => {
  it('有语料 → source 非 null 且带词频列；无语料 → source null', async () => {
    const { writer, models } = fakeWriter();
    const { harness, service } = makeExport({ writer });
    harness.seedSource('src-freq');
    harness.seedWord({ id: 'w-1', lemma: 'abandon', senses: [{ pos: 'v.', simpleZh: '放弃' }] });
    harness.seedDeck({ id: 'deck-1', name: '四级', wordIds: ['w-1'] });
    harness.sync.words.writeFrequencyCorpus({
      exam: 'CET4',
      corpusVersion: 'ngsl-1.2',
      sourceId: 'src-freq',
      totalTokens: 100,
      knownWordCount: 1,
      entries: [{ wordId: 'w-1', frequency: 100, rank: 1, equalCount: 1 }],
    });

    await service.exportDeck({
      format: 'EXCEL',
      deckId: 'deck-1',
      destination: '/tmp/x.xlsx',
      exam: 'CET4',
      corpusVersion: 'ngsl-1.2',
    });
    const withCorpus = models[0] as ExportModel;
    expect(withCorpus.source).not.toBeNull();
    expect(withCorpus.columns).toContain('词频');
    expect(withCorpus.rows[0]?.[withCorpus.columns.indexOf('词频')]).toBe('100');

    await service.exportDeck({ format: 'EXCEL', deckId: 'deck-1', destination: '/tmp/y.xlsx' });
    const withoutCorpus = models[1] as ExportModel;
    expect(withoutCorpus.source).toBeNull();
    expect(withoutCorpus.columns).not.toContain('词频');
  });
});
