/**
 * 学习状态、作答事件、会话与统计仓储。
 *
 * 三条硬约束（决定了很多实现细节）：
 * 1. **事件是事实，状态是物化**。`learning_events` 只追加、`event_id` 是幂等键；
 *    重复提交同一条事件（双击、重试、同步回放）必须返回 `applied: false`，
 *    且**不能**再动状态、计数与发件箱。
 * 2. **事件、状态与发件箱必须同事务**。否则崩溃会留下“事件有了但状态没更新”
 *    或“状态更新了但没排队上传”，而这两者都能被用户看见。
 * 3. **错词本的“最近答错时间”由事件派生、不落冗余列**：冗余列在同步回放、
 *    事件被纠正时会变成脏数据，而聚合永远和事实一致。
 */

import type { LearningState, Recognition, TrainingMode } from '@woyao/core';

import type { SqliteDatabase } from './connection';
import { InvalidRepositoryInputError, RepositoryInvariantError } from './errors';
import { enqueueOutboxWithin } from './syncRepository';
import { runInTransaction } from './transaction';

/**
 * 一条作答事件的写入形状（对应 `learning_events` 一行）。
 *
 * 刻意**不含** `deckId` / `wordId`：这两个值由同一次调用里的 `LearningState` 提供，
 * 事件只需要抓住“哪个 userWord、答了什么”。多一份来源就多一处可能不一致。
 */
export interface LearningEventRecord {
  /** 事件主键（幂等键），例如 `${sessionId}:${wordId}:${answeredAt}`。 */
  readonly eventId: string;
  /** 学习状态主键（每词每词库一条）。 */
  readonly userWordId: string;
  /** 所属会话；自由练习时为 `null`。 */
  readonly sessionId: string | null;
  /** 训练模式。 */
  readonly mode: TrainingMode;
  /** 题干原文（可能是 `abandon（v. 放弃）` 这类组合文本）。 */
  readonly prompt: string;
  /** 用户实际选择的答案文本。 */
  readonly answer: string;
  /** 是否答对（入库转 0/1）。 */
  readonly isCorrect: boolean;
  /** 自我认识判断。 */
  readonly recognition: Recognition;
  /** 作答前阶段。 */
  readonly stageBefore: number;
  /** 作答后阶段。 */
  readonly stageAfter: number;
  /** 作答时间（UTC ISO-8601）。 */
  readonly answeredAt: string;
  /** 按用户时区折算的本地日 `YYYY-MM-DD`。 */
  readonly localDate: string;
  /** IANA 时区名。 */
  readonly timeZone: string;
  /** 作答耗时（毫秒），未知为 `null`。 */
  readonly durationMs: number | null;
  /** 设备 id。 */
  readonly deviceId: string;
  /** 同步时间；**本地新写入恒为 `null`**（由同步流程回填）。 */
  readonly syncedAt: string | null;
}

/** 追加事件的结果。 */
export interface AppendEventResult {
  /** `false` 表示该 `eventId` 已存在（幂等命中），本次没有改动任何数据。 */
  readonly applied: boolean;
  /** 本次写入的 outbox 序号（幂等命中时为空数组）。 */
  readonly outboxSeqs: number[];
}

/** 错词本条目：状态里的计数 + 由事件派生的“最近答错时间”。 */
export interface MistakeRecord {
  /** 学习状态主键。 */
  readonly userWordId: string;
  /** 词条 id。 */
  readonly wordId: string;
  /** 累计答错次数。 */
  readonly wrongCount: number;
  /** 累计答对次数。 */
  readonly correctCount: number;
  /** 最近一次答错时间（UTC ISO-8601），由 `learning_events` 聚合而来。 */
  readonly lastWrongAt: string;
}

/** 一次学习会话（对应 `study_sessions` 一行）。 */
export interface StudySessionRecord {
  readonly sessionId: string;
  readonly deckId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly localDate: string;
  readonly timeZone: string;
  readonly newCount: number;
  readonly reviewCount: number;
  readonly activeDurationMs: number;
  readonly planSnapshotJson: string | null;
  readonly deviceId: string;
  readonly revision: number;
}

/** 某本地日的作答统计。 */
export interface DailyStatRecord {
  readonly localDate: string;
  readonly total: number;
  readonly correct: number;
  readonly wrong: number;
  readonly activeMs: number;
}

/** 学习仓储契约（Task 5 直接消费）。 */
export interface LearningRepository {
  appendEventAndUpdateState(event: LearningEventRecord, state: LearningState): AppendEventResult;
  getState(userWordId: string): LearningState | null;
  listStatesByDeck(deckId: string): LearningState[];
  listDue(deckId: string, now: Date): LearningState[];
  upsertSession(session: StudySessionRecord): void;
  listSessions(fromIso: string, toIso: string): StudySessionRecord[];
  listMistakes(deckId: string): MistakeRecord[];
  listDailyStats(fromLocalDate: string, toLocalDate: string): DailyStatRecord[];
}

/**
 * 学习状态主键：`${deckId}:${wordId}`。
 *
 * 同一个词出现在两个词库里是两条独立的学习状态（进度不互相污染），
 * 因此主键必须带上词库。
 *
 * @param deckId 词库 id。
 * @param wordId 词条 id。
 * @returns 稳定的 userWordId。
 */
export function makeUserWordId(deckId: string, wordId: string): string {
  if (typeof deckId !== 'string' || deckId.trim() === '') {
    throw new InvalidRepositoryInputError('deckId', '词库 id 必须是非空字符串');
  }
  if (typeof wordId !== 'string' || wordId.trim() === '') {
    throw new InvalidRepositoryInputError('wordId', '词条 id 必须是非空字符串');
  }
  return `${deckId}:${wordId}`;
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

/** `study_sessions` 行的 snake_case 形状。 */
interface StudySessionRow {
  session_id: string;
  deck_id: string;
  started_at: string;
  ended_at: string | null;
  local_date: string;
  time_zone: string;
  new_count: number;
  review_count: number;
  active_duration_ms: number;
  plan_snapshot_json: string | null;
  device_id: string;
  revision: number;
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

/** 行 → 会话记录。 */
function toSessionRecord(row: StudySessionRow): StudySessionRecord {
  return {
    sessionId: row.session_id,
    deckId: row.deck_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    localDate: row.local_date,
    timeZone: row.time_zone,
    newCount: row.new_count,
    reviewCount: row.review_count,
    activeDurationMs: row.active_duration_ms,
    planSnapshotJson: row.plan_snapshot_json,
    deviceId: row.device_id,
    revision: row.revision,
  };
}

/**
 * 校验非空字符串字段。
 *
 * @param value 待校验值。
 * @param field 字段名。
 * @returns 原值。
 * @throws {InvalidRepositoryInputError} 不是非空字符串时。
 */
function requireNonEmptyString(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidRepositoryInputError(field, '必须是非空字符串');
  }
  return value;
}

/**
 * 校验 ISO-8601 时间串。
 *
 * @param value 时间串。
 * @param field 字段名。
 * @returns 原值。
 * @throws {InvalidRepositoryInputError} 无法解析时。
 */
function requireIsoInstant(value: string, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new InvalidRepositoryInputError(field, `无法解析的时间：${String(value)}`);
  }
  return value;
}

/**
 * 校验非负整数。
 *
 * @param value 数值。
 * @param field 字段名。
 * @returns 原值。
 * @throws {InvalidRepositoryInputError} 不是非负整数时。
 */
function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidRepositoryInputError(field, `必须是非负整数，收到 ${String(value)}`);
  }
  return value;
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
  requireNonEmptyString(event.eventId, 'eventId');
  requireNonEmptyString(event.userWordId, 'userWordId');
  requireNonEmptyString(event.deviceId, 'deviceId');
  if (event.mode !== 'EN_TO_ZH' && event.mode !== 'ZH_TO_EN' && event.mode !== 'MIXED') {
    throw new InvalidRepositoryInputError('mode', `未知训练模式：${String(event.mode)}`);
  }
  if (event.recognition !== 'KNOWN' && event.recognition !== 'UNKNOWN') {
    throw new InvalidRepositoryInputError('recognition', `未知自评：${String(event.recognition)}`);
  }
  if (typeof event.isCorrect !== 'boolean') {
    throw new InvalidRepositoryInputError('isCorrect', 'isCorrect 必须是布尔值');
  }
  if (!Number.isInteger(event.stageBefore) || !Number.isInteger(event.stageAfter)) {
    throw new InvalidRepositoryInputError('stageAfter', 'stageBefore/stageAfter 必须是整数');
  }
  requireIsoInstant(event.answeredAt, 'answeredAt');
  if (typeof event.localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(event.localDate)) {
    throw new InvalidRepositoryInputError(
      'localDate',
      `localDate 必须是 YYYY-MM-DD，收到 ${String(event.localDate)}`,
    );
  }
  requireNonEmptyString(event.timeZone, 'timeZone');
  if (event.durationMs !== null) {
    requireNonNegativeInteger(event.durationMs, 'durationMs');
  }
  if (event.syncedAt !== null) {
    throw new InvalidRepositoryInputError(
      'syncedAt',
      '本地新写入的事件 syncedAt 必须为 null（同步流程回填，不由课程服务传入）',
    );
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
        recognition, stage_before, stage_after, answered_at, local_date, time_zone, duration_ms,
        device_id, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  const STATE_COLUMNS = `user_word_id, deck_id, word_id, stage, due_at, last_reviewed_at, correct_count,
                         wrong_count, streak_correct, weight, suppressed_at`;
  const selectState = db.prepare(`SELECT ${STATE_COLUMNS} FROM learning_state WHERE user_word_id = ?`);
  const selectStatesByDeck = db.prepare(
    `SELECT ${STATE_COLUMNS} FROM learning_state
      WHERE deck_id = ?
      ORDER BY due_at ASC, user_word_id ASC`,
  );
  const upsertState = db.prepare(
    `INSERT INTO learning_state
       (user_word_id, deck_id, word_id, stage, due_at, last_reviewed_at, correct_count, wrong_count,
        streak_correct, last_result, weight, suppressed_at, state_updated_at, device_id, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
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
       device_id = excluded.device_id,
       revision = learning_state.revision + 1`,
  );
  const selectDue = db.prepare(
    `SELECT ${STATE_COLUMNS} FROM learning_state
      WHERE deck_id = ? AND suppressed_at IS NULL AND due_at <= ?
      ORDER BY due_at ASC, user_word_id ASC`,
  );
  const upsertSession = db.prepare(
    `INSERT INTO study_sessions
       (session_id, deck_id, started_at, ended_at, local_date, time_zone, new_count, review_count,
        active_duration_ms, plan_snapshot_json, device_id, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET
       deck_id = excluded.deck_id,
       started_at = excluded.started_at,
       ended_at = excluded.ended_at,
       local_date = excluded.local_date,
       time_zone = excluded.time_zone,
       new_count = excluded.new_count,
       review_count = excluded.review_count,
       active_duration_ms = excluded.active_duration_ms,
       plan_snapshot_json = excluded.plan_snapshot_json,
       device_id = excluded.device_id,
       revision = study_sessions.revision + 1`,
  );
  const selectSessions = db.prepare(
    `SELECT session_id, deck_id, started_at, ended_at, local_date, time_zone, new_count,
            review_count, active_duration_ms, plan_snapshot_json, device_id, revision
       FROM study_sessions
      WHERE started_at >= ? AND started_at <= ?
      ORDER BY started_at ASC, session_id ASC`,
  );
  /**
   * 错词本：`lastWrongAt` 用相关子查询从事件里取 `MAX(answered_at) WHERE is_correct = 0`。
   *
   * 用 `JOIN ... is_correct = 0` 而不是 `LEFT JOIN`：只答对过的词不该出现在错词本里，
   * 这样 `lastWrongAt` 恒有值，服务层不用处理 `null`。
   */
  const selectMistakes = db.prepare(
    `SELECT s.user_word_id, s.word_id, s.correct_count, s.wrong_count,
            MAX(e.answered_at) AS last_wrong_at
       FROM learning_state s
       JOIN learning_events e ON e.user_word_id = s.user_word_id AND e.is_correct = 0
      WHERE s.deck_id = ?
      GROUP BY s.user_word_id, s.word_id, s.correct_count, s.wrong_count
      ORDER BY s.wrong_count DESC, last_wrong_at DESC, s.user_word_id ASC`,
  );
  const selectDailyStats = db.prepare(
    `SELECT local_date,
            COUNT(*) AS total,
            SUM(is_correct) AS correct,
            SUM(1 - is_correct) AS wrong,
            SUM(ifnull(duration_ms, 0)) AS active_ms
       FROM learning_events
      WHERE local_date >= ? AND local_date <= ?
      GROUP BY local_date
      ORDER BY local_date ASC`,
  );

  return {
    appendEventAndUpdateState(
      event: LearningEventRecord,
      state: LearningState,
    ): AppendEventResult {
      assertValidEvent(event);
      if (state === null || typeof state !== 'object') {
        throw new InvalidRepositoryInputError('state', '学习状态不能为空');
      }
      if (typeof state.userWordId !== 'string' || state.userWordId.trim() === '') {
        throw new InvalidRepositoryInputError('state.userWordId', '学习状态主键必须是非空字符串');
      }
      if (state.userWordId !== event.userWordId) {
        // 不是入参格式问题，而是调用方把两条不同记录拼在了一起：必须整笔回滚。
        throw new RepositoryInvariantError(
          'event.userWordId === state.userWordId',
          `事件记在 ${event.userWordId} 上，状态却是 ${state.userWordId}`,
        );
      }

      return runInTransaction(
        db,
        () => {
          if (selectEvent.get(event.eventId) !== undefined) {
            // 幂等命中：不改状态、不加计数、不写发件箱。
            return { applied: false, outboxSeqs: [] };
          }

          insertEvent.run(
            event.eventId,
            event.userWordId,
            state.deckId,
            state.wordId,
            event.sessionId,
            event.mode,
            event.prompt,
            event.answer,
            event.isCorrect ? 1 : 0,
            event.recognition,
            event.stageBefore,
            event.stageAfter,
            event.answeredAt,
            event.localDate,
            event.timeZone,
            event.durationMs,
            event.deviceId,
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
            // 状态最后变更时间取事件时间而不是本地时钟：回放/同步时才能得到同一结果。
            event.answeredAt,
            event.deviceId,
          );

          const outboxSeqs = [
            enqueueOutboxWithin(db, {
              entityType: 'LEARNING_EVENT',
              entityId: event.eventId,
              operation: 'UPSERT',
              payload: event,
              createdAt: event.answeredAt,
            }),
            enqueueOutboxWithin(db, {
              entityType: 'LEARNING_STATE',
              entityId: state.userWordId,
              operation: 'UPSERT',
              payload: state,
              createdAt: event.answeredAt,
            }),
          ];

          return { applied: true, outboxSeqs };
        },
        { mode: 'IMMEDIATE' },
      );
    },

    getState(userWordId: string): LearningState | null {
      requireNonEmptyString(userWordId, 'userWordId');
      const row = selectState.get(userWordId) as LearningStateRow | undefined;
      return row === undefined ? null : toLearningState(row);
    },

    listStatesByDeck(deckId: string): LearningState[] {
      requireNonEmptyString(deckId, 'deckId');
      const rows = selectStatesByDeck.all(deckId) as LearningStateRow[];
      return rows.map(toLearningState);
    },

    listDue(deckId: string, now: Date): LearningState[] {
      requireNonEmptyString(deckId, 'deckId');
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new InvalidRepositoryInputError('now', '当前时刻必须是有效 Date');
      }
      const rows = selectDue.all(deckId, now.toISOString()) as LearningStateRow[];
      return rows.map(toLearningState);
    },

    upsertSession(session: StudySessionRecord): void {
      if (session === null || typeof session !== 'object') {
        throw new InvalidRepositoryInputError('session', '学习会话不能为空');
      }
      requireNonEmptyString(session.sessionId, 'sessionId');
      requireNonEmptyString(session.deckId, 'deckId');
      requireNonEmptyString(session.deviceId, 'deviceId');
      requireIsoInstant(session.startedAt, 'startedAt');
      if (session.endedAt !== null) {
        requireIsoInstant(session.endedAt, 'endedAt');
      }
      if (typeof session.localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(session.localDate)) {
        throw new InvalidRepositoryInputError('localDate', 'localDate 必须是 YYYY-MM-DD');
      }
      requireNonEmptyString(session.timeZone, 'timeZone');
      requireNonNegativeInteger(session.newCount, 'newCount');
      requireNonNegativeInteger(session.reviewCount, 'reviewCount');
      requireNonNegativeInteger(session.activeDurationMs, 'activeDurationMs');
      requireNonNegativeInteger(session.revision, 'revision');

      runInTransaction(
        db,
        () => {
          upsertSession.run(
            session.sessionId,
            session.deckId,
            session.startedAt,
            session.endedAt,
            session.localDate,
            session.timeZone,
            session.newCount,
            session.reviewCount,
            session.activeDurationMs,
            session.planSnapshotJson,
            session.deviceId,
            session.revision,
          );
        },
        { mode: 'IMMEDIATE' },
      );
    },

    listSessions(fromIso: string, toIso: string): StudySessionRecord[] {
      requireIsoInstant(fromIso, 'fromIso');
      requireIsoInstant(toIso, 'toIso');
      const rows = selectSessions.all(fromIso, toIso) as StudySessionRow[];
      return rows.map(toSessionRecord);
    },

    listMistakes(deckId: string): MistakeRecord[] {
      requireNonEmptyString(deckId, 'deckId');
      const rows = selectMistakes.all(deckId) as {
        user_word_id: string;
        word_id: string;
        correct_count: number;
        wrong_count: number;
        last_wrong_at: string;
      }[];
      return rows.map((row) => ({
        userWordId: row.user_word_id,
        wordId: row.word_id,
        wrongCount: row.wrong_count,
        correctCount: row.correct_count,
        lastWrongAt: row.last_wrong_at,
      }));
    },

    listDailyStats(fromLocalDate: string, toLocalDate: string): DailyStatRecord[] {
      if (
        typeof fromLocalDate !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(fromLocalDate) ||
        typeof toLocalDate !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(toLocalDate)
      ) {
        throw new InvalidRepositoryInputError('localDate', '本地日期必须是 YYYY-MM-DD');
      }
      const rows = selectDailyStats.all(fromLocalDate, toLocalDate) as {
        local_date: string;
        total: number;
        correct: number;
        wrong: number;
        active_ms: number;
      }[];
      return rows.map((row) => ({
        localDate: row.local_date,
        total: row.total,
        correct: row.correct,
        wrong: row.wrong,
        activeMs: row.active_ms,
      }));
    },
  };
}
