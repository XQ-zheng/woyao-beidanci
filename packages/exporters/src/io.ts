import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 原子写出：先写同目录临时文件，成功后 rename。
 *
 * 直接覆盖目标文件时，进程中途退出会留下“看起来存在、其实截断”的 docx/xlsx/pdf；
 * 用户发现时往往已经覆盖了上一份好备份。同目录 rename 在 Windows 上也不需要跨盘移动。
 *
 * @param destination 最终文件路径。
 * @param data 完整文件内容。
 */
export async function writeFileAtomic(destination: string, data: Buffer): Promise<void> {
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const temporary = `${destination}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, destination);
  } catch (error) {
    const { unlink } = await import('node:fs/promises');
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** 列宽权重：释义与例句比编号/词性需要更多空间。 */
const COLUMN_WEIGHTS: Readonly<Record<string, number>> = {
  词条: 1.2,
  义项序号: 0.45,
  词性: 0.5,
  简明释义: 1.2,
  详细释义: 1.6,
  例句: 1.6,
  词频: 0.55,
  名次: 0.55,
  类型: 0.65,
  本地日: 0.9,
  开始时间: 1.2,
  结束时间: 1.2,
  总数: 0.5,
  正确: 0.5,
  错误: 0.5,
  '时长(毫秒)': 0.8,
};

/**
 * 按表头语义分配列宽，避免“详细释义”被压成几厘米宽而数字列占半页。
 *
 * @param columns 表头。
 * @param totalWidth 可用总宽度。
 * @returns 每列宽度。
 */
export function allocateColumnWidths(columns: readonly string[], totalWidth: number): number[] {
  const weights = columns.map((column) => COLUMN_WEIGHTS[column] ?? 1);
  const sum = weights.reduce((total, weight) => total + weight, 0);
  return weights.map((weight) => Math.floor((weight / sum) * totalWidth));
}
