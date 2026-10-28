import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { afterAll, describe, expect, it } from 'vitest';

import { extractDocumentText, extensionOf } from './documents';

const temp = mkdtempSync(path.join(tmpdir(), 'woyao-import-'));

afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
});

/** 在临时目录写一个文件，返回绝对路径。 */
function writeTemp(name: string, data: Buffer | string): string {
  const filePath = path.join(temp, name);
  writeFileSync(filePath, data);
  return filePath;
}

describe('extensionOf', () => {
  it('识别支持与不支持的扩展名', () => {
    expect(extensionOf('a.docx')).toBe('docx');
    expect(extensionOf('a.PDF')).toBe('pdf');
    expect(extensionOf('a.exe')).toBeNull();
  });
});

describe('extractDocumentText：真实文件端到端', () => {
  it('txt 直接读文本', async () => {
    const file = writeTemp('sample.txt', 'apple banana\ncherry');
    const text = await extractDocumentText(file, 'txt');
    expect(text).toContain('apple banana');
    expect(text).toContain('cherry');
  });

  it('xlsx 提取所有单元格文本', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('words');
    sheet.addRow(['word', 'meaning']);
    sheet.addRow(['abandon', '放弃']);
    sheet.addRow(['knowledge', '知识']);
    const buffer = await workbook.xlsx.writeBuffer();
    const file = writeTemp('sample.xlsx', Buffer.from(buffer));
    const text = await extractDocumentText(file, 'xlsx');
    expect(text).toContain('abandon');
    expect(text).toContain('knowledge');
    expect(text).toContain('放弃');
  });

  it('docx 提取正文文本', async () => {
    // 用 jszip 手工构造一个最小 docx：word/document.xml 里放两个 <w:t>
    const zip = new JSZip();
    zip.file(
      'word/document.xml',
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>abandon</w:t></w:r></w:p><w:p><w:r><w:t>give up</w:t></w:r></w:p></w:body></w:document>',
    );
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const file = writeTemp('sample.docx', buffer);
    const text = await extractDocumentText(file, 'docx');
    expect(text).toContain('abandon');
    expect(text).toContain('give up');
  });

  it('pptx 提取幻灯片文本', async () => {
    const zip = new JSZip();
    zip.file(
      'ppt/slides/slide1.xml',
      '<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>abandon</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    );
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const file = writeTemp('sample.pptx', buffer);
    const text = await extractDocumentText(file, 'pptx');
    expect(text).toContain('abandon');
  });

  it('不支持的格式抛错', async () => {
    const file = writeTemp('sample.bin', Buffer.from([1, 2, 3]));
    await expect(extractDocumentText(file, 'docx')).rejects.toThrow();
  });
});
