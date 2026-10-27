import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';

import type { ExportModel } from './exportModel';
import { allocateColumnWidths, writeFileAtomic } from './io';

/** A4 纵向、四边 0.5 英寸边距后的正文宽度（twips）。 */
const CONTENT_WIDTH = 10466;
// docx 不嵌入字体：这里指定 Windows 上普遍存在的微软雅黑，缺失时由 Word 回退。
const FONT_NAME = 'Microsoft YaHei';

/** 一段正文；统一指定中文字体，避免 Word 用默认西文字体替换成乱码。 */
function paragraph(text: string, bold = false): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, bold, font: FONT_NAME, size: 18 })],
    spacing: { after: 0, line: 240 },
  });
}

/** 一个表格单元格。 */
function cell(text: string, width: number, header: boolean): TableCell {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    verticalAlign: VerticalAlign.CENTER,
    shading: header ? { fill: '000000' } : undefined,
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text,
            bold: header,
            color: header ? 'FFFFFF' : '000000',
            font: FONT_NAME,
            size: 18,
          }),
        ],
        spacing: { after: 0, line: 240 },
      }),
    ],
  });
}

/**
 * 生成真实 `.docx` 并原子落盘。
 *
 * 使用 A4 纵向、固定表格布局、重复表头；长释义交给 Word 的单元格换行，不在服务层截断。
 *
 * @param model 导出模型。
 * @param destination 目标 `.docx` 路径。
 */
export async function exportToDocx(model: ExportModel, destination: string): Promise<void> {
  const widths = allocateColumnWidths(model.columns, CONTENT_WIDTH);
  const header = new TableRow({
    tableHeader: true,
    children: model.columns.map((column, index) => cell(column, widths[index], true)),
  });
  const rows = model.rows.map(
    (row) =>
      new TableRow({
        children: row.map((value, index) => cell(value, widths[index], false)),
      }),
  );

  const document = new Document({
    creator: '我要背单词',
    title: model.title,
    description: `我要背单词导出，${model.rows.length} 行`,
    styles: {
      default: {
        document: { run: { font: FONT_NAME, size: 18 } },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 720, right: 720, bottom: 720, left: 720 },
          },
        },
        children: [
          new Paragraph({
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.LEFT,
            children: [new TextRun({ text: model.title, bold: true, font: FONT_NAME, size: 32 })],
            spacing: { after: 160 },
          }),
          paragraph(`导出时间：${model.generatedAt}`),
          ...(model.source === null ? [] : [paragraph(`词频来源：${model.source}`)]),
          new Paragraph({ spacing: { after: 120 } }),
          new Table({
            width: { size: CONTENT_WIDTH, type: WidthType.DXA },
            columnWidths: widths,
            borders: {
              top: { style: BorderStyle.SINGLE, size: 2, color: 'BFBFBF' },
              bottom: { style: BorderStyle.SINGLE, size: 2, color: 'BFBFBF' },
              left: { style: BorderStyle.SINGLE, size: 2, color: 'BFBFBF' },
              right: { style: BorderStyle.SINGLE, size: 2, color: 'BFBFBF' },
              insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'D9D9D9' },
              insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'D9D9D9' },
            },
            rows: [header, ...rows],
          }),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(document);
  await writeFileAtomic(destination, buffer);
}
