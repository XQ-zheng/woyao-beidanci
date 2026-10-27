/**
 * 同步编排服务：push（上传本地发件箱）+ pull（拉远端变更并幂等落地）。
 *
 * **范围边界（本轮最要紧的一条）**：WorkBuddy Cloud 未激活，本服务只做“编排 + 事件幂等落地 +
 * 冲突登记 + 诚实报未配置”，全部针对 `CloudPort` 实现、用假网关测试。
 *
 * 本轮 sync 只保证一件事（需求的硬要求）：学习事件跨端同步时**重复事件不得双计数**——
 * 靠数据层 `appendEventAndUpdateState` 的 eventId 幂等（`applied:false` 不加计数）。
 * **多实体 LWW / tombstone / 状态重放属 Task 10/11**，本轮不做：遇到未支持的实体类型
 * 就 `recordConflict` + `status='PARTIAL'` + errorMessages，**不假装 applied、不静默丢弃**。
 */

import { toIsoInstant, type LearningState } from '@woyao/core';
import type { LearningEventRecord } from '@woyao/data';

import { parseOrThrow, resolveConflictInputSchema } from './dto';
import { ServiceValidationError } from './errors';
import type { PullPage, ServiceContext } from './ports';

/** 一次同步的汇总报告。 */
export interface SyncReport {
  readonly startedAt: string;
  readonly endedAt: string;
  readonly pushed: number;
  readonly duplicates: number;
  readonly pulled: number;
  readonly applied: number;
  readonly conflicts: number;
  readonly errors: number;
  readonly status: 'OK' | 'PARTIAL' | 'NOT_CONFIGURED';
  readonly errorMessages: string[];
}

/** 冲突处置方向。 */
export type ConflictResolution = 'LOCAL_WINS' | 'REMOTE_WINS';

/** 同步服务契约。 */
export interface SyncService {
  /** 执行一次完整同步（push + pull），返回报告；未配置时返回 NOT_CONFIGURED 不抛错。 */
  synchronize(): Promise<SyncReport>;
  /** 处置一条冲突（本轮只标记 resolved；REMOTE_WINS 的远端覆盖延后到 Task 10）。 */
  resolveConflict(input: { id: string; resolution: ConflictResolution }): Promise<void>;
}

/** 构造参数。 */
export interface SyncServiceOptions {
  readonly context: ServiceContext;
  /** 当前账号 id（游标按账号隔离）；未登录/本地用 `local`。 */
  readonly accountId?: string;
}

/** 同步游标的 schema 版本（同步协议变样时提升，防旧游标被误用）。 */
const SYNC_SCHEMA_VERSION = 1;

/** 把任意异常压成一行可读文本。 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * 创建同步服务。
 *
 * @param options 上下文与账号 id。
 * @returns 同步服务实例。
 */
export function createSyncService(options: SyncServiceOptions): SyncService {
  const { context } = options;
  // 不在这里给缺省值：已配置账号时“没传”与“传了 local”都要被守卫拦下，
  // 否则匿名 local 的游标会与某个真实账号的游标混用（I1）。
  const accountId = options.accountId;

  return {
    async synchronize(): Promise<SyncReport> {
      const startedAt = toIsoInstant(context.clock.now());

      // 1) 未配置：诚实返回 NOT_CONFIGURED，不抛错、不伪造“已同步”。
      if (!context.cloud.configured || context.cloud.sync === null) {
        return {
          startedAt,
          endedAt: startedAt,
          pushed: 0,
          duplicates: 0,
          pulled: 0,
          applied: 0,
          conflicts: 0,
          errors: 0,
          status: 'NOT_CONFIGURED',
          errorMessages: [],
        };
      }
      const sync = context.cloud.sync;

      // I1 守卫：已配置账号时，游标必须落到一个真实账号上；匿名 'local' 不得与账号共用。
      if (accountId === undefined || accountId === 'local') {
        throw new ServiceValidationError(
          [
            {
              path: 'accountId',
              message: "登录后必须显式传 accountId，匿名 'local' 不得用于已配置账号",
            },
          ],
          '同步校验未通过',
        );
      }

      let pushed = 0;
      let duplicates = 0;
      let pulled = 0;
      let applied = 0;
      let conflicts = 0;
      let errors = 0;
      const errorMessages: string[] = [];

      // 2) push：逐条上传 outbox。
      const outbox = await context.repos.sync.listOutbox();
      for (const change of outbox) {
        const seq = change.seq;
        if (seq === undefined) {
          // listOutbox 恒有 seq；这条分支只为类型收窄与防将来改版后静默漏删。
          errors += 1;
          errorMessages.push(`push 失败（${change.entityType}/${change.entityId}）：outbox 行缺 seq`);
          continue;
        }
        try {
          const result = await sync.push(change);
          if (result === 'OK') {
            await context.repos.sync.deleteOutbox([seq]);
            pushed += 1;
          } else {
            // DUPLICATE：远端已有同事件，本地 outbox 该删，不能反复重试。
            await context.repos.sync.deleteOutbox([seq]);
            duplicates += 1;
          }
        } catch (error: unknown) {
          // 抛错：保留该行（下次再试），记 errors + errorMessages。
          errors += 1;
          errorMessages.push(
            `push 失败（${change.entityType}/${change.entityId}）：${describeError(error)}`,
          );
        }
      }

      // 3) pull：按游标分页拉取并幂等落地。
      const state = await context.repos.sync.getSyncState(accountId);
      let cursor = state?.cursor ?? null;
      let page: PullPage;
      try {
        do {
          page = await sync.pull(cursor);
          for (const change of page.changes) {
            pulled += 1;
            if (change.entityType === 'LEARNING_EVENT') {
              // 远端事件自带落地后的状态快照（自包含），靠 eventId 幂等避免双计数。
              const payload = change.payload as { event: LearningEventRecord; state: LearningState };
              const result = await context.repos.learning.appendEventAndUpdateState(
                payload.event,
                payload.state,
              );
              // 落地会 enqueue 本地 outbox（LEARNING_EVENT + LEARNING_STATE）——那是“回显”，
              // 必须在**当场**排空，不能等下一轮再推回远端（否则首次同步大量事件 = 2N 次无谓 push）。
              if (result.outboxSeqs.length > 0) {
                await context.repos.sync.deleteOutbox(result.outboxSeqs);
              }
              if (result.applied) {
                applied += 1;
              } else {
                duplicates += 1;
              }
            } else if (change.entityType === 'LEARNING_STATE') {
              // 状态快照直接 upsert；LWW 裁决延后到 Task 10。
              const seq = await context.repos.learning.updateState(
                change.payload as LearningState,
                change.deviceId,
                context.clock.now(),
              );
              // 同上：回显的 LEARNING_STATE outbox 当场排空。
              await context.repos.sync.deleteOutbox([seq]);
              applied += 1;
            } else {
              // 未支持的实体类型：登记冲突，不假装 applied、不静默丢弃。
              await context.repos.sync.recordConflict({
                entityType: change.entityType,
                entityId: change.entityId,
                local: null,
                remote: change.payload,
              });
              conflicts += 1;
              errorMessages.push(`未支持的实体类型：${String(change.entityType)}`);
            }
          }
          await context.repos.sync.setSyncState({
            accountId,
            cursor: page.nextCursor,
            lastPullAt: toIsoInstant(context.clock.now()),
            schemaVersion: SYNC_SCHEMA_VERSION,
          });
          cursor = page.nextCursor;
        } while (page.hasMore);
      } catch (error: unknown) {
        // pull 本身失败（网络/网关）：记错并停止拉取，之前已落地的保留、游标停在最后一页。
        errors += 1;
        errorMessages.push(`pull 失败：${describeError(error)}`);
      }

      const status: SyncReport['status'] = conflicts > 0 || errors > 0 ? 'PARTIAL' : 'OK';
      return {
        startedAt,
        endedAt: toIsoInstant(context.clock.now()),
        pushed,
        duplicates,
        pulled,
        applied,
        conflicts,
        errors,
        status,
        errorMessages,
      };
    },

    async resolveConflict(input: { id: string; resolution: ConflictResolution }): Promise<void> {
      const { id, resolution } = parseOrThrow(resolveConflictInputSchema, input, '处置冲突');
      // LOCAL_WINS：保留本地（只标记 resolved）；REMOTE_WINS：本轮也只标记 resolved + 记录
      // （真正的远端覆盖在 Task 10）。二者都走数据层 resolveConflict。
      await context.repos.sync.resolveConflict(id, resolution, context.clock.now());
    },
  };
}
