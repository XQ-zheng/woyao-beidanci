/**
 * 最小 RFC 4180 CSV 解析器。
 *
 * 不引入第三方 CSV 库：ECDICT 的 `translation` 字段里有中文逗号、引号与换行，
 * 直接 `split(',')` 会把一条释义切成十几列。这里只实现这套数据真正需要的规则
 * （引号包裹、`""` 转义、引号内换行）。
 *
 * @param text CSV 全文。
 * @returns 行 × 列。
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (character === '\r') {
      // 交给紧随其后的 \n 处理；孤立的 \r 当作普通字符丢弃。
    } else {
      field += character;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
