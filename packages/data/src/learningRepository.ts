/**
 * 学习状态与作答事件仓储。
 *
 * 两条硬约束（决定了很多实现细节）：
 * 1. **事件是事实，状态是物化**。`learning_events` 只追加、`event_id` 是幂等键；
 *    重复提交同一条事件（双击、重试、同步回放）必须返回 `applied: false`，
 *    且**不能**再动状态、计数与发件箱。
 * 2. **事件与状态必须同事务**。否则崩溃会留下“事件有了但状态没更新”或反之，
 *    而这两者都能被用户看见（复习计划错乱 / 错词本数量不对）。
 */

import type { LearningState, Recognition, TrainingMode } from '@woyao/core';

import type { SqliteDatabase } from './connection';
import { InvalidRepositoryInputError } from './errors';
import type { EntityChange } from './syncRepository';
import { enqueueOutboxWithin } from './syncRepository';
import { runInTransaction } from './transaction';

/** 一条作答事件的写入形状（对应 `learning_events` 一行）。 */
export interface LearningEventRecord {
  /** 事件主键（幂等键），例如 `${sessionId}:${wordId}:${answeredAt}`。 */
  readonly eventId: string;
  /** 学习状态主键（每词每词库一条）。 */
  readonly userWordId: string;
  /** 所属词库。 */
  readonly deckId: string;
  /** 词条 id。 */
  readonly wordId: string;
  /** 所属会话。 */
  readonly sessionId?: string | null;
  /** 训练模式。 */
  readonly mode: TrainingMode;
  /** 题干（展示用快照）。 */
  readonly prompt: string;
  /** 用户作答（展示用快照）。 */
  readonly answer: string;
  /** 是否答对。 */
  readonly isCorrect: boolean;
  /** 自我认识判断。 */
  readonly recognition: Recognition;
  /** 作答前阶段。 */
  readonly stageBefore?: number | null;
  /** 作答后阶段。 */
  readonly stageAfter?: number | null;
  /** 作答时间（UTC ISO 8601 毫秒）。 */
  readonly answeredAt: string;
  /** 作答所在本地日期（`YYYY-MM-DD`，按计划时区计算，由服务层传入）。 */
  readonly localDate: string;
  /** 作答所用 IANA 时区。 */
  readonly timeZone: string;
  /** 作答耗时（毫秒）。 */
  readonly durationMs?: number | null;
  /** 设备 id。 */
  readonly deviceId?: string;
}

/** 追加事件的附加选项。 */
export interface AppendEventOptions {
  /**
   * 需要在**同一事务**里写入发件箱的变更。
   *
   * 学习事件与学习状态都是要同步的实体；把它们放进同一个事务，
   * 才不会出现“事件上传了但状态没上传”的半同步状态。
   */
  readonly outbox?: readonly EntityChange[];
}

/** 追加事件的结果。 */
export interface AppendEventResult {
  /** `false` 表示该 `eventId` 已存在（幂等命中），本次没有改动任何数据。 */
  readonly applied: boolean;
}

/** 错词本条目：学习状态 + 由事件派生的“最近答错时间”。 */
export interface MistakeRecord {
  /** 该词的学习状态。 */
  readonly state: LearningState;
  /**
   * 最近一次答错时间（UTC ISO 8601），由 `learning_events` 聚合而来。
   *
   * 刻意**不加**冗余列：错词本按“最近答错”排序时，用事件聚合永远和事实一致，
   * 而冗余列会在同步回放、事件被纠正时变成脏数据。
   */
  readonly lastWrongAt: string | null;
}

/** 学习仓储契约（Task 5 直接消费）。 */
export interface LearningRepository {
  appendEventAndUpdateState(
    event: LearningEventRecord,
    state: LearningState,
    options?: AppendEventOptions,
  ): AppendEventResult;
  getState(userWordId: string): LearningState | null;
  listDue(deckId: string, now: Date): LearningState[];
  listMistakes(deckId: string, limit?: number): MistakeRecord[];
}

/** `learning_state` 行的 snake_case 形状。 */
interface LearningStateRow {
  user_word_id: string;
  deck_id: string;
  word_id: string;
  stage: number;
  due_at: string;
  last_reviewed_at: string | null;
  correct_count: number;
  wrong_count: number;
  streak_correct: number;
  weight: number;
  suppressed_at: string | null;
}

/** 行 → 领域对象。 */
function toLearningState(row: LearningStateRow): LearningState {
  return {
    userWordId: row.user_word_id,
    deckId: row.deck_id,
    wordId: row.word_id,
    stage: row.stage,
    dueAt: row.due_at,
    lastReviewedAt: row.last_reviewed_at,
    correctCount: row.correct_count,
    wrongCount: row.wrong_count,
    streakCorrect: row.streak_correct,
    weight: row.weight,
    suppressedAt: row.suppressed_at,
  };
}

/**
 * 校验一条作答事件的必填字段。
 *
 * @param event 事件记录。
 * @throws {InvalidRepositoryInputError} 任一字段非法时。
 */
function assertValidEvent(event: LearningEventRecord): void {
  if (event === null || typeof event !== 'object') {
    throw new InvalidRepositoryInputError('event', '作答事件不能为空');
  }
  if (typeof event.eventId !== 'string' || event.eventId.trim() === '') {
    throw new InvalidRepositoryInputError('eventId', '事件 id 必须是非空字符串');
  }
  if (typeof event.userWordId !== 'string' || event.userWordId.trim() === '') {
    throw new InvalidRepositoryInputError('userWordId', '学习状态主键必须是非空字符串');
  }
  if (typeof event.deckId !== 'string' || event.deckId.trim() === '') {
    throw new InvalidRepositoryInputError('deckId', '词库 id 必须是非空字符串');
  }
  if (typeof event.wordId !== 'string' || event.wordId.trim() === '') {
    throw new InvalidRepositoryInputError('wordId', '词条 id 必须是非空字符串');
  }
  if (event.mode !== 'EN_TO_ZH' && event.mode !== 'ZH_TO_EN' && event.mode !== 'MIXED') {
    throw new InvalidRepositoryInputError('mode', `未知训练模式：${String(event.mode)}`);
  }
  if (event.recognition !== 'KNOWN' && event.recognition !== 'UNKNOWN') {
    throw new InvalidRepositoryInputError('recognition', `未知自评：${String(event.recognition)}`);
  }
  if (typeof event.isCorrect !== 'boolean') {
    throw new InvalidRepositoryInputError('isCorrect', 'isCorrect 必须是布尔值');
  }
  if (typeof event.answeredAt !== 'string' || Number.isNaN(Date.parse(event.answeredAt))) {
    throw new InvalidRepositoryInputError('answeredAt', `无法解析作答时间：${String(event.answeredAt)}`);
  }
  if (typeof event.localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(event.localDate)) {
    throw new InvalidRepositoryInputError('localDate', `localDate 必须是 YYYY-MM-DD，收到 ${String(event.localDate)}`);
  }
  if (typeof event.timeZone !== 'string' || event.timeZone.trim() === '') {
    throw new InvalidRepositoryInputError('timeZone', 'timeZone 必须是非空字符串');
  }
}

/**
 * 创建学习仓储。
 *
 * @param db 已迁移的连接。
 * @returns 仓储实例。
 */
export function createLearningRepository(db: SqliteDatabase): LearningRepository {
  const selectEvent = db.prepare('SELECT 1 FROM learning_events WHERE event_id = ?');
  const insertEvent = db.prepare(
    `INSERT INTO learning_events
       (event_id, user_word_id, deck_id, word_id, session_id, mode, prompt, answer, is_correct,
        recognition, stage_before, stage_after, answered_at, local_date, time_zone, duration_ms, device_id, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  const selectState = db.prepare(
    `SELECT user_word_id, deck_id, word_id, stage, due_at, last_reviewed_at, correct_count,
            wrong_count, streak_correct, weight, suppressed_at
       FROM learning_state
      WHERE user_word_id = ?`,
  );
  const upsertState = db.prepare(
    `INSERT INTO learning_state
       (user_word_id, deck_id, word_id, stage, due_at, last_reviewed_at, correct_count, wrong_count,
        streak_correct, last_result, weight, suppressed_at, state_updated_at, device_id, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0)
     ON CONFLICT (user_word_id) DO UPDATE SET
       deck_id = excluded.deck_id,
       word_id = excluded.word_id,
       stage = excluded.stage,
       due_at = excluded.due_at,
       last_reviewed_at = excluded.last_reviewed_at,
       correct_count = excluded.correct_count,
       wrong_count = excluded.wrong_count,
       streak_correct = excluded.streak_correct,
       last_result = excluded.last_result,
       weight = excluded.weight,
       suppressed_at = excluded.suppressed_at,
       state_updated_at = excluded.state_updated_at,
       revision = learning_state.revision + 1`,
  );
  const selectDue = db.prepare(
    `SELECT user_word_id, deck_id, word_id, stage, due_at, last_reviewed_at, correct_count,
            wrong_count, streak_correct, weight, suppressed_at
       FROM learning_state
      WHERE deck_id = ? AND suppressed_at IS NULL AND due_at <= ?
      ORDER BY due_at ASC, user_word_id ASC`,
  );
  const selectMistakes = db.prepare(
    `SELECT s.user_word_id, s.deck_id, s.word_id, s.stage, s.due_at, s.last_reviewed_at,
            s.correct_count, s.wrong_count, s.streak_correct, s.weight, s.suppressed_at,
            (SELECT MAX(e.answered_at) FROM learning_events e
              WHERE e.user_word_id = s.user_word_id AND e.is_correct = 0) AS last_wrong_at
       FROM learning_state s
      WHERE s.deck_id = ? AND s.wrong_count > 0
      ORDER BY last_wrong_at DESC, s.wrong_count DESC, s.user_word_id ASC
      LIMIT ?`,
  );

  return {
    appendEventAndUpdateState(
      event: LearningEventRecord,
      state: LearningState,
      options: AppendEventOptions = {},
    ): AppendEventResult {
      assertValidEvent(event);
      if (state === null || typeof state !== 'object') {
        throw new InvalidRepositoryInputError('state', '学习状态不能为空');
      }
      if (state.userWordId !== event.userWordId) {
        throw new InvalidRepositoryInputError(
          'userWordId',
          `事件与状态的主键不一致（${event.userWordId} vs ${state.userWordId}）`,
        );
      }
      const outbox: readonly EntityChange[] = Array.isArray(options.outbox) ? options.outbox : [];

      return runInTransaction(
        db,
        () => {
          if (selectEvent.get(event.eventId) !== undefined) {
            // 幂等命中：不改状态、不加计数、不写发件箱。
            return { applied: false };
          }

          insertEvent.run(
            event.eventId,
            event.userWordId,
            event.deckId,
            event.wordId,
            event.sessionId ?? null,
            event.mode,
            event.prompt,
            event.answer,
            event.isCorrect ? 1 : 0,
            event.recognition,
            event.stageBefore ?? null,
            event.stageAfter ?? null,
            event.answeredAt,
            event.localDate,
            event.timeZone,
            event.durationMs ?? null,
            event.deviceId ?? '',
          );

          upsertState.run(
            state.userWordId,
            state.deckId,
            state.wordId,
            state.stage,
            state.dueAt,
            state.lastReviewedAt,
            state.correctCount,
            state.wrongCount,
            state.streakCorrect,
            event.isCorrect ? 'CORRECT' : 'WRONG',
            state.weight,
            state.suppressedAt,
            // 状态最后变更时间取事件时间，而不是本地时钟：回放/同步时才能得到同一结果。
            event.answeredAt,
          );

          for (const change of outbox) {
            enqueueOutboxWithin(db, change);
          }

          return { applied: true };
        },
        { mode: 'IMMEDIATE' },
      );
    },

    getState(userWordId: string): LearningState | null {
      if (typeof userWordId !== 'string' || userWordId.trim() === '') {
        throw new InvalidRepositoryInputError('userWordId', '学习状态主键必须是非空字符串');
      }
      const row = selectState.get(userWordId) as LearningStateRow | undefined;
      return row === undefined ? null : toLearningState(row);
    },

    listDue(deckId: string, now: Date): LearningState[] {
      if (typeof deckId !== 'string' || deckId.trim() === '') {
        throw new InvalidRepositoryInputError('deckId', '词库 id 必须是非空字符串');
      }
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new InvalidRepositoryInputError('now', '当前时刻必须是有效 Date');
      }
      const rows = selectDue.all(deckId, now.toISOString()) as LearningStateRow[];
      return rows.map(toLearningState);
    },

    listMistakes(deckId: string, limit = 100): MistakeRecord[] {
      if (typeof deckId !== 'string' || deckId.trim() === '') {
        throw new InvalidRepositoryInputError('deckId', '词库 id 必须是非空字符串');
      }
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new InvalidRepositoryInputError('limit', `limit 必须是正整数，收到 ${String(limit)}`);
      }
      const rows = selectMistakes.all(deckId, limit) as (LearningStateRow & {
        last_wrong_at: string | null;
      })[];
      return rows.map((row) => ({
        state: toLearningState(row),
        lastWrongAt: row.last_wrong_at,
      }));
    },
  };
}
