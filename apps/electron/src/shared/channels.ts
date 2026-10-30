/**
 * 主进程与 preload 共用的 IPC 频道白名单。
 *
 * 这个文件**只能有常量**：preload 会被打进沙箱，不能顺带把服务层、zod 或 node 内置模块
 * 拖进去。频道名写成 `域.动作`，主进程与 preload 都从这里取，避免两处字符串漂移。
 */
export const IPC_CHANNELS = [
  'study.startSession',
  'study.submitAnswer',
  'study.finishSession',
  'study.suppressWord',
  'study.restoreWord',
  'library.listDecks',
  'library.listDeckWords',
  'library.createDeck',
  'library.renameDeck',
  'library.deleteDeck',
  'library.addWordToNotebook',
  'library.removeWordFromNotebook',
  'library.isInNotebook',
  'library.updateWordSense',
  'library.replaceWordSenses',
  'library.collectWord',
  'library.setWordDistractors',
  'library.listWordDistractors',
  'import.importWords',
  'import.pickFile',
  'import.extractFile',
  'settings.getSnapshot',
  'settings.update',
  'settings.getDataLocation',
  'settings.pickDataFolder',
  'settings.changeDataLocation',
  'settings.relaunchApp',
  'settings.loadReviewPlan',
  'settings.saveReviewPlan',
  'settings.listStudyWindows',
  'report.getDailyHistory',
  'report.listSessions',
  'report.getMistakes',
  'report.getAssessment',
  'content.getPronunciation',
  'content.getWordContent',
  'auth.requestOtp',
  'auth.verifyOtp',
  'auth.getSession',
  'sync.synchronize',
  'sync.resolveConflict',
] as const;

/** 允许通过 IPC 调用的方法名。 */
export type IpcChannel = (typeof IPC_CHANNELS)[number];

/**
 * 判断一个字符串是否是白名单里的频道。
 *
 * @param channel 待检查的频道名（来自渲染进程，必须当作不可信输入）。
 * @returns 是否允许调用。
 */
export function isIpcChannel(channel: string): channel is IpcChannel {
  return (IPC_CHANNELS as readonly string[]).includes(channel);
}
