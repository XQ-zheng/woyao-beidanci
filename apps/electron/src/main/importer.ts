/**
 * 主进程侧的导入接线：文件选择对话框 + 文件内容提取。
 *
 * 提取放在主进程（而非渲染进程），因为：
 * 1. 文档解析库（exceljs / jszip / pdfjs）与 OCR（tesseract.js）都是 Node 侧依赖，
 *    不能打进渲染进程的浏览器包（否则又会重蹈 better-sqlite3 的白屏覆辙）；
 * 2. 文件读取需要文件系统权限，本就在主进程的安全边界内。
 *
 * 渲染进程只拿到「去重后的英文单词/短语列表」，再走 `import.importWords` 落库。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { dialog, type BrowserWindow } from 'electron';

import {
  extractDocumentText,
  extractWords,
  extensionOf,
  ocrBestText,
  ocrImage,
  type ExtractedTerm,
  type OcrEnhancer,
} from '@woyao/importer';

/** 图片文件扩展名（走 OCR）。 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp']);

/** 可选的文档与图片过滤器。 */
const FILE_FILTERS = [
  {
    name: '图片（OCR 识别英文）',
    extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'],
  },
  {
    name: '文档（Excel/Word/PDF/PPT/文本）',
    extensions: ['xlsx', 'xls', 'docx', 'pptx', 'pdf', 'txt', 'md'],
  },
  { name: '所有文件', extensions: ['*'] },
];

/** 提取文件的入口参数。 */
export interface ExtractFileInput {
  readonly filePath: string;
}

/** 提取文件的结果。 */
export interface ExtractFileResult {
  readonly terms: readonly ExtractedTerm[];
  /** 提取方式（文档 / 图片 OCR），用于 UI 提示。 */
  readonly via: 'document' | 'ocr';
  /** OCR 时是否用了云端增强。 */
  readonly enhanced?: boolean;
}

/** 弹出文件选择对话框；取消时返回 null。 */
export async function pickImportFile(window: BrowserWindow | null): Promise<string | null> {
  const result = await dialog.showOpenDialog(window ?? (undefined as never), {
    title: '选择要导入的文件（图片或文档）',
    properties: ['openFile'],
    filters: FILE_FILTERS,
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0] ?? null;
}

/** 弹出图片选择对话框（壁纸用）；取消返回 null。 */
export async function pickImageFile(window: BrowserWindow | null): Promise<string | null> {
  const result = await dialog.showOpenDialog(window ?? (undefined as never), {
    title: '选择壁纸图片',
    properties: ['openFile'],
    filters: [
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0] ?? null;
}

/**
 * 定位 OCR 语言包目录（含 `eng.traineddata`）。
 *
 * 打包态在 `resources/tessdata`，开发态读仓库里的 `packages/importer/assets/tessdata`。
 * 找不到时返回 null（此时 OCR 走 tesseract 默认的 CDN 下载，离线会失败）。
 *
 * @returns tessdata 目录绝对路径，或 null。
 */
function resolveTessdataPath(): string | null {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'tessdata'),
    path.join(__dirname, '../../../../packages/importer/assets/tessdata'),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'eng.traineddata.gz'))) {
      return candidate;
    }
  }
  return null;
}

/**
 * 从文件提取英文单词/短语。
 *
 * 文档（xlsx/docx/pptx/pdf/txt/md）走本地解析；图片走 OCR（可注入云端增强）。
 *
 * @param filePath 文件绝对路径。
 * @param enhancer 图片 OCR 的云端增强回调（可选）。
 * @returns 提取结果。
 */
export async function extractTermsFromFile(
  filePath: string,
  enhancer?: OcrEnhancer,
): Promise<ExtractFileResult> {
  const ext = extensionOf(filePath);
  if (ext === null) {
    throw new Error('不支持的文件格式');
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    const langPath = resolveTessdataPath();
    const ocr = await ocrImage(filePath, {
      enhancer,
      ...(langPath === null ? {} : { langPath }),
    });
    const text = ocrBestText(ocr);
    return {
      terms: extractWords(text),
      via: 'ocr',
      enhanced: ocr.enhancedText !== null && ocr.enhancedText.trim().length > 0,
    };
  }
  const text = await extractDocumentText(filePath, ext);
  return { terms: extractWords(text), via: 'document' };
}
