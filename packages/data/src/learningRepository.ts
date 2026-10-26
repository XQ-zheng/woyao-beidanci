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
  /**
   * 某个会话的全部作答事件，按 `answered_at` 升序（Task 5B 补）。
   *
   * `finishSession` 要用它汇总“新词数/复习数/时长”，口径必须来自**事件事实**
   * 而不是会话行上的预估数（会话行里的 `new_count` 是开始时的队列长度）。
   */
  listEventsBySession(sessionId: string): LearningEventRecord[];
  /**
   * 某个词库在时间区间内的作答事件，按 `answered_at` 升序（Task 5B 补）。
   *
   * 用 `learning_events.deck_id` 这个**冗余列**过滤：事件表要能在不 JOIN
   * `learning_state` 的前提下按词库汇总（取舍见 docs §4.2），评估的 90 天窗口正是这种查询。
   * 区间是**闭区间**，两端都要过与写入同一套 ISO 严格校验（字典序比较的前提）。
   */
  listEventsByDeck(deckId: string, fromIso: string, toIso: string): LearningEventRecord[];
  /**
   * 只更新学习状态（Task 5B 补）。
   *
   * 用于“此单词不再出现”这类**没有对应事件**的状态变更：抑制不是一次作答，
   * 塞进 `appendEventAndUpdateState` 会凭空造出一条假事件、污染正确率与时长统计。
   * 同事务写一条 `LEARNING_STATE` 发件箱，保证状态变更能被同步。
   */
  updateState(state: LearningState, deviceId: string, now: Date): void;
  /**
   * 按 id 读一个会话（Task 5B 补）。
   *
   * `finishSession` 只拿到 `sessionId`，却需要 `deckId` / `startedAt` / `timeZone` /
   * `plan_snapshot_json` 才能把会话行写完整；没有这个方法就只能靠
   * `listSessions(极早时间, now)` 全表扫一遍再筛，既慢又容易在时钟回拨时漏掉。
   */
  getSession(sessionId: string): StudySessionRecord | null;
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

/** `learning_events` 行的 snake_case 形状。 */
interface LearningEventRow {
  event_id: string;
  user_word_id: string;
  session_id: string | null;
  mode: TrainingMode;
  prompt: string;
  answer: string;
  is_correct: number;
  recognition: Recognition;
  stage_before: number;
  stage_after: number;
  answered_at: string;
  local_date: string;
  time_zone: string;
  duration_ms: number | null;
  device_id: string;
  synced_at: string | null;
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

/** 行 → 作答事件。`is_correct` 在库里是 0/1，必须还原成布尔，否则 `if (event.isCorrect)` 恒真。 */
function toEventRecord(row: LearningEventRow): LearningEventRecord {
  return {
    eventId: row.event_id,
    userWordId: row.user_word_id,
    sessionId: row.session_id,
    mode: row.mode,
    prompt: row.prompt,
    answer: row.answer,
    isCorrect: row.is_correct === 1,
    recognition: row.recognition,
    stageBefore: row.stage_before,
    stageAfter: row.stage_after,
    answeredAt: row.answered_at,
    localDate: row.local_date,
    timeZone: row.time_zone,
    durationMs: row.duration_ms,
    deviceId: row.device_id,
    syncedAt: row.synced_at,
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
 * 允许落库的唯一时间形态：**UTC、ISO-8601、毫秒、`Z` 结尾**。
 *
 * 为什么必须钉死格式而不是只做 `Date.parse`：库里所有时间列都靠**字符串字典序**比较
 * （`listDue` 的 `due_at <= ?`、`ORDER BY answered_at`、`listSessions` 的区间），
 * 只要混进一种别的写法，比较结果就会静默出错：
 * - `2025-06-30T12:00:00+08:00` → 字典序把它排在 `2025-06-30T04:00:00.000Z` **之后**，
 *   而两者其实是同一时刻；
 * - `2025-06-30T04:00:00Z`（无毫秒）→ 与带毫秒的值比较时长度不同，边界会错；
 * - `2025-06-30 04:00:00`（空格分隔 / 本地时间）→ 既非 UTC 也不可比。
 *
 * 刻意**不**用 `new Date(value).toISOString()` 归一化：那会把调用方的 bug
 * （比如传了本地时间）变成一条“看起来对”的数据，等到跨时区才暴露。
 */
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** 本地日 `YYYY-MM-DD`（同样参与字典序比较，因此也钉死形态）。 */
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * 校验 UTC ISO-8601 毫秒时间串。
 *
 * @param value 时间串。
 * @param field 字段名。
 * @returns 原值。
 * @throws {InvalidRepositoryInputError} 格式不符或无法解析时。
 */
function requireIsoInstant(value: string, field: string): string {
  if (
    typeof value !== 'string' ||
    !ISO_INSTANT_PATTERN.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new InvalidRepositoryInputError(
      field,
      `必须是 UTC ISO-8601 毫秒格式（YYYY-MM-DDTHH:mm:ss.sssZ），收到 ${String(value)}`,
    );
  }
  return value;
}

/**
 * 校验本地日 `YYYY-MM-DD`。
 *
 * @param value 日期串。
 * @param field 字段名。
 * @returns 原值。
 * @throws {InvalidRepositoryInputError} 格式不符时。
 */
function requireLocalDate(value: string, field: string): string {
  if (typeof value !== 'string' || !LOCAL_DATE_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new InvalidRepositoryInputError(
      field,
      `必须是 YYYY-MM-DD，收到 ${String(value)}`,
    );
  }
  return value;
}

/**
 * 把注入的时刻转成落库用的 UTC ISO-8601 毫秒串。
 *
 * 仍然不调用 `new Date()`（无参）：时间只从调用方来。`toISOString()` 恰好产出
 * 与 `ISO_INSTANT_PATTERN` 完全一致的形态，因此“写入”和“校验”用的是同一条规则。
 *
 * @param now 注入的时刻。
 * @param field 字段名。
 * @returns ISO 串。
 * @throws {InvalidRepositoryInputError} 不是有效 Date 时。
 */
function toIsoInstant(now: Date, field = 'now'): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new InvalidRepositoryInputError(field, `${field} 必须是有效 Date`);
  }
  return now.toISOString();
}

/**
 * 校验非负整数。
 *
 * @param value 数值。
 * @param field 字段名。
 * @returns 原值。
 * @throws {InvalidRepositoryInputError} 不是非负整数时。
 */
function requireNonNegativeInteger(value: number, field: string): number {  if (!Number.isInteger(value) || value < 0) {
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
  requireLocalDate(event.localDate, 'localDate');
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
 * 校验学习状态。
 *
 * 重点是 `dueAt` / `lastReviewedAt` / `suppressedAt`：它们要么参与 `listDue` 的范围过滤
 * （`due_at <= ?`），要么参与 `ORDER BY`，全部靠**字符串字典序**比较，因此必须与事件时间
 * 用同一套格式校验。只校验事件不校验状态等于留了扇后门——状态是调用方算出来的，
 * 恰恰是最容易混进本地时间/带偏移写法的地方。
 *
 * @param state 学习状态。
 * @throws {InvalidRepositoryInputError} 任一字段非法时。
 */
function assertValidState(state: LearningState): void {
  if (state === null || typeof state !== 'object') {
    throw new InvalidRepositoryInputError('state', '学习状态不能为空');
  }
  requireNonEmptyString(state.userWordId, 'state.userWordId');
  requireNonEmptyString(state.deckId, 'state.deckId');
  requireNonEmptyString(state.wordId, 'state.wordId');
  requireIsoInstant(state.dueAt, 'state.dueAt');
  if (state.lastReviewedAt !== null) {
    requireIsoInstant(state.lastReviewedAt, 'state.lastReviewedAt');
  }
  if (state.suppressedAt !== null) {
    requireIsoInstant(state.suppressedAt, 'state.suppressedAt');
  }
  if (!Number.isInteger(state.stage)) {
    throw new InvalidRepositoryInputError(
      'state.stage',
      `stage 必须是整数，收到 ${String(state.stage)}`,
    );
  }
  requireNonNegativeInteger(state.correctCount, 'state.correctCount');
  requireNonNegativeInteger(state.wrongCount, 'state.wrongCount');
  requireNonNegativeInteger(state.streakCorrect, 'state.streakCorrect');
  if (typeof state.weight !== 'number' || !Number.isFinite(state.weight)) {
    throw new InvalidRepositoryInputError(
      'state.weight',
      `weight 必须是有限数字，收到 ${String(state.weight)}`,
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
  const EVENT_COLUMNS = `event_id, user_word_id, session_id, mode, prompt, answer, is_correct,
                         recognition, stage_before, stage_after, answered_at, local_date, time_zone,
                         duration_ms, device_id, synced_at`;
  // 排序带 `event_id` 兜底：同一毫秒内的两条事件（批量导入/回放）也要有稳定次序，
  // 否则 `finishSession` 的汇总在不同机器上可能得到不同的“最后一条”。
  const selectEventsBySession = db.prepare(
    `SELECT ${EVENT_COLUMNS} FROM learning_events
      WHERE session_id = ?
      ORDER BY answered_at ASC, event_id ASC`,
  );
  const selectEventsByDeck = db.prepare(
    `SELECT ${EVENT_COLUMNS} FROM learning_events
      WHERE deck_id = ? AND answered_at >= ? AND answered_at <= ?
      ORDER BY answered_at ASC, event_id ASC`,
  );
  const selectSessionById = db.prepare(
    `SELECT session_id, deck_id, started_at, ended_at, local_date, time_zone, new_count,
            review_count, active_duration_ms, plan_snapshot_json, device_id, revision
       FROM study_sessions
      WHERE session_id = ?`,
  );
  /**
   * 只写状态、不写作答结果。
   *
   * 与 `upsertState` 的差别只有一处：`DO UPDATE` 里**不碰** `last_result`。
   * 抑制/恢复并没有“答对/答错”这回事，保留上一次的真实结果才是对的。
   */
  const upsertStateOnly = db.prepare(
    `INSERT INTO learning_state
       (user_word_id, deck_id, word_id, stage, due_at, last_reviewed_at, correct_count, wrong_count,
        streak_correct, last_result, weight, suppressed_at, state_updated_at, device_id, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0)
     ON CONFLICT (user_word_id) DO UPDATE SET
       deck_id = excluded.deck_id,
       word_id = excluded.word_id,
       stage = excluded.stage,
       due_at = excluded.due_at,
       last_reviewed_at = excluded.last_reviewed_at,
       correct_count = excluded.correct_count,
       wrong_count = excluded.wrong_count,
       streak_correct = excluded.streak_correct,
       weight = excluded.weight,
       suppressed_at = excluded.suppressed_at,
       state_updated_at = excluded.state_updated_at,
       device_id = excluded.device_id,
       revision = learning_state.revision + 1`,
  );

  return {
    appendEventAndUpdateState(
      event: LearningEventRecord,
      state: LearningState,
    ): AppendEventResult {
      assertValidEvent(event);
      assertValidState(state);
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
      requireLocalDate(session.localDate, 'localDate');
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
      requireLocalDate(fromLocalDate, 'fromLocalDate');
      requireLocalDate(toLocalDate, 'toLocalDate');
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

    listEventsBySession(sessionId: string): LearningEventRecord[] {
      requireNonEmptyString(sessionId, 'sessionId');
      const rows = selectEventsBySession.all(sessionId) as LearningEventRow[];
      return rows.map(toEventRecord);
    },

    listEventsByDeck(deckId: string, fromIso: string, toIso: string): LearningEventRecord[] {
      requireNonEmptyString(deckId, 'deckId');
      // 两端都用与写入完全相同的严格校验：`answered_at` 的区间比较是**字符串字典序**，
      // 只要有一个端点用了别的写法（偏移、无毫秒、空格分隔），结果就会静默错位。
      const from = requireIsoInstant(fromIso, 'fromIso');
      const to = requireIsoInstant(toIso, 'toIso');
      const rows = selectEventsByDeck.all(deckId, from, to) as LearningEventRow[];
      return rows.map(toEventRecord);
    },

    updateState(state: LearningState, deviceId: string, now: Date): void {
      assertValidState(state);
      const device = requireNonEmptyString(deviceId, 'deviceId');
      const nowIso = toIsoInstant(now, 'now');
      const payload: LearningState = { ...state };

      runInTransaction(
        db,
        () => {
          // 刻意用独立语句而不是复用 `upsertState`：后者要求一个 `last_result`
          // （CORRECT/WRONG），而“不再出现”这类状态变更根本没有作答结果。
          // 复用会逼着我们编一个结果出来，直接污染“最近一次结果”的展示。
          upsertStateOnly.run(
            state.userWordId,
            state.deckId,
            state.wordId,
            state.stage,
            state.dueAt,
            state.lastReviewedAt,
            state.correctCount,
            state.wrongCount,
            state.streakCorrect,
            state.weight,
            state.suppressedAt,
            nowIso,
            device,
          );

          enqueueOutboxWithin(db, {
            entityType: 'LEARNING_STATE',
            entityId: state.userWordId,
            operation: 'UPSERT',
            payload,
            createdAt: nowIso,
          });
        },
        { mode: 'IMMEDIATE' },
      );
    },

    getSession(sessionId: string): StudySessionRecord | null {
      requireNonEmptyString(sessionId, 'sessionId');
      const row = selectSessionById.get(sessionId) as StudySessionRow | undefined;
      return row === undefined ? null : toSessionRecord(row);
    },
  };
}
