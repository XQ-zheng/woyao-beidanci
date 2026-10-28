/**
 * 图片 OCR：本地 Tesseract.js 识别为主，可注入云端增强回调。
 *
 * 分层：本包只负责「把图片变成英文文本」。本地识别用 tesseract.js（wasm，
 * 无需系统安装 Tesseract 二进制）；「云端增强」通过注入的回调实现（由主进程
 * 决定要不要调云 LLM、怎么调），本包不直接依赖云 SDK，保持可测试。
 */
import { readFile } from 'node:fs/promises';

import { createWorker } from 'tesseract.js';

/** OCR 结果：识别出的原始英文文本。 */
export interface OcrResult {
  /** 本地 Tesseract 识别出的文本。 */
  readonly localText: string;
  /** 云端增强识别出的文本（未注入增强时为 null）。 */
  readonly enhancedText: string | null;
}

/** 云端增强回调：传入图片路径，返回更准确的英文文本（或 null 表示不用/失败）。 */
export type OcrEnhancer = (imagePath: string) => Promise<string | null>;

/** OCR 选项。 */
export interface OcrOptions {
  /** 云端增强回调；不传则只做本地识别。 */
  readonly enhancer?: OcrEnhancer;
  /** 识别语言，默认 `eng`。 */
  readonly lang?: string;
  /**
   * 语言包目录（含 `eng.traineddata`）。传本地路径即可离线识别；
   * 不传时 tesseract.js 会尝试从 CDN 下载（离线环境会失败）。
   */
  readonly langPath?: string;
}

/** tesseract.js worker 单例缓存（创建 worker 较贵，进程内复用）。 */
let workerPromise: ReturnType<typeof createWorker> | null = null;
let workerLang = '';
let workerLangPath = '';

/** 拿一个已加载英文语言包的 worker；语言或 langPath 变了就重建。 */
function getWorker(lang: string, langPath: string): ReturnType<typeof createWorker> {
  if (workerPromise === null || workerLang !== lang || workerLangPath !== langPath) {
    workerLang = lang;
    workerLangPath = langPath;
    workerPromise = createWorker(lang, 1, {
      logger: () => undefined, // 静默进度日志
      ...(langPath === '' ? {} : { langPath }),
    });
  }
  return workerPromise;
}

/**
 * 识别一张图片里的英文文本。
 *
 * 本地 Tesseract 先识别；若注入了增强回调，则再走一次增强识别，
 * 二者都成功时取增强结果（通常更准），否则退回本地结果。
 *
 * @param imagePath 图片绝对路径（png/jpg 等）。
 * @param options 选项。
 * @returns OCR 结果。
 */
export async function ocrImage(imagePath: string, options: OcrOptions = {}): Promise<OcrResult> {
  const lang = options.lang ?? 'eng';
  const langPath = options.langPath ?? '';
  const buffer = await readFile(imagePath);
  const worker = await getWorker(lang, langPath);
  const recognized = await worker.recognize(buffer);
  const localText = recognized.data.text ?? '';

  if (options.enhancer === undefined) {
    return { localText, enhancedText: null };
  }
  const enhancedText = await options.enhancer(imagePath);
  return { localText, enhancedText };
}

/** 取 OCR 的最终文本：增强结果优先，否则本地结果。 */
export function ocrBestText(result: OcrResult): string {
  return result.enhancedText !== null && result.enhancedText.trim().length > 0
    ? result.enhancedText
    : result.localText;
}
