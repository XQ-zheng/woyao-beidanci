/** 导出器内部约定与类型。 */
import type { ExportFormat, ExportModel, ExportReceipt } from '@woyao/services';

export type { ExportModel, ExportReceipt } from '@woyao/services';

/** 真实写出函数的返回结构：三个导出器都先返回完整 Buffer，再统一原子落盘。 */
export type ExportBufferWriter = (model: ExportModel) => Promise<Buffer>;

/** 按格式选择真实导出器。 */
export type ExportWriters = Readonly<Record<ExportFormat, ExportBufferWriter>>;

/** 依据模型与格式生成回执。 */
export function receiptOf(
  model: ExportModel,
  format: ExportFormat,
  destination: string,
): ExportReceipt {
  return {
    kind: model.kind,
    format,
    destination,
    rowCount: model.rows.length,
    generatedAt: model.generatedAt,
  };
}
