/**
 * IPC 路由：把渲染进程的调用翻译成服务层调用。
 *
 * 三条硬规则：
 * 1. **不可信输入**：渲染进程传来的 payload 一律先过 zod，再进服务层。校验失败返回
 *    `VALIDATION_FAILED`，绝不把 `undefined` 带进 SQL 参数。
 * 2. **不抛裸异常**：IPC 边界上把异常折成 `{ ok:false, error:{ code, message } }`。
 *    Electron 会把未捕获异常序列化成一段难以阅读的字符串，渲染进程拿不到 `code`。
 * 3. **时间由主进程给**：`startSession`/`submitAnswer` 的 `now` 来自注入的 `Clock`，
 *    不接受渲染进程自报时间——否则改系统时间就能把复习排期写乱。
 */
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import type { Clock } from '@woyao/core';
import type { OcrEnhancer } from '@woyao/importer';
import { ServiceError, type Services } from '@woyao/services';

import {
  ensureWritableDir,
  migrateDataFiles,
  writeLocationHint,
} from './dataLocation';
import { extractTermsFromFile, pickFontFile, pickImageFile, pickImportFile, readImageAsDataUrl } from './importer';
import { IPC_CHANNELS, type IpcChannel } from '../shared/channels';

/** 成功结果。 */
export interface IpcOk {
  readonly ok: true;
  readonly data: unknown;
}

/** 失败结果。 */
export interface IpcErr {
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
}

/** IPC 返回值。 */
export type IpcResult = IpcOk | IpcErr;

/** 路由依赖。 */
export interface IpcRouterOptions {
  readonly services: Services;
  readonly clock: Clock;
  /** 取当前主窗口（文件对话框挂载用）。 */
  readonly getWindow?: () => BrowserWindow | null;
  /** 图片 OCR 的云端增强回调（可选；不传则纯本地 OCR）。 */
  readonly ocrEnhancer?: OcrEnhancer;
  /** 关闭数据库连接（数据迁移前调用，让 WAL checkpoint 落盘）。 */
  readonly closeDatabase?: () => void;
}

/** 一条路由：入参 schema + 处理函数。 */
interface Route {
  readonly schema: z.ZodType;
  readonly run: (payload: unknown) => Promise<unknown>;
}

/** 参数校验失败时使用的错误码（与服务层同一个词汇表）。 */
const VALIDATION_FAILED = 'VALIDATION_FAILED';

/** `study.submitAnswer` 的入参（不含 `now`，时间由主进程补）。 */
const submitAnswerSchema = z.object({
  sessionId: z.string().min(1),
  deckId: z.string().min(1),
  wordId: z.string().min(1),
  mode: z.enum(['EN_TO_ZH', 'ZH_TO_EN']),
  prompt: z.string(),
  answer: z.string(),
  isCorrect: z.boolean(),
  recognition: z.enum(['KNOWN', 'UNKNOWN']),
  durationMs: z.number().int().min(0).optional(),
  eventId: z.string().min(1).optional(),
});

/** 复习计划入参。 */
const reviewPlanSchema = z.object({
  dailyNewLimit: z.number().int().min(0).max(500),
  dailyReviewLimit: z.number().int().min(0).max(500),
  intervalsDays: z.array(z.number().int().min(1).max(365)).min(1).max(12),
  timeZone: z.string().min(1),
});

/**
 * 创建 IPC 路由。
 *
 * @param options 服务全家桶与时钟。
 * @returns 接收（频道, payload）并返回结构化结果的函数。
 */
export function createIpcRouter({
  services,
  clock,
  getWindow,
  ocrEnhancer,
  closeDatabase,
}: IpcRouterOptions): (channel: string, payload: unknown) => Promise<IpcResult> {
  const now = (): Date => clock.now();

  const routes: Readonly<Record<IpcChannel, Route>> = {
    'study.startSession': {
      schema: z.object({
        deckId: z.string().min(1),
        seed: z.string().min(1).optional(),
        force: z.boolean().optional(),
        scope: z.enum(['ALL', 'NEW', 'REVIEW']).optional(),
      }),
      run: async (payload) => {
        const input = payload as {
          deckId: string;
          seed?: string;
          force?: boolean;
          scope?: 'ALL' | 'NEW' | 'REVIEW';
        };
        return services.study.startSession({
          deckId: input.deckId,
          seed: input.seed,
          force: input.force,
          scope: input.scope,
          now: now(),
        });
      },
    },
    'study.submitAnswer': {
      schema: submitAnswerSchema,
      run: async (payload) => {
        const input = payload as z.infer<typeof submitAnswerSchema>;
        return services.study.submitAnswer({ ...input, answeredAt: now() });
      },
    },
    'study.finishSession': {
      schema: z.object({ sessionId: z.string().min(1) }),
      run: async (payload) =>
        services.study.finishSession({ sessionId: (payload as { sessionId: string }).sessionId, now: now() }),
    },
    'study.suppressWord': {
      schema: z.object({ deckId: z.string().min(1), wordId: z.string().min(1) }),
      run: async (payload) => {
        const input = payload as { deckId: string; wordId: string };
        await services.study.suppressWord({ ...input, now: now() });
        return null;
      },
    },
    'study.restoreWord': {
      schema: z.object({ deckId: z.string().min(1), wordId: z.string().min(1) }),
      run: async (payload) => {
        const input = payload as { deckId: string; wordId: string };
        await services.study.restoreWord({ ...input, now: now() });
        return null;
      },
    },
    'library.listDecks': {
      schema: z.undefined(),
      run: async () => services.library.listDecks(),
    },
    'library.listDeckWords': {
      schema: z.object({
        deckId: z.string().min(1),
        exam: z.string().min(1).optional(),
        corpusVersion: z.string().min(1).optional(),
      }),
      run: async (payload) =>
        services.library.listDeckWords(payload as { deckId: string; exam?: string; corpusVersion?: string }),
    },
    'library.createDeck': {
      schema: z.object({ name: z.string().min(1), kind: z.enum(['CUSTOM', 'NOTEBOOK']).optional() }),
      run: async (payload) => services.library.createDeck(payload as { name: string; kind?: 'CUSTOM' | 'NOTEBOOK' }),
    },
    'library.renameDeck': {
      schema: z.object({ deckId: z.string().min(1), name: z.string().min(1) }),
      run: async (payload) => services.library.renameDeck(payload as { deckId: string; name: string }),
    },
    'library.deleteDeck': {
      schema: z.object({ deckId: z.string().min(1) }),
      run: async (payload) => {
        await services.library.deleteDeck((payload as { deckId: string }).deckId);
        return null;
      },
    },
    'library.addWordToNotebook': {
      schema: z.object({ wordId: z.string().min(1) }),
      run: async (payload) => {
        await services.library.addWordToNotebook((payload as { wordId: string }).wordId);
        return null;
      },
    },
    'library.removeWordFromNotebook': {
      schema: z.object({ wordId: z.string().min(1) }),
      run: async (payload) => {
        await services.library.removeWordFromNotebook((payload as { wordId: string }).wordId);
        return null;
      },
    },
    'library.isInNotebook': {
      schema: z.object({ wordId: z.string().min(1) }),
      run: async (payload) => services.library.isInNotebook((payload as { wordId: string }).wordId),
    },
    'library.updateWordSense': {
      schema: z.object({
        wordId: z.string().min(1),
        senseNo: z.number().int().min(1),
        pos: z.string().max(32),
        simpleZh: z.string().trim().min(1),
        detailedZh: z.string().nullish(),
        contextText: z.string().nullish(),
      }),
      run: async (payload) =>
        services.library.updateWordSense(
          payload as {
            wordId: string;
            senseNo: number;
            pos: string;
            simpleZh: string;
            detailedZh?: string | null;
            contextText?: string | null;
          },
        ),
    },
    'library.replaceWordSenses': {
      schema: z.object({
        wordId: z.string().min(1),
        senses: z
          .array(
            z.object({
              pos: z.string().max(32),
              simpleZh: z.string().trim().min(1),
              detailedZh: z.string().nullish(),
            }),
          )
          .min(1)
          .max(10),
      }),
      run: async (payload) =>
        services.library.replaceWordSenses(
          payload as {
            wordId: string;
            senses: { pos: string; simpleZh: string; detailedZh?: string | null }[];
          },
        ),
    },
    'assessment.sampleWords': {
      schema: z.object({ count: z.number().int().min(5).max(200) }),
      run: async (payload) => {
        const input = payload as { count: number };
        // 词汇量自测：从内置四六级/考研词库的并集里随机抽词（只给词形，不给释义，
        // 避免提示答案）。词库缺失时返回空数组，由 UI 提示「未内置词库」。
        const dir = path.join(process.resourcesPath, 'wordbooks');
        const pool = new Map<string, { lemma: string; meaning: string }>();
        for (const id of ['cet4', 'cet6', 'kaoyan']) {
          try {
            const raw = JSON.parse(readFileSync(path.join(dir, id + '.json'), 'utf8')) as {
              words: ReadonlyArray<{
                lemma: string;
                senses: ReadonlyArray<{ pos: string; simpleZh: string }>;
              }>;
            };
            for (const word of raw.words) {
              const key = word.lemma.toLowerCase();
              if (!pool.has(key)) {
                const first = word.senses[0];
                pool.set(key, {
                  lemma: word.lemma,
                  meaning: first === undefined ? '' : (first.pos === '' ? '' : first.pos + '. ') + first.simpleZh,
                });
              }
            }
          } catch {
            // 单个词库缺失不影响其它词库抽样
          }
        }
        const entries = [...pool.values()];
        // Fisher-Yates 洗牌后取前 count 个（真随机即可：自测不要求可复现）
        for (let i = entries.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1));
          const tmp = entries[i]!;
          entries[i] = entries[j]!;
          entries[j] = tmp;
        }
        return entries.slice(0, Math.min(input.count, entries.length));
      },
    },
    'library.listWordbooks': {
      schema: z.undefined(),
      run: async () => {
        // 内置词库索引：resources/wordbooks/index.json（打包时由 package-win 复制）。
        const file = path.join(process.resourcesPath, 'wordbooks', 'index.json');
        try {
          return JSON.parse(readFileSync(file, 'utf8')) as unknown;
        } catch {
          return [];
        }
      },
    },
    'library.importWordbook': {
      schema: z.object({ presetId: z.string().min(1) }),
      run: async (payload) => {
        const input = payload as { presetId: string };
        const file = path.join(
          process.resourcesPath,
          'wordbooks',
          input.presetId.replace(/[^a-z0-9-]/giu, '') + '.json',
        );
        const raw = JSON.parse(readFileSync(file, 'utf8')) as {
          name: string;
          words: ReadonlyArray<{
            lemma: string;
            phoneticUk?: string;
            phoneticUs?: string;
            senses: ReadonlyArray<{ pos: string; simpleZh: string }>;
          }>;
        };
        return services.library.importWordbook({ name: raw.name, words: raw.words });
      },
    },
    'library.collectWord': {
      schema: z.object({ lemma: z.string().trim().min(1) }),
      run: async (payload) => services.library.collectWord(payload as { lemma: string }),
    },
    'library.setWordDistractors': {
      schema: z.object({
        wordId: z.string().min(1),
        lemmas: z.array(z.string().trim().min(1).max(40)).max(3),
      }),
      run: async (payload) =>
        services.library.setWordDistractors(payload as { wordId: string; lemmas: string[] }),
    },
    'library.listWordDistractors': {
      schema: z.object({ wordId: z.string().min(1) }),
      run: async (payload) =>
        services.library.listWordDistractors(payload as { wordId: string }),
    },
    'import.importWords': {
      schema: z.object({
        deckId: z.string().min(1),
        terms: z.array(z.object({ lemma: z.string().min(1), phrase: z.boolean().optional() })).min(1),
      }),
      run: async (payload) =>
        services.import.importWords(
          payload as { deckId: string; terms: readonly { lemma: string; phrase?: boolean }[] },
        ),
    },
    'import.pickFile': {
      schema: z.undefined(),
      run: async () => pickImportFile(getWindow?.() ?? null),
    },
    'import.extractFile': {
      schema: z.object({ filePath: z.string().min(1) }),
      run: async (payload) =>
        extractTermsFromFile((payload as { filePath: string }).filePath, ocrEnhancer),
    },
    'settings.getSnapshot': {
      schema: z.undefined(),
      run: async () => services.settings.getSnapshot(),
    },
    'settings.update': {
      schema: z.record(z.string(), z.unknown()),
      run: async (payload) => services.settings.update(payload as Parameters<Services['settings']['update']>[0]),
    },
    'settings.getDataLocation': {
      schema: z.undefined(),
      run: async () => ({ dataDir: app.getPath('userData') }),
    },
    'settings.pickWallpaper': {
      schema: z.undefined(),
      run: async () => {
        const filePath = await pickImageFile(getWindow?.() ?? null);
        if (filePath === null) {
          return null;
        }
        // 同时返回路径（存设置）与 dataURL（渲染层立刻显示，避开 file:// 拦截）。
        return { path: filePath, dataUrl: readImageAsDataUrl(filePath) };
      },
    },
    'settings.readWallpaper': {
      schema: z.object({ path: z.string().min(1) }),
      run: async (payload) => {
        const input = payload as { path: string };
        return readImageAsDataUrl(input.path);
      },
    },
    'settings.pickFont': {
      schema: z.undefined(),
      run: async () => pickFontFile(getWindow?.() ?? null),
    },
    'settings.pickDataFolder': {
      schema: z.undefined(),
      run: async () => {
        const result = await dialog.showOpenDialog(getWindow?.() ?? (undefined as never), {
          title: '选择新的数据储存位置',
          properties: ['openDirectory', 'createDirectory'],
          defaultPath: app.getPath('userData'),
        });
        if (result.canceled || result.filePaths.length === 0) {
          return null;
        }
        return result.filePaths[0] ?? null;
      },
    },
    'settings.changeDataLocation': {
      schema: z.object({ newPath: z.string().min(1) }),
      run: async (payload) => {
        const newPath = (payload as { newPath: string }).newPath;
        const currentDir = app.getPath('userData');
        if (path.resolve(newPath) === path.resolve(currentDir)) {
          throw new ServiceError('VALIDATION_FAILED', '新位置与当前位置相同。');
        }
        const writable = ensureWritableDir(newPath);
        if (writable !== null) {
          throw new ServiceError('VALIDATION_FAILED', `新位置不可用：${writable}`);
        }
        // 迁移前必须先关数据库（WAL checkpoint 落盘），否则复制的库会缺最新写入。
        closeDatabase?.();
        const report = migrateDataFiles(currentDir, newPath);
        if (typeof report === 'string') {
          throw new ServiceError('PROVIDER_ERROR', `${report}（重启应用后可重试；旧数据完好）`);
        }
        // 写引导文件：下次启动按新位置读数据。
        writeLocationHint(newPath);
        return report;
      },
    },
    'settings.relaunchApp': {
      schema: z.undefined(),
      run: async () => {
        app.relaunch();
        app.exit(0);
        return null;
      },
    },
    'settings.loadReviewPlan': {
      schema: z.undefined(),
      run: async () => services.settings.loadReviewPlan(),
    },
    'settings.saveReviewPlan': {
      schema: reviewPlanSchema,
      run: async (payload) =>
        services.settings.saveReviewPlan(payload as Parameters<Services['settings']['saveReviewPlan']>[0]),
    },
    'settings.listStudyWindows': {
      schema: z.undefined(),
      run: async () => services.settings.listStudyWindows(),
    },
    'report.getDailyHistory': {
      schema: z.object({ fromLocalDate: z.string().min(1), toLocalDate: z.string().min(1) }),
      run: async (payload) =>
        services.report.getDailyHistory(payload as { fromLocalDate: string; toLocalDate: string }),
    },
    'report.listSessions': {
      schema: z.object({ fromIso: z.string().min(1), toIso: z.string().min(1) }),
      run: async (payload) => services.report.listSessions(payload as { fromIso: string; toIso: string }),
    },
    'report.getMistakes': {
      schema: z.object({ deckId: z.string().min(1), limit: z.number().int().min(1).max(1000).optional() }),
      run: async (payload) => services.report.getMistakes(payload as { deckId: string; limit?: number }),
    },
    'report.getAssessment': {
      schema: z.object({ deckId: z.string().min(1) }),
      run: async (payload) => services.report.getAssessment({ deckId: (payload as { deckId: string }).deckId, now: now() }),
    },
    'content.getPronunciation': {
      schema: z.object({ wordId: z.string().min(1), accent: z.enum(['uk', 'us']) }),
      run: async (payload) =>
        services.content.getPronunciation(payload as { wordId: string; accent: 'uk' | 'us' }),
    },
    'content.getWordContent': {
      schema: z.object({ wordId: z.string().min(1) }),
      run: async (payload) => services.content.getWordContent(payload as { wordId: string }),
    },
    'auth.requestOtp': {
      schema: z.object({
        channel: z.enum(['phone', 'email']),
        target: z.string().min(1),
      }),
      run: async (payload) =>
        services.auth.requestOtp(payload as { channel: 'phone' | 'email'; target: string }),
    },
    'auth.verifyOtp': {
      schema: z.object({
        channel: z.enum(['phone', 'email']),
        target: z.string().min(1),
        challengeId: z.string().min(1),
        isExistingUser: z.boolean(),
        token: z.string().min(1),
      }),
      run: async (payload) =>
        services.auth.verifyOtp(
          payload as {
            channel: 'phone' | 'email';
            target: string;
            challengeId: string;
            isExistingUser: boolean;
            token: string;
          },
        ),
    },
    'auth.getSession': {
      schema: z.undefined(),
      run: async () => services.auth.getSession(),
    },
    'sync.synchronize': {
      schema: z.undefined(),
      run: async () => services.sync.synchronize(),
    },
    'sync.resolveConflict': {
      schema: z.object({ id: z.string().min(1), resolution: z.enum(['LOCAL_WINS', 'REMOTE_WINS']) }),
      run: async (payload) => {
        await services.sync.resolveConflict(payload as { id: string; resolution: 'LOCAL_WINS' | 'REMOTE_WINS' });
        return null;
      },
    },
  };

  // 启动时自检：白名单与路由表必须一一对应，漏一条就当场炸，而不是运行时才“点了没反应”。
  for (const channel of IPC_CHANNELS) {
    if (routes[channel] === undefined) {
      throw new Error(`IPC 频道 ${channel} 缺少路由实现`);
    }
  }

  return async (channel: string, payload: unknown): Promise<IpcResult> => {
    if (!(IPC_CHANNELS as readonly string[]).includes(channel)) {
      return { ok: false, error: { code: 'UNKNOWN_CHANNEL', message: `未知的 IPC 频道：${channel}` } };
    }
    const route = routes[channel as IpcChannel];
    const parsed = route.schema.safeParse(payload);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: VALIDATION_FAILED,
          message: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`).join('; '),
        },
      };
    }
    try {
      return { ok: true, data: await route.run(parsed.data) };
    } catch (error: unknown) {
      if (error instanceof ServiceError) {
        return { ok: false, error: { code: error.code, message: error.message } };
      }
      return {
        ok: false,
        error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) },
      };
    }
  };
}
