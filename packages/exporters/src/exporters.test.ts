import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import ExcelJS from 'exceljs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';

import { exportToDocx } from './docxExporter';
import { exportToPdf } from './pdfExporter';
import { exportToXlsx } from './xlsxExporter';
import { createDocumentWriter } from './index';
import type { ExportModel } from './exportModel';

const fontPath = fileURLToPath(new URL('../fonts/NotoSansSC-Variable.ttf', import.meta.url));
const temp = mkdtempSync(path.join(tmpdir(), 'woyao-export-'));

/** 读取 ZIP 内所有文本文件（docx/xlsx 都是 ZIP；不依赖联网或外部命令）。 */
function readZipTexts(file: string): Record<string, string> {
  const data = readFileSync(file);
  let eocd = -1;
  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 66000); offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = data.readUInt16LE(eocd + 10);
  let central = data.readUInt32LE(eocd + 16);
  const result: Record<string, string> = {};

  for (let index = 0; index < count; index += 1) {
    expect(data.readUInt32LE(central)).toBe(0x02014b50);
    const method = data.readUInt16LE(central + 10);
    const compressedSize = data.readUInt32LE(central + 20);
    const nameLength = data.readUInt16LE(central + 28);
    const extraLength = data.readUInt16LE(central + 30);
    const commentLength = data.readUInt16LE(central + 32);
    const local = data.readUInt32LE(central + 42);
    const name = data.subarray(central + 46, central + 46 + nameLength).toString('utf8');

    const localNameLength = data.readUInt16LE(local + 26);
    const localExtraLength = data.readUInt16LE(local + 28);
    const start = local + 30 + localNameLength + localExtraLength;
    const compressed = data.subarray(start, start + compressedSize);
    result[name] =
      method === 0
        ? compressed.toString('utf8')
        : inflateRawSync(compressed).toString('utf8');

    central += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

/** 小模型：同时含中文、英文、多义项长文与公式样文本。 */
function makeModel(rowCount = 3): ExportModel {
  const rows: string[][] = [];
  for (let index = 0; index < rowCount; index += 1) {
    rows.push([
      `abandon-${index}`,
      '1',
      'v.',
      '放弃；抛弃',
      '详细释义：不再坚持某件事。' + '这是一段用于验证中文自动换行的长文本。'.repeat(4),
      'He abandoned the plan. ' + 'A long English sentence should wrap inside the table cell. '.repeat(3),
      "'=SUM(A1:A2)",
      "'+not-a-formula",
    ]);
  }
  return {
    kind: 'DECK',
    generatedAt: '2026-10-27T10:00:00.000Z',
    title: '四级核心词（中文导出测试）',
    columns: ['词条', '义项序号', '词性', '简明释义', '详细释义', '例句', '词频', '名次'],
    rows,
    source: 'cet4（2026-10）',
  };
}

describe('docx 导出', () => {
  it('写出包含中文表头、数据与重复表头设置的真实 docx', async () => {
    const destination = path.join(temp, 'deck.docx');
    await exportToDocx(makeModel(), destination);

    const files = readZipTexts(destination);
    const xml = files['word/document.xml'];
    expect(xml).toBeDefined();
    expect(xml).toContain('简明释义');
    expect(xml).toContain('放弃；抛弃');
    expect(xml).toContain('四级核心词（中文导出测试）');
    expect(xml).toContain('详细释义：不再坚持某件事。');
    expect(xml).toContain('<w:tblHeader');
    // OOXML 会把单引号写成实体 `&apos;`；重点是“以 ' 开头的文本仍是文本，没有被当成公式”。
    expect(xml).toContain('&apos;=SUM(A1:A2)');
    expect(readFileSync(destination).subarray(0, 2).toString()).toBe('PK');
  });
});

describe('xlsx 导出', () => {
  it('保留中文内容、公式转义，并冻结表头与启用筛选', async () => {
    const destination = path.join(temp, 'deck.xlsx');
    await exportToXlsx(makeModel(), destination);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(destination);
    const sheet = workbook.getWorksheet(1);
    expect(sheet).toBeDefined();
    if (sheet === undefined) {
      return;
    }

    // 有来源标注时：1 标题、2 时间、3 来源、4 表头。
    expect(sheet.getCell(4, 1).value).toBe('词条');
    expect(sheet.getCell(4, 4).value).toBe('简明释义');
    expect(sheet.getCell(5, 4).value).toBe('放弃；抛弃');
    expect(String(sheet.getCell(5, 7).value)).toBe("'=SUM(A1:A2)");
    expect(sheet.getCell(5, 7).type).toBe(ExcelJS.ValueType.String);
    const view = sheet.views[0] as { state?: string; ySplit?: number };
    expect(view.state).toBe('frozen');
    expect(view.ySplit).toBe(4);
    // ExcelJS 读回时把 autoFilter 规范成区间字符串，而不是写入时的对象。
    expect(sheet.autoFilter).toBe('A4:H7');
    expect(sheet.pageSetup.paperSize).toBe(9);
    expect(sheet.pageSetup.printTitlesRow).toBe('4:4');
    expect(sheet.getCell(5, 5).alignment?.wrapText).toBe(true);
  });
});

describe('pdf 导出', () => {
  it('嵌入中文字体，长文跨页，重复表头并写页码', async () => {
    const destination = path.join(temp, 'deck.pdf');
    await exportToPdf(makeModel(36), destination, fontPath);

    const bytes = readFileSync(destination);
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
    const document = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
    expect(document.numPages).toBeGreaterThan(1);

    const pages: string[] = [];
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(''),
      );
    }
    const allText = pages.join('\n');
    expect(allText).toContain('放弃；抛弃');
    expect(allText).toContain('四级核心词（中文导出测试）');
    expect(allText).toContain('详细释义：不再坚持某件事。');
    expect(allText).toContain('第 1 页 / 共');
    expect(allText).toContain(`第 ${document.numPages} 页 / 共 ${document.numPages} 页`);
    // 表头不只出现在第一页：后续页也重复。
    expect(pages.filter((text) => text.includes('简明释义')).length).toBe(document.numPages);
    await document.destroy();
  });
});

describe('DocumentWriterPort', () => {
  it('断网状态下仍能写出并返回真实回执', async () => {
    const writer = createDocumentWriter({ fontPath });
    const destination = path.join(temp, 'offline.docx');
    const model = makeModel(1);
    const receipt = await writer.write(model, 'WORD', destination);

    expect(receipt).toStrictEqual({
      kind: 'DECK',
      format: 'WORD',
      destination,
      rowCount: 1,
      generatedAt: model.generatedAt,
    });
    expect(readFileSync(destination).subarray(0, 2).toString()).toBe('PK');
  });
});
