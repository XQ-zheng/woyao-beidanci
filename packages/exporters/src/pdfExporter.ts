import PDFDocument from 'pdfkit';

import type { ExportModel } from './exportModel';
import { allocateColumnWidths, writeFileAtomic } from './io';

/** A4 正文参数（pt）。 */
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 32;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const CONTENT_BOTTOM = PAGE_HEIGHT - MARGIN - 20;
const FONT_SIZE = 8;
const LINE_HEIGHT = 12;
const CELL_PADDING_X = 3;
const ROW_GAP = 4;

type Pdf = InstanceType<typeof PDFDocument>;

/**
 * 按实际字宽折行。
 *
 * 不能按空格切：中文句子没有空格，直接交给 `doc.text` 很容易整行溢出单元格。
 * 这里逐字符测量，中文和没有空格的长英文/URL 都能断行。
 *
 * @param doc PDF 文档。
 * @param text 单元格原文。
 * @param width 可用宽度。
 * @returns 折行后的文本行。
 */
function wrapCell(doc: Pdf, text: string, width: number): string[] {
  if (text.length === 0) {
    return [''];
  }
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const character of paragraph) {
      const candidate = line + character;
      if (line.length > 0 && doc.widthOfString(candidate, { lineBreak: false }) > width) {
        lines.push(line);
        line = character;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines.length === 0 ? [''] : lines;
}

/** 画一行单元格片段（可能是一个长行的第 N 段）。 */
function drawFragment(
  doc: Pdf,
  linesByCell: readonly (readonly string[])[],
  offset: number,
  count: number,
  widths: readonly number[],
  y: number,
): void {
  let x = MARGIN;
  doc.fontSize(FONT_SIZE).fillColor('#000000');
  for (let column = 0; column < widths.length; column += 1) {
    const lines = linesByCell[column].slice(offset, offset + count);
    // 逐行定位：`lineBreak: false` 时多行字符串不会自动换行，靠 y 偏移保证行距一致。
    for (let line = 0; line < lines.length; line += 1) {
      doc.text(lines[line], x + CELL_PADDING_X, y + line * LINE_HEIGHT, {
        width: widths[column] - CELL_PADDING_X * 2,
        lineBreak: false,
      });
    }
    x += widths[column];
  }
  doc
    .moveTo(MARGIN, y + count * LINE_HEIGHT + 1)
    .lineTo(MARGIN + CONTENT_WIDTH, y + count * LINE_HEIGHT + 1)
    .lineWidth(0.3)
    .strokeColor('#d9d9d9')
    .stroke();
}

/**
 * 生成真实 `.pdf` 并原子落盘。
 *
 * A4 纵向；每页重复表头与页码；长行按实际字宽拆成多段，可跨页，不截断内容。
 *
 * @param model 导出模型。
 * @param destination 目标 `.pdf` 路径。
 * @param fontPath 可再分发中文字体路径（随包附带 OFL 许可）。
 */
export async function exportToPdf(
  model: ExportModel,
  destination: string,
  fontPath: string,
): Promise<void> {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: {
      Title: model.title,
      Author: '我要背单词',
      Subject: `${model.rows.length} 行导出数据`,
      CreationDate: new Date(model.generatedAt),
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve) => doc.on('end', resolve));

  doc.registerFont('NotoCJK', fontPath);
  doc.font('NotoCJK');

  const widths = allocateColumnWidths(model.columns, CONTENT_WIDTH);
  let y = MARGIN;

  /** 开新页；首页带标题与来源，其余页直接从重复表头开始。 */
  function startPage(first: boolean): void {
    if (!first) {
      doc.addPage();
      doc.font('NotoCJK');
    }
    y = MARGIN;
    if (first) {
      doc.fontSize(16).fillColor('#000000').text(model.title, MARGIN, y, { width: CONTENT_WIDTH });
      y = doc.y + 4;
      doc.fontSize(8).fillColor('#555555').text(`导出时间：${model.generatedAt}`, MARGIN, y, {
        width: CONTENT_WIDTH,
      });
      y = doc.y + 2;
      if (model.source !== null) {
        doc.text(`词频来源：${model.source}`, MARGIN, y, { width: CONTENT_WIDTH });
        y = doc.y + 2;
      }
      y += 8;
    }

    let x = MARGIN;
    doc.rect(MARGIN, y, CONTENT_WIDTH, LINE_HEIGHT + 4).fill('#000000');
    for (let index = 0; index < model.columns.length; index += 1) {
      doc
        .fontSize(FONT_SIZE)
        .fillColor('#ffffff')
        .text(model.columns[index], x + CELL_PADDING_X, y + 3, {
          width: widths[index] - CELL_PADDING_X * 2,
          height: LINE_HEIGHT,
          ellipsis: true,
          lineBreak: false,
        });
      x += widths[index];
    }
    y += LINE_HEIGHT + 6;
  }

  startPage(true);

  for (const row of model.rows) {
    doc.fontSize(FONT_SIZE);
    const linesByCell = row.map((value, index) =>
      wrapCell(doc, value, widths[index] - CELL_PADDING_X * 2),
    );
    const totalLines = Math.max(...linesByCell.map((lines) => lines.length));
    let offset = 0;

    while (offset < totalLines) {
      const availableLines = Math.floor((CONTENT_BOTTOM - y - ROW_GAP) / LINE_HEIGHT);
      if (availableLines < 1) {
        startPage(false);
        continue;
      }
      const count = Math.min(totalLines - offset, availableLines);
      drawFragment(doc, linesByCell, offset, count, widths, y);
      y += count * LINE_HEIGHT + ROW_GAP;
      offset += count;
      if (offset < totalLines) {
        startPage(false);
      }
    }
  }

  const pages = doc.bufferedPageRange();
  for (let index = pages.start; index < pages.start + pages.count; index += 1) {
    doc.switchToPage(index);
    doc
      .fontSize(8)
      .fillColor('#555555')
      .text(`第 ${index - pages.start + 1} 页 / 共 ${pages.count} 页`, MARGIN, PAGE_HEIGHT - MARGIN - 30, {
        width: CONTENT_WIDTH,
        align: 'center',
        lineBreak: false,
      });
  }

  doc.end();
  await finished;
  await writeFileAtomic(destination, Buffer.concat(chunks));
}
