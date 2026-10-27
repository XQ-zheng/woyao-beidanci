/** 本地导出器入口。 */
import type { DocumentWriterPort, ExportFormat } from '@woyao/services';

import { exportToDocx } from './docxExporter';
import { receiptOf, type ExportModel } from './exportModel';
import { exportToPdf } from './pdfExporter';
import { exportToXlsx } from './xlsxExporter';

export { exportToDocx } from './docxExporter';
export { exportToPdf } from './pdfExporter';
export { exportToXlsx } from './xlsxExporter';
export type { ExportModel, ExportReceipt } from './exportModel';

/** 创建写出器的参数。 */
export interface DocumentWriterOptions {
  /** 随包附带的中文字体绝对路径（OFL 许可）。 */
  readonly fontPath: string;
}

/**
 * 创建 `DocumentWriterPort` 的真实实现。
 *
 * 这个端口只负责路由到三个导出器并返回回执，**不联网**；导出路径由桌面端文件对话框决定。
 *
 * @param options 中文字体路径。
 * @returns 可注入服务运行时的写出端口。
 */
export function createDocumentWriter(options: DocumentWriterOptions): DocumentWriterPort {
  async function write(model: ExportModel, format: ExportFormat, destination: string): Promise<ReturnType<typeof receiptOf>> {
    switch (format) {
      case 'WORD':
        await exportToDocx(model, destination);
        break;
      case 'PDF':
        await exportToPdf(model, destination, options.fontPath);
        break;
      case 'EXCEL':
        await exportToXlsx(model, destination);
        break;
    }
    return receiptOf(model, format, destination);
  }

  return { write };
}
