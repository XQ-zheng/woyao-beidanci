/**
 * 校验四份资源清单。
 *
 * 默认只校验结构；`--bundle` 还会要求 `redistributionAllowed=true` 且数据文件存在。
 * 数据文件缺失只警告（仓库不携带未核验数据是预期状态），校验和不符则是错误。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { assertChecksum, loadManifest, type AssetEntry } from '../packages/assets/src/manifest';
import { parseArgs } from './args';

const KINDS = ['dictionaries', 'frequency', 'audio', 'associations'] as const;
const ROOT = path.resolve('packages/assets');

/**
 * 校验一份清单及其本地数据文件。
 *
 * @param manifestPath 清单路径。
 * @param bundle 是否按“随安装包发布”校验。
 * @returns 错误与警告。
 */
async function validateOne(
  manifestPath: string,
  bundle: boolean,
): Promise<{ errors: string[]; warnings: string[]; assets: number }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const manifest = await loadManifest(manifestPath, { requireRedistribution: bundle });
  const directory = path.dirname(manifestPath);

  for (const entry of manifest.assets as readonly AssetEntry[]) {
    const file = path.join(directory, entry.path);
    if (!existsSync(file)) {
      const message = `${entry.id}: 数据文件不存在（${file}）`;
      if (bundle) {
        errors.push(message);
      } else {
        warnings.push(message);
      }
      continue;
    }
    try {
      await assertChecksum(entry, file);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { errors, warnings, assets: manifest.assets.length };
}

const args = parseArgs(process.argv.slice(2));
const bundle = args.flags.has('bundle');
const report: { manifests: Record<string, unknown>; errors: string[]; warnings: string[] } = {
  manifests: {},
  errors: [],
  warnings: [],
};

for (const kind of KINDS) {
  const manifestPath = path.join(ROOT, kind, 'manifest.json');
  try {
    const result = await validateOne(manifestPath, bundle);
    report.manifests[kind] = { assets: result.assets };
    report.errors.push(...result.errors);
    report.warnings.push(...result.warnings);
  } catch (error) {
    report.errors.push(`${kind}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.errors.length === 0 ? 0 : 1);
