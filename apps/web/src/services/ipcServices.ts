/**
 * 桌面端服务适配器：把 renderer 里的 `Services` 调用翻译成 IPC。
 *
 * 为什么需要它：页面只认 `Services` 接口，Desktop 里的真实实现在主进程（SQLite + 9 个服务）。
 * renderer 拿不到 require，只能通过 preload 暴露的 `window.woyao.invoke` 走白名单频道。
 *
 * 频道名的权威清单在 `apps/electron/src/shared/channels.ts`；这里重复写字符串是刻意的：
 * 一旦两边漂移，主进程会返回 UNKNOWN_CHANNEL，测试与运行都会立刻炸，而不是静默调错方法。
 * 最后的结构断言用 `as unknown as Services`，是因为每个方法的返回类型都由主进程侧保证，
 * 逐方法重复写 `Awaited<ReturnType<...>>` 只会制造噪音。
 */
import type { Services } from '@woyao/services';

/** preload 暴露的桥。 */
export interface WoyaoBridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
}

/** 主进程返回的成功/失败结构。 */
type BridgeResult = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

/** 服务调用失败（保留主进程给的错误码）。 */
export class IpcCallError extends Error {
  readonly code: string;

  /**
   * @param code 主进程错误码（VALIDATION_FAILED / NOT_FOUND / INTERNAL …）。
   * @param message 面向用户的说明。
   */
  constructor(code: string, message: string) {
    super(message);
    this.name = 'IpcCallError';
    this.code = code;
  }
}

/** 未接通的能力：明确抛错，不返回假数据。 */
function notWired(feature: string): never {
  throw new IpcCallError('NOT_CONFIGURED', `${feature}尚未接入桌面端 IPC（后续任务）`);
}

/**
 * 调用一个 IPC 频道。
 *
 * @param bridge preload 桥。
 * @param channel 白名单频道。
 * @param payload 入参。
 * @returns 主进程返回的数据。
 */
async function call<T>(bridge: WoyaoBridge, channel: string, payload?: unknown): Promise<T> {
  const result = (await bridge.invoke(channel, payload)) as BridgeResult;
  if (result.ok) {
    return result.data as T;
  }
  throw new IpcCallError(result.error.code, result.error.message);
}

/**
 * 用 IPC 实现 `Services`。
 *
 * @param bridge preload 暴露的桥。
 * @returns 与网页版同构的服务对象。
 */
export function createIpcServices(bridge: WoyaoBridge): Services {
  const settings = {
    getSnapshot: () => call(bridge, 'settings.getSnapshot'),
    update: (patch: unknown) => call(bridge, 'settings.update', patch),
    loadReviewPlan: () => call(bridge, 'settings.loadReviewPlan'),
    saveReviewPlan: (plan: unknown) => call(bridge, 'settings.saveReviewPlan', plan),
    listStudyWindows: () => call(bridge, 'settings.listStudyWindows'),
    replaceStudyWindows: () => notWired('学习时段编辑'),
  };

  const library = {
    listDecks: () => call(bridge, 'library.listDecks'),
    listDeckWords: (input: unknown) => call(bridge, 'library.listDeckWords', input),
    createDeck: (input: unknown) => call(bridge, 'library.createDeck', input),
    renameDeck: (input: unknown) => call(bridge, 'library.renameDeck', input),
    deleteDeck: (deckId: string) => call(bridge, 'library.deleteDeck', { deckId }),
    addWordToNotebook: (wordId: string) => call(bridge, 'library.addWordToNotebook', { wordId }),
    removeWordFromNotebook: (wordId: string) => call(bridge, 'library.removeWordFromNotebook', { wordId }),
    isInNotebook: (wordId: string) => call(bridge, 'library.isInNotebook', { wordId }),
    createWord: () => notWired('自建词'),
    getFrequency: () => notWired('词频查询'),
  };

  const importService = {
    importWords: (input: unknown) => call(bridge, 'import.importWords', input),
  };

  const study = {
    startSession: (input: unknown) => call(bridge, 'study.startSession', input),
    submitAnswer: (input: unknown) => call(bridge, 'study.submitAnswer', input),
    finishSession: (input: unknown) => call(bridge, 'study.finishSession', input),
    suppressWord: (input: unknown) => call(bridge, 'study.suppressWord', input),
    restoreWord: (input: unknown) => call(bridge, 'study.restoreWord', input),
  };

  const report = {
    getAssessment: (input: unknown) => call(bridge, 'report.getAssessment', input),
    getDailyHistory: (input: unknown) => call(bridge, 'report.getDailyHistory', input),
    listSessions: (input: unknown) => call(bridge, 'report.listSessions', input),
    getMistakes: (input: unknown) => call(bridge, 'report.getMistakes', input),
  };

  const content = {
    getWordContent: (input: unknown) => call(bridge, 'content.getWordContent', input),
    getPronunciation: (input: unknown) => call(bridge, 'content.getPronunciation', input),
  };

  const auth = {
    requestOtp: (input: unknown) => call(bridge, 'auth.requestOtp', input),
    verifyOtp: (input: unknown) => call(bridge, 'auth.verifyOtp', input),
    getSession: () => call(bridge, 'auth.getSession'),
    refresh: () => notWired('登录续期'),
    signOut: () => notWired('退出登录'),
  };

  const sync = {
    synchronize: () => call(bridge, 'sync.synchronize'),
    resolveConflict: (input: unknown) => call(bridge, 'sync.resolveConflict', input),
  };

  const online = new Proxy(
    {},
    {
      get: () => () => notWired('在线词典'),
    },
  );
  const association = new Proxy(
    {},
    {
      get: () => () => notWired('图词联想'),
    },
  );
  const exporter = new Proxy(
    {},
    {
      get: () => () => notWired('导出'),
    },
  );

  return {
    settings,
    library,
    import: importService,
    study,
    report,
    content,
    auth,
    sync,
    online,
    association,
    export: exporter,
  } as unknown as Services;
}
