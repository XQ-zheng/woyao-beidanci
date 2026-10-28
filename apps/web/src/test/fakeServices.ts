/**
 * 6B 页面测试用的假服务。
 *
 * 页面只通过 `useServices()` 消费服务，所以测试可以在不改任何生产代码的前提下注入假实现。
 * 这里只实现 6B 真正用到的方法（settings/library/study/report/content），其余服务用
 * `notUsed()` 占位：一旦页面越界调用了它们，运行时会立刻抛错而不是静默通过。
 */
import { vi } from 'vitest';
import type {
  AnswerResult,
  AssessmentView,
  CardView,
  DailyHistoryRow,
  DeckSummary,
  Services,
  SessionSummary,
  SessionView,
  SettingsSnapshot,
} from '@woyao/services';

/** 默认设置快照（与 5A 的缺省计划一致，避免测试依赖真实数据库的初始值）。 */
export const defaultSettings: SettingsSnapshot = {
  dailyNewLimit: 20,
  dailyReviewLimit: 100,
  intervalsDays: [1, 2, 4, 7, 15, 30],
  timeZone: 'Asia/Shanghai',
  trainingMode: 'MIXED',
  questionStyle: 'CHOICE',
  accent: 'uk',
  volume: 1,
  fontScale: 1,
  autoStart: false,
  minimizeToTray: false,
};

/** 造一张选择题卡片。 */
export function makeCard(overrides: Partial<CardView> = {}): CardView {
  return {
    wordId: 'w-abandon',
    lemma: 'abandon',
    phoneticUk: 'əˈbændən',
    phoneticUs: 'əˈbændən',
    mode: 'EN_TO_ZH',
    style: 'CHOICE',
    prompt: 'abandon',
    answer: '放弃',
    options: ['放弃', '吸收', '维持', '庆祝'],
    senses: [
      {
        senseNo: 1,
        pos: 'v.',
        simpleZh: '放弃',
        detailedZh: '丢开、舍弃，不再坚持',
        contextText: 'He abandoned the plan.',
      },
    ],
    frequency: {
      importance: 'HIGH',
      frequency: 1200,
      rank: 800,
      totalTokens: 1000000,
      corpusVersion: '2026-10',
      sourceId: 'cet4',
    },
    isNew: true,
    isFavorite: false,
    ...overrides,
  };
}

/** 造一次会话（默认两张卡：一张选择、一张揭示）。 */
export function makeSession(cards: readonly CardView[] = [makeCard()]): SessionView {
  return {
    sessionId: 's-1',
    deckId: 'deck-cet4',
    startedAt: '2026-10-27T02:00:00.000Z',
    localDate: '2026-10-27',
    timeZone: 'Asia/Shanghai',
    newCount: cards.length,
    reviewCount: 0,
    totalCards: cards.length,
    cards: [...cards],
    plan: {
      dailyNewLimit: 20,
      dailyReviewLimit: 100,
      intervalsDays: [1, 2, 4, 7, 15, 30],
      timeZone: 'Asia/Shanghai',
    },
  };
}

/** 造一次作答结果（默认答对、无累计错次提示）。 */
export function makeAnswerResult(overrides: Partial<AnswerResult> = {}): AnswerResult {
  return {
    applied: true,
    isCorrect: true,
    correctAnswer: '放弃',
    cumulativeWrongCount: 0,
    showCumulativeWrongPrompt: false,
    nextDueAt: '2026-10-28T02:00:00.000Z',
    stage: 0,
    weight: 1,
    frequency: {
      importance: 'HIGH',
      frequency: 1200,
      rank: 800,
      totalTokens: 1000000,
      corpusVersion: '2026-10',
      sourceId: 'cet4',
    },
    ...overrides,
  };
}

/** 造一次会话汇总。 */
export function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 's-1',
    deckId: 'deck-cet4',
    startedAt: '2026-10-27T02:00:00.000Z',
    endedAt: '2026-10-27T02:05:00.000Z',
    localDate: '2026-10-27',
    timeZone: 'Asia/Shanghai',
    newCount: 1,
    reviewCount: 0,
    totalAnswers: 1,
    correctCount: 1,
    activeDurationMs: 125000,
    ...overrides,
  };
}

/** 造一份“样本不足”的评估（默认值：没有数据时不应显示分数）。 */
export function makeAssessment(overrides: Partial<AssessmentView> = {}): AssessmentView {
  return {
    deckId: 'deck-cet4',
    score: 0,
    level: 'INSUFFICIENT_SAMPLE',
    coverage: 0,
    confidence: 0,
    distinctWords: 0,
    validAnswers: 0,
    suggestions: ['先完成几轮学习，评估才有足够样本。'],
    algorithmVersion: 'test-v1',
    generatedAt: '2026-10-27T02:00:00.000Z',
    windowStart: '2026-07-29T02:00:00.000Z',
    windowEnd: '2026-10-27T02:00:00.000Z',
    ...overrides,
  };
}

/** 造一个词库摘要。 */
export function makeDeck(overrides: Partial<DeckSummary> = {}): DeckSummary {
  return {
    deckId: 'deck-cet4',
    name: '四级核心词',
    kind: 'BUILTIN',
    wordCount: 1200,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

/** 造一行当日统计。 */
export function makeDailyRow(overrides: Partial<DailyHistoryRow> = {}): DailyHistoryRow {
  return {
    localDate: '2026-10-27',
    total: 0,
    correct: 0,
    wrong: 0,
    activeMs: 0,
    accuracy: 0,
    ...overrides,
  };
}

/** 占位：被调用即说明页面越界使用了 6B 之外的服务。 */
function notUsed(name: string): never {
  throw new Error(`6B 页面不应调用 ${name}`);
}

/** 假服务可覆盖的方法（只列 6B 用到的四个服务）。 */
export interface FakeServiceOverrides {
  readonly settings?: Partial<Services['settings']>;
  readonly library?: Partial<Services['library']>;
  readonly study?: Partial<Services['study']>;
  readonly report?: Partial<Services['report']>;
  readonly content?: Partial<Services['content']>;
  readonly auth?: Partial<Services['auth']>;
  readonly sync?: Partial<Services['sync']>;
}

/**
 * 组装一套假服务。
 *
 * @param overrides 需要用例自定义的方法。
 * @returns 可直接传给 `ServiceProvider` 的服务全家桶。
 */
export function createFakeServices(overrides: FakeServiceOverrides = {}): Services {
  const settings: Services['settings'] = {
    getSnapshot: vi.fn(async () => defaultSettings),
    update: vi.fn(async (patch) => ({ ...defaultSettings, ...patch })),
    loadReviewPlan: vi.fn(async () => ({
      dailyNewLimit: defaultSettings.dailyNewLimit,
      dailyReviewLimit: defaultSettings.dailyReviewLimit,
      intervalsDays: defaultSettings.intervalsDays,
      timeZone: defaultSettings.timeZone,
    })),
    saveReviewPlan: vi.fn(async (plan) => plan),
    listStudyWindows: vi.fn(async () => []),
    replaceStudyWindows: vi.fn(async () => []),
    ...overrides.settings,
  };

  const library: Services['library'] = {
    listDecks: vi.fn(async () => [makeDeck()]),
    createDeck: vi.fn(async () => notUsed('library.createDeck')),
    renameDeck: vi.fn(async () => notUsed('library.renameDeck')),
    deleteDeck: vi.fn(async () => notUsed('library.deleteDeck')),
    listDeckWords: vi.fn(async () => []),
    addWordToNotebook: vi.fn(async () => undefined),
    removeWordFromNotebook: vi.fn(async () => undefined),
    isInNotebook: vi.fn(async () => false),
    createWord: vi.fn(async () => notUsed('library.createWord')),
    getFrequency: vi.fn(async () => notUsed('library.getFrequency')),
    ...overrides.library,
  };

  const study: Services['study'] = {
    startSession: vi.fn(async () => makeSession()),
    submitAnswer: vi.fn(async () => makeAnswerResult()),
    finishSession: vi.fn(async () => makeSummary()),
    suppressWord: vi.fn(async () => undefined),
    restoreWord: vi.fn(async () => undefined),
    ...overrides.study,
  };

  const report: Services['report'] = {
    getAssessment: vi.fn(async () => makeAssessment()),
    getDailyHistory: vi.fn(async () => []),
    listSessions: vi.fn(async () => []),
    getMistakes: vi.fn(async () => []),
    ...overrides.report,
  };

  const content: Services['content'] = {
    getWordContent: vi.fn(async () => notUsed('content.getWordContent')),
    getPronunciation: vi.fn(async ({ wordId, accent }) => ({
      wordId,
      accent,
      url: null,
      phoneticText: accent === 'uk' ? 'əˈbændən' : 'əˈbændən',
    })),
    ...overrides.content,
  };

  const auth: Services['auth'] = {
    requestOtp: vi.fn(async () => notUsed('auth.requestOtp')),
    verifyOtp: vi.fn(async () => notUsed('auth.verifyOtp')),
    getSession: vi.fn(async () => null),
    refresh: vi.fn(async () => notUsed('auth.refresh')),
    signOut: vi.fn(async () => notUsed('auth.signOut')),
    ...overrides.auth,
  };

  const sync: Services['sync'] = {
    // 缺省就是“云未配置”：这是本地优先应用在没有云端时的真实状态。
    synchronize: vi.fn(async () => ({
      startedAt: '2026-10-27T02:00:00.000Z',
      endedAt: '2026-10-27T02:00:00.000Z',
      pushed: 0,
      duplicates: 0,
      pulled: 0,
      applied: 0,
      conflicts: 0,
      errors: 0,
      status: 'NOT_CONFIGURED' as const,
      errorMessages: [],
    })),
    resolveConflict: vi.fn(async () => notUsed('sync.resolveConflict')),
    ...overrides.sync,
  };

  // 未使用的服务不做实现：被调用就抛错，能立刻暴露“页面偷偷用了 6B 之外的能力”。
  const unused = new Proxy(
    {},
    {
      get: (_target, property) => () => notUsed(`未接入服务 .${String(property)}`),
    },
  );

  return {
    settings,
    library,
    study,
    report,
    content,
    auth,
    sync,
    online: unused as unknown as Services['online'],
    association: unused as unknown as Services['association'],

    export: unused as unknown as Services['export'],
  };
}
