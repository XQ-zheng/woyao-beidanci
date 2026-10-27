/** 极简命令行参数解析：`--key=value` 与 `--flag`。 */

export interface ParsedArgs {
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
}

/**
 * 解析参数。
 *
 * @param argv `process.argv.slice(2)`。
 * @returns 布尔开关与键值参数。
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      continue;
    }
    const body = item.slice(2);
    const separator = body.indexOf('=');
    if (separator !== -1) {
      values.set(body.slice(0, separator), body.slice(separator + 1));
      continue;
    }
    const next = argv[index + 1];
    // 同时支持 `--db path` 与 `--db=path`：npm 会把 `--db path` 原样透传，
    // 只认等号会让命令行看起来“参数明明给了却报缺失”。
    if (next !== undefined && !next.startsWith('--')) {
      values.set(body, next);
      index += 1;
    } else {
      flags.add(body);
    }
  }
  return { flags, values };
}

/**
 * 取必填参数，缺失时抛出可读错误。
 *
 * @param args 解析结果。
 * @param key 键名。
 * @returns 值。
 */
export function requireOption(args: ParsedArgs, key: string): string {
  const value = args.values.get(key);
  if (value === undefined || value.trim() === '') {
    throw new Error(`缺少参数 --${key}=...`);
  }
  return value;
}
