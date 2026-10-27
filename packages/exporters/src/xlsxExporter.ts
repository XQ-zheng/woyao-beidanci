import ExcelJS from 'exceljs';

import type { ExportModel } from './exportModel';
import { writeFileAtomic } from './io';

/**
 * 生成真实 `.xlsx` 并原子落盘。
 *
 * 表头冻结 + 筛选 + 自动换行；用户文本以字符串写入，公式转义由服务层已完成。
 *
 * @param model 导出模型。
 * @param destination 目标 `.xlsx` 路径。
 */
export async function exportToXlsx(model: ExportModel, destination: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '我要背单词';
  workbook.created = new Date(model.generatedAt);
  workbook.modified = workbook.created;

  const sheet = workbook.addWorksheet(model.title.slice(0, 31), {
    views: [{ state: 'frozen', ySplit: model.source === null ? 3 : 4 }],
  });

  sheet.mergeCells(1, 1, 1, model.columns.length);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = model.title;
  titleCell.font = { bold: true, size: 16 };
  titleCell.alignment = { vertical: 'middle' };
  sheet.getRow(1).height = 26;

  sheet.mergeCells(2, 1, 2, model.columns.length);
  sheet.getCell(2, 1).value = `导出时间：${model.generatedAt}`;

  const headerRow = model.source === null ? 3 : 4;
  if (model.source !== null) {
    sheet.mergeCells(3, 1, 3, model.columns.length);
    sheet.getCell(3, 1).value = `词频来源：${model.source}`;
  }

  const header = sheet.getRow(headerRow);
  header.values = model.columns;
  header.height = 24;
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000000' } };
  header.alignment = { vertical: 'middle', wrapText: true };

  for (const values of model.rows) {
    const row = sheet.addRow(values);
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.numFmt = '@';
    });
  }

  sheet.columns = model.columns.map((column, index) => {
    const longest = Math.max(
      column.length,
      ...model.rows.map((row) => (row[index] ?? '').split('\n').reduce((max, line) => Math.max(max, line.length), 0)),
    );
    return { width: Math.min(60, Math.max(10, longest * 1.6 + 4)) };
  });

  sheet.autoFilter = {
    from: { row: headerRow, column: 1 },
    to: { row: headerRow + model.rows.length, column: model.columns.length },
  };
  sheet.pageSetup = {
    paperSize: 9,
    orientation: 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    printTitlesRow: `${headerRow}:${headerRow}`,
    margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
  };
  sheet.headerFooter.oddFooter = '&C第 &P 页 / 共 &N 页';

  const buffer = await workbook.xlsx.writeBuffer();
  await writeFileAtomic(destination, Buffer.from(buffer));
}
