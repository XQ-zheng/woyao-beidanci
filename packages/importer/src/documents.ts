/**
 * 从各种文档格式提取文本，交给 `extractEnglishTerms` 挑单词。
 *
 * 支持：`.xlsx`/`.xls`（ExcelJS）、`.docx`（jszip 解 XML）、`.pptx`（jszip 解 XML）、
 * `.pdf`（pdfjs-dist 抽文本）、`.txt`/`.md`（直接读）。返回原始文本；单词筛选在
 * 上一层统一做，这里只负责「把文件变成文字」。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import ExcelJS from 'exceljs';
import JSZip from 'jszip';

/** 从 `.xlsx` / `.xls` 提取所有单元格文本。 */
async function extractXlsx(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  // exceljs 的 load 标注为 Buffer，但 @types/node 各版本的 Buffer 泛型默认值不一致，
  // readFile 返回的 Buffer<ArrayBufferLike> 会在这里报类型不匹配；运行时完全兼容，
  // 用 unknown 中转一次绕过这层版本漂移。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await workbook.xlsx.load(buffer as unknown as any);
  const parts: string[] = [];
  for (const worksheet of workbook.worksheets) {
    worksheet.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell((cell) => {
        const value: unknown = cell.value;
        if (value === null || value === undefined) {
          return;
        }
        if (value instanceof Date) {
          return;
        }
        if (typeof value === 'object') {
          const obj = value as { text?: string; result?: unknown; richText?: unknown };
          if (typeof obj.text === 'string') {
            cells.push(obj.text);
          } else if (typeof obj.result === 'string') {
            cells.push(obj.result);
          }
          return;
        }
        cells.push(String(value));
      });
      const line = cells.join(' ');
      if (line.trim().length > 0) {
        parts.push(line);
      }
    });
  }
  return parts.join('\n');
}

/** 从 zip 里读第一个符合的 XML，抽其中的 `<a:t>` / `<w:t>` 文本节点。 */
async function extractZipXmlText(zip: JSZip, xmlPattern: RegExp): Promise<string> {
  const names = Object.keys(zip.files).filter((name) => xmlPattern.test(name));
  const parts: string[] = [];
  for (const name of names) {
    const xml = await zip.file(name)?.async('string');
    if (xml === undefined) {
      continue;
    }
    // docx/pptx 的文本都在 <w:t> 或 <a:t> 里
    for (const match of xml.matchAll(/<(?:w|a):t(?: [^>]*)?>([^<]*)<\/(?:w|a):t>/gu)) {
      if (match[1].trim().length > 0) {
        parts.push(match[1]);
      }
    }
  }
  return parts.join('\n');
}

/** 从 `.docx` 提取文本。 */
async function extractDocx(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  return extractZipXmlText(zip, /^word\/document.*\.xml$/u);
}

/** 从 `.pptx` 提取文本。 */
async function extractPptx(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  return extractZipXmlText(zip, /^ppt\/slides\/slide\d+\.xml$/u);
}

/** 从 `.pdf` 提取文本。 */
async function extractPdf(buffer: Buffer): Promise<string> {
  // 动态导入：pdfjs-dist 在模块加载阶段就会尝试初始化 canvas polyfill
  // （缺 @napi-rs/canvas 时在 Node 里告警甚至卡住）。只在真正提取 PDF 时才加载，
  // 避免「应用一启动主进程就被 pdfjs 拖死」。
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({ data: new Uint8Array(buffer) }).promise;
  const parts: string[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    parts.push(
      content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' '),
    );
  }
  return parts.join('\n');
}

/** 支持的文件扩展名。 */
export type SupportedDocumentExt = 'xlsx' | 'xls' | 'docx' | 'pptx' | 'pdf' | 'txt' | 'md';

/**
 * 从文档文件提取原始文本。
 *
 * @param filePath 文件绝对路径。
 * @param ext 文件扩展名（决定解析方式）。
 * @returns 提取出的原始文本。
 */
export async function extractDocumentText(filePath: string, ext: SupportedDocumentExt): Promise<string> {
  const buffer = await readFile(filePath);
  switch (ext) {
    case 'xlsx':
    case 'xls':
      return extractXlsx(buffer);
    case 'docx':
      return extractDocx(buffer);
    case 'pptx':
      return extractPptx(buffer);
    case 'pdf':
      return extractPdf(buffer);
    case 'txt':
    case 'md':
      return buffer.toString('utf8');
    default:
      throw new Error(`不支持的文档格式：${String(ext)}`);
  }
}

/** 由文件名猜扩展名（小写）。 */
export function extensionOf(filePath: string): SupportedDocumentExt | null {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./u, '');
  const supported: readonly SupportedDocumentExt[] = ['xlsx', 'xls', 'docx', 'pptx', 'pdf', 'txt', 'md'];
  return supported.includes(ext as SupportedDocumentExt) ? (ext as SupportedDocumentExt) : null;
}
