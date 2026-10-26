/**
 * 报表服务：水平评估、日统计、会话列表、错词本。
 *
 * 两条不可越线的约束：
 * 1. **口径由 `@woyao/core` 决定**：评估窗口是 `ASSESSMENT_WINDOW_DAYS`（90 天，
 *    固定毫秒而非本地日历日）、等级门槛、置信度、建议排序全在 `evaluateAssessment` 里。
 *    本文件只负责取事件、把事件投影成 `AssessmentEvent`、再把 core 的结果**原样**透传
 *    （含 `algorithmVersion` / `generatedAt` / `windowStart` / `windowEnd`，Task 6 要展示）。
 * 2. **空数据不编造**：没有作答就返回 `INSUFFICIENT_SAMPLE`（core 负责）、
 *    错词本没有错词就返回空数组。服务层绝不自己造等级、造建议、造“鼓励文案”。
 *
 * 一处已知限制（写进报告，别当成 bug 反复查）：`learning_events` 不存 `due_at`，
 * 所以投影出来的 `AssessmentEvent` 没有 `dueAt`，评估的 M 项（到期复习 48 小时内答对率）
 * 永远拿不到样本、恒用中性值 `0.5`。core 会为此显式追加一条“复习样本不足”的说明，
 * 因此 UI 不会误导用户；要真正算出 M 需要给事件表加 `due_at` 列（迁移，另开任务）。
 */

import {
  ASSESSMENT_WINDOW_DAYS,
  MS_PER_DAY,
  STAGE_NEVER_REVIEWED,
  evaluateAssessment,
  parseIsoInstant,
  toIsoInstant,
  type AssessmentEvent,
  type AssessmentLevel,
  type AssessmentResult,
} from '@woyao/core';

import {
  MISTAKES_LIMIT_DEFAULT,
  assessmentInputSchema,
  dailyHistoryInputSchema,
  isoRangeInputSchema,
  mistakesInputSchema,
  parseOrThrow,
  type SenseView,
} from './dto';
import { ServiceValidationError } from './errors';
import type { ServiceContext } from './ports';
import { wordIdFromUserWordId, type SessionSummary } from './studyService';

/** 水平评估视图（core 的结果 + 词库 id，字段一一对应，不做任何重算）。 */
export interface AssessmentView {
  readonly deckId: string;
  /** 0–100 的综合得分；样本为空时为 0。 */
  readonly score: number;
  /** 等级；样本不达标时恒为 `INSUFFICIENT_SAMPLE`。 */
  readonly level: AssessmentLevel;
  /** 词库覆盖率（至少答对一次的词数 / 词库词数）。 */
  readonly coverage: number;
  /** 置信度。 */
  readonly confidence: number;
  /** 窗口内作答过的不同词数。 */
  readonly distinctWords: number;
  /** 窗口内有效作答次数。 */
  readonly validAnswers: number;
  /** core 给出的建议（含“样本不足”“M 用中性值”等事实性说明）。 */
  readonly suggestions: string[];
  /** 评分算法版本（口径变化的唯一标识）。 */
  readonly algorithmVersion: string;
  /** 本次评估的生成时刻 = 调用方注入的 `now`。 */
  readonly generatedAt: string;
  /** 分析窗口起点（闭区间）。 */
  readonly windowStart: string;
  /** 分析窗口终点（闭区间）。 */
  readonly windowEnd: string;
}

/** 某个本地日的作答统计。 */
export interface DailyHistoryRow {
  /** 本地日 `YYYY-MM-DD`。 */
  readonly localDate: string;
  /** 当日作答总数。 */
  readonly total: number;
  readonly correct: number;
  readonly wrong: number;
  /** 当日作答耗时之和（毫秒）。 */
  readonly activeMs: number;
  /** 正确率 `[0,1]`；当日没有作答时为 0（不是 NaN，也不是 1）。 */
  readonly accuracy: number;
}

/** 错词本的一行。 */
export interface MistakeView {
  readonly wordId: string;
  readonly userWordId: string;
  readonly lemma: string;
  /** 累计答错次数（学习状态里的计数，不清零）。 */
  readonly wrongCount: number;
  /** 累计答对次数。 */
  readonly correctCount: number;
  /** 最近一次答错时间（UTC ISO 毫秒）。 */
  readonly lastWrongAt: string;
  /** 义项简解（错词本列表要能直接显示词义）。 */
  readonly senses: SenseView[];
  /** 最近 7 天内是否又错过（用户能一眼看出“这个还是没记住”）。 */
  readonly recentWrong: boolean;
}

/** 报表服务契约。 */
export interface ReportService {
  /** 所选词库的水平评估（最近 90 天）。 */
  getAssessment(input: { deckId: string; now: Date }): Promise<AssessmentView>;
  /** 某个本地日区间内的逐日统计（含两端）。 */
  getDailyHistory(input: { fromLocalDate: string; toLocalDate: string }): Promise<DailyHistoryRow[]>;
  /** 某个时间区间内的会话列表（按开始时间升序）。 */
  listSessions(input: { fromIso: string; toIso: string }): Promise<SessionSummary[]>;
  /** 错词本（按累计错次降序，最多 `limit` 条）。 */
  getMistakes(input: { deckId: string; limit?: number }): Promise<MistakeView[]>;
}

/** 构造参数。 */
export interface ReportServiceOptions {
  readonly context: ServiceContext;
}

/** “最近又错”的判定窗口：7 天。 */
export const RECENT_WRONG_WINDOW_DAYS = 7;

/**
 * 创建报表服务。
 *
 * @param options 上下文。
 * @returns 报表服务实例。
 */
export function createReportService(options: ReportServiceOptions): ReportService {
  const { context } = options;

  /**
   * 把库里的事件投影成评估所需的最小形状。
   *
   * 事件表不存 `word_id`（只存 `user_word_id`），因此这里按已知 `deckId` 剥前缀还原。
   *
   * @param events 事件记录。
   * @param deckId 词库 id。
   * @returns 评估事件数组。
   */
  function toAssessmentEvents(
    events: readonly { userWordId: string; isCorrect: boolean; recognition: 'KNOWN' | 'UNKNOWN'; answeredAt: string }[],
    deckId: string,
  ): AssessmentEvent[] {
    return events.map((event) => ({
      wordId: wordIdFromUserWordId(deckId, event.userWordId),
      isCorrect: event.isCorrect,
      recognition: event.recognition,
      answeredAt: event.answeredAt,
    }));
  }

  /**
   * 统计一个会话的作答事实（与 `studyService.finishSession` **同一套口径**）。
   *
   * 会话行上的 `new_count`/`review_count` 是“开始时的队列长度”，中途跳过/删卡
   * 就会与事实不符。若列表用会话行、详情用事件，同一个会话会出现两个新词数——
   * 用户会以为数据坏了。所以这里一律从事件汇总：
   * `stageBefore === STAGE_NEVER_REVIEWED` 的是新词，其余是复习。
   *
   * @param sessionId 会话 id。
   * @returns 各类计数（全部来自事件事实）。
   */
  async function summarizeSession(sessionId: string): Promise<{
    newCount: number;
    reviewCount: number;
    totalAnswers: number;
    correctCount: number;
    activeDurationMs: number;
  }> {
    const events = await context.repos.learning.listEventsBySession(sessionId);
    let newCount = 0;
    let correctCount = 0;
    let activeDurationMs = 0;
    for (const event of events) {
      if (event.stageBefore === STAGE_NEVER_REVIEWED) {
        newCount += 1;
      }
      if (event.isCorrect) {
        correctCount += 1;
      }
      activeDurationMs += event.durationMs ?? 0;
    }
    return {
      newCount,
      reviewCount: events.length - newCount,
      totalAnswers: events.length,
      correctCount,
      activeDurationMs,
    };
  }

  return {
    async getAssessment(input: { deckId: string; now: Date }): Promise<AssessmentView> {
      const validated = parseOrThrow(assessmentInputSchema, input, '水平评估');

      // 窗口口径来自 core 的常量，**不在这里写 90**：口径一旦调整，
      // 只改 core 一处，报表与评估结果不会各说一套。
      const windowStartInstant = new Date(
        validated.now.getTime() - ASSESSMENT_WINDOW_DAYS * MS_PER_DAY,
      );
      const [events, deckWordIds] = await Promise.all([
        context.repos.learning.listEventsByDeck(
          validated.deckId,
          toIsoInstant(windowStartInstant),
          toIsoInstant(validated.now),
        ),
        context.repos.words.listDeckWordIds(validated.deckId),
      ]);

      const result: AssessmentResult = evaluateAssessment(
        toAssessmentEvents(events, validated.deckId),
        deckWordIds.length,
        validated.now,
      );

      // 原样透传：不重算 score、不改 level、不裁剪 suggestions。
      return {
        deckId: validated.deckId,
        score: result.score,
        level: result.level,
        coverage: result.coverage,
        confidence: result.confidence,
        distinctWords: result.distinctWords,
        validAnswers: result.validAnswers,
        suggestions: [...result.suggestions],
        algorithmVersion: result.algorithmVersion,
        generatedAt: result.generatedAt,
        windowStart: result.windowStart,
        windowEnd: result.windowEnd,
      };
    },

    async getDailyHistory(input: {
      fromLocalDate: string;
      toLocalDate: string;
    }): Promise<DailyHistoryRow[]> {
      const validated = parseOrThrow(dailyHistoryInputSchema, input, '日统计');
      // 本地日是 `YYYY-MM-DD`，字典序即时间序；反向区间直接拒绝，
      // 否则会返回空数组、UI 看起来像“这几天没学习”。
      if (validated.fromLocalDate > validated.toLocalDate) {
        throw new ServiceValidationError(
          [
            {
              path: 'fromLocalDate',
              message: `起始日 ${validated.fromLocalDate} 晚于结束日 ${validated.toLocalDate}`,
            },
          ],
          '日统计校验未通过',
        );
      }
      const stats = await context.repos.learning.listDailyStats(
        validated.fromLocalDate,
        validated.toLocalDate,
      );
      return stats.map((stat) => ({
        localDate: stat.localDate,
        total: stat.total,
        correct: stat.correct,
        wrong: stat.wrong,
        activeMs: stat.activeMs,
        // 没有作答的那天不会出现在结果里；出现的一定 total > 0，
        // 但仍显式判零，避免以后改了聚合口径时冒出 NaN。
        accuracy: stat.total > 0 ? stat.correct / stat.total : 0,
      }));
    },

    async listSessions(input: { fromIso: string; toIso: string }): Promise<SessionSummary[]> {
      const validated = parseOrThrow(isoRangeInputSchema, input, '会话列表');
      if (validated.fromIso > validated.toIso) {
        throw new ServiceValidationError(
          [{ path: 'fromIso', message: `起始时间 ${validated.fromIso} 晚于结束时间 ${validated.toIso}` }],
          '会话列表校验未通过',
        );
      }
      const sessions = await context.repos.learning.listSessions(
        validated.fromIso,
        validated.toIso,
      );

      const summaries: SessionSummary[] = [];
      for (const session of sessions) {
        // N+1：每个会话再查一次事件。会话数量级是“每天一两个”，
        // 而“新词数必须等于事件事实”这条不能妥协，所以先接受这个查询量。
        const summary = await summarizeSession(session.sessionId);
        summaries.push({
          sessionId: session.sessionId,
          deckId: session.deckId,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          localDate: session.localDate,
          timeZone: session.timeZone,
          // 计数全部取事件事实，**不用**会话行上的 `newCount` / `reviewCount` /
          // `activeDurationMs`（那三个是开始时的预估与递增快照，跳过卡片就会失真）。
          newCount: summary.newCount,
          reviewCount: summary.reviewCount,
          totalAnswers: summary.totalAnswers,
          correctCount: summary.correctCount,
          activeDurationMs: summary.activeDurationMs,
        });
      }
      return summaries;
    },

    async getMistakes(input: { deckId: string; limit?: number }): Promise<MistakeView[]> {
      const validated = parseOrThrow(mistakesInputSchema, input, '错词本');
      const limit = validated.limit ?? MISTAKES_LIMIT_DEFAULT;
      // 数据层已按“累计错次降序 → 最近答错时间降序”排好，并只返回**至少错过一次**的词。
      const mistakes = await context.repos.learning.listMistakes(validated.deckId);
      const picked = mistakes.slice(0, limit);
      if (picked.length === 0) {
        return [];
      }

      const nowMilliseconds = context.clock.now().getTime();
      const recentThresholdMilliseconds =
        nowMilliseconds - RECENT_WRONG_WINDOW_DAYS * MS_PER_DAY;

      const words = await context.repos.words.listWordsByIds(picked.map((row) => row.wordId));
      const lemmaByWordId = new Map<string, string>();
      for (const word of words) {
        lemmaByWordId.set(word.id, word.lemma);
      }

      const views: MistakeView[] = [];
      for (const mistake of picked) {
        const senses = await context.repos.words.listSenses(mistake.wordId);
        const senseViews: SenseView[] = senses.map((sense) => ({
          senseNo: sense.senseNo,
          pos: sense.pos,
          simpleZh: sense.simpleZh,
          detailedZh: sense.detailedZh,
          contextText: sense.contextText,
        }));
        // 时间戳损坏时按“不是最近错的”处理（`parseIsoInstant` 会抛，这里要宽松）：
        // 一条脏事件不该让整个错词本打不开。
        let lastWrongMilliseconds: number;
        try {
          lastWrongMilliseconds = parseIsoInstant(mistake.lastWrongAt, 'lastWrongAt').getTime();
        } catch {
          lastWrongMilliseconds = Number.NaN;
        }
        views.push({
          wordId: mistake.wordId,
          userWordId: mistake.userWordId,
          // 词条行被删掉时用词条 id 占位，而不是让 lemma 变成 empty string 后 UI 一片空白。
          lemma: lemmaByWordId.get(mistake.wordId) ?? mistake.wordId,
          wrongCount: mistake.wrongCount,
          correctCount: mistake.correctCount,
          lastWrongAt: mistake.lastWrongAt,
          senses: senseViews,
          recentWrong:
            Number.isFinite(lastWrongMilliseconds) &&
            lastWrongMilliseconds >= recentThresholdMilliseconds &&
            lastWrongMilliseconds <= nowMilliseconds,
        });
      }
      return views;
    },
  };
}
