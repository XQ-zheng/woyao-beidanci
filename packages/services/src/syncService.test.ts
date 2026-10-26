import { afterEach, describe, expect, it } from 'vitest';

import type { LearningState } from '@woyao/core';
import type { EntityChange, LearningEventRecord } from '@woyao/data';

import {
  createSyncService,
  type CloudPort,
  type PullPage,
  type SyncGateway,
  type SyncService,
} from './index';
import { createServiceTestHarness, type ServiceTestHarness } from './testSupport';

const harnesses: ServiceTestHarness[] = [];

afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.close();
  }
});

/** 装配同步服务（假网关 + 真实数据层）。 */
function makeSync(gateway: SyncGateway): { harness: ServiceTestHarness; service: SyncService } {
  const cloud: CloudPort = { configured: true, auth: null, sync: gateway };
  const harness = createServiceTestHarness({ cloud });
  harnesses.push(harness);
  const service = createSyncService({ context: harness.context, accountId: 'acct-1' });
  return { harness, service };
}

/** 造词库 + 词条（`learning_state` 的 deck/word 外键需要）。 */
function seedDeckAndWord(harness: ServiceTestHarness): void {
  harness.sync.words.upsertDeck({
    id: 'deck-1',
    ownerScope: 'LOCAL',
    name: 'deck',
    kind: 'CUSTOM',
    deviceId: harness.deviceId,
    now: new Date(harness.nowIso),
  });
  harness.sync.words.createWord({
    id: 'w-1',
    ownerScope: 'LOCAL',
    lemma: 'abandon',
    senses: [],
    deviceId: harness.deviceId,
    now: new Date(harness.nowIso),
  });
}

/** 造一条远端 LEARNING_EVENT 的 payload（事件 + 落地后的状态快照，自包含）。 */
function makeRemoteEvent(eventId: string): { event: LearningEventRecord; state: LearningState } {
  const userWordId = 'deck-1:w-1';
  return {
    event: {
      eventId,
      userWordId,
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
      localDate: '2025-03-01',
      timeZone: 'Asia/Shanghai',
      durationMs: null,
      deviceId: 'remote-dev',
      syncedAt: null,
    },
    state: {
      userWordId,
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
    },
  };
}

/** 数一张表的行数。 */
function countRows(harness: ServiceTestHarness, table: string): number {
  const row = harness.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

/** 造一个“返回指定变更”的假网关。 */
function fakeSync(input: {
  push?: (change: EntityChange) => Promise<'OK' | 'DUPLICATE'>;
  pull?: (cursor: string | null) => Promise<PullPage>;
}): SyncGateway {
  return {
    push: input.push ?? (async () => 'OK'),
    pull: input.pull ?? (async () => ({ changes: [], nextCursor: null, hasMore: false })),
  };
}

describe('syncService：NOT_CONFIGURED', () => {
  it('cloud=createNoopCloud() → status=NOT_CONFIGURED，不抛错', async () => {
    const harness = createServiceTestHarness(); // 缺省 cloud 未配置
    harnesses.push(harness);
    const service = createSyncService({ context: harness.context });

    const report = await service.synchronize();

    expect(report.status).toBe('NOT_CONFIGURED');
    expect(report.pushed).toBe(0);
    expect(report.pulled).toBe(0);
    expect(report.errorMessages).toEqual([]);
  });
});

describe('syncService：push', () => {
  it('3 行 outbox 全部 OK → pushed=3、outbox 空', async () => {
    const { harness, service } = makeSync(fakeSync({}));
    for (const entityId of ['e-1', 'e-2', 'e-3']) {
      harness.sync.sync.enqueueOutbox({
        entityType: 'WORD',
        entityId,
        operation: 'UPSERT',
        payload: { id: entityId },
      });
    }

    const report = await service.synchronize();

    expect(report.pushed).toBe(3);
    expect(report.status).toBe('OK');
    expect(countRows(harness, 'sync_outbox')).toBe(0);
  });

  it('网关返回 DUPLICATE → duplicates=1 且该行被删（不反复重试）', async () => {
    const { harness, service } = makeSync(
      fakeSync({
        push: async (change) => (change.entityId === 'dup' ? 'DUPLICATE' : 'OK'),
      }),
    );
    harness.sync.sync.enqueueOutbox({ entityType: 'WORD', entityId: 'ok', operation: 'UPSERT', payload: {} });
    harness.sync.sync.enqueueOutbox({ entityType: 'WORD', entityId: 'dup', operation: 'UPSERT', payload: {} });

    const report = await service.synchronize();

    expect(report.pushed).toBe(1);
    expect(report.duplicates).toBe(1);
    expect(countRows(harness, 'sync_outbox')).toBe(0);
  });

  it('网关抛错 → errors=1 且该行保留（下次再试）', async () => {
    const { harness, service } = makeSync(
      fakeSync({
        push: async (change) => {
          if (change.entityId === 'boom') {
            throw new Error('network down');
          }
          return 'OK';
        },
      }),
    );
    harness.sync.sync.enqueueOutbox({ entityType: 'WORD', entityId: 'ok', operation: 'UPSERT', payload: {} });
    harness.sync.sync.enqueueOutbox({ entityType: 'WORD', entityId: 'boom', operation: 'UPSERT', payload: {} });

    const report = await service.synchronize();

    expect(report.pushed).toBe(1);
    expect(report.errors).toBe(1);
    expect(report.status).toBe('PARTIAL');
    expect(report.errorMessages.join('')).toContain('boom');
    // boom 那行还在 outbox 里。
    const remaining = harness.sync.sync.listOutbox();
    expect(remaining.map((change) => change.entityId)).toEqual(['boom']);
  });
});

describe('syncService：pull（核心）', () => {
  it('同一个 LEARNING_EVENT 连续两页返回 → 只落地一次：events=1、wrongCount=1、duplicates=1', async () => {
    const remote = makeRemoteEvent('evt-x');
    const { harness, service } = makeSync(
      fakeSync({
        pull: async (cursor) => {
          if (cursor === null) {
            return {
              changes: [{ entityType: 'LEARNING_EVENT', entityId: 'evt-x', operation: 'UPSERT', payload: remote, revision: 1, deviceId: 'remote-dev' }],
              nextCursor: 'c1',
              hasMore: true,
            };
          }
          return {
            changes: [{ entityType: 'LEARNING_EVENT', entityId: 'evt-x', operation: 'UPSERT', payload: remote, revision: 1, deviceId: 'remote-dev' }],
            nextCursor: null,
            hasMore: false,
          };
        },
      }),
    );
    seedDeckAndWord(harness);

    const report = await service.synchronize();

    // 幂等核心：事件只插一行、状态不双计数、报告如实记 duplicates。
    expect(countRows(harness, 'learning_events')).toBe(1);
    expect(harness.sync.learning.getState('deck-1:w-1')?.wrongCount).toBe(1);
    expect(report.pulled).toBe(2);
    expect(report.applied).toBe(1);
    expect(report.duplicates).toBe(1);
  });

  it('本地已存在该事件 → applied:false、计数不动', async () => {
    const remote = makeRemoteEvent('evt-local');
    const { harness, service } = makeSync(
      fakeSync({
        pull: async () => ({
          changes: [{ entityType: 'LEARNING_EVENT', entityId: 'evt-local', operation: 'UPSERT', payload: remote, revision: 1, deviceId: 'remote-dev' }],
          nextCursor: null,
          hasMore: false,
        }),
      }),
    );
    seedDeckAndWord(harness);
    // 先本地落地一次（模拟“两端都产生了同一条事件”）。
    harness.sync.learning.appendEventAndUpdateState(remote.event, remote.state);

    const report = await service.synchronize();

    expect(countRows(harness, 'learning_events')).toBe(1);
    expect(report.applied).toBe(0);
    expect(report.duplicates).toBe(1);
  });

  it('LEARNING_STATE 走 updateState 落地', async () => {
    const state: LearningState = {
      userWordId: 'deck-1:w-1',
      deckId: 'deck-1',
      wordId: 'w-1',
      stage: 2,
      dueAt: '2025-03-05T09:00:00.000Z',
      lastReviewedAt: '2025-03-01T03:00:00.000Z',
      correctCount: 3,
      wrongCount: 0,
      streakCorrect: 3,
      weight: 0.8,
      suppressedAt: null,
    };
    const { harness, service } = makeSync(
      fakeSync({
        pull: async () => ({
          changes: [{ entityType: 'LEARNING_STATE', entityId: 'deck-1:w-1', operation: 'UPSERT', payload: state, revision: 4, deviceId: 'remote-dev' }],
          nextCursor: null,
          hasMore: false,
        }),
      }),
    );
    seedDeckAndWord(harness);

    const report = await service.synchronize();

    expect(report.applied).toBe(1);
    expect(harness.sync.learning.getState('deck-1:w-1')).toEqual(state);
  });

  it('cursor 落在最后一页 nextCursor，且写入 getSyncState', async () => {
    const { harness, service } = makeSync(
      fakeSync({
        pull: async (cursor) => {
          if (cursor === null) {
            return { changes: [], nextCursor: 'c1', hasMore: true };
          }
          return { changes: [], nextCursor: 'c2', hasMore: false };
        },
      }),
    );

    await service.synchronize();

    const state = harness.sync.sync.getSyncState('acct-1');
    expect(state?.cursor).toBe('c2');
    expect(state?.schemaVersion).toBe(1);
  });

  it('未支持实体类型 → recordConflict + PARTIAL + errorMessages，不静默丢弃', async () => {
    const { harness, service } = makeSync(
      fakeSync({
        pull: async () => ({
          changes: [{ entityType: 'WORD', entityId: 'w-x', operation: 'UPSERT', payload: { id: 'w-x' }, revision: 1, deviceId: 'remote-dev' }],
          nextCursor: null,
          hasMore: false,
        }),
      }),
    );

    const report = await service.synchronize();

    expect(report.conflicts).toBe(1);
    expect(report.status).toBe('PARTIAL');
    expect(report.errorMessages.join('')).toContain('未支持的实体类型：WORD');
    const conflicts = harness.sync.sync.listOpenConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ entityType: 'WORD', entityId: 'w-x' });
  });
});

describe('syncService：resolveConflict', () => {
  it('LOCAL_WINS / REMOTE_WINS 都只标记 resolved（远端覆盖延后到 Task 10）', async () => {
    const { harness, service } = makeSync(fakeSync({}));
    const id = harness.sync.sync.recordConflict({
      entityType: 'WORD',
      entityId: 'w-x',
      local: { a: 1 },
      remote: { b: 2 },
    });

    await service.resolveConflict({ id, resolution: 'LOCAL_WINS' });

    expect(harness.sync.sync.listOpenConflicts()).toHaveLength(0);
  });

  it('冲突不存在 → 抛错（数据层 resolveConflict 不静默成功）', async () => {
    const { service } = makeSync(fakeSync({}));

    await expect(service.resolveConflict({ id: 'ghost', resolution: 'LOCAL_WINS' })).rejects.toThrow();
  });
});
