/**
 * 导入本地 ECDICT CSV。
 *
 * 用法：
 *   npm run import:dictionary -- --db data.sqlite3 --csv ecdict.csv \
 *     --manifest packages/assets/dictionaries/manifest.json [--tags=cet4,cet6,ky] [--allow=MIT]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { closeDatabase, createWordRepository, migrate, openDatabase } from '@woyao/data';

import { importEcdict, loadManifest, parseEcdictCsv } from '../packages/assets/src/index';
import { parseArgs, requireOption } from './args';

const args = parseArgs(process.argv.slice(2));
const dbPath = requireOption(args, 'db');
const csvPath = requireOption(args, 'csv');
const manifestPath = requireOption(args, 'manifest');
const tags = (args.values.get('tags') ?? 'cet4,cet6,ky')
  .split(',')
  .map((tag) => tag.trim())
  .filter((tag) => tag.length > 0);
const allow = args.values.get('allow')?.split(',').map((item) => item.trim());

const manifest = await loadManifest(manifestPath);
const entry = manifest.assets.find((asset) => asset.kind === 'DICTIONARY');
if (entry === undefined) {
  throw new Error('清单里没有 DICTIONARY 条目');
}

const csv = await readFile(csvPath, 'utf8');
const rows = parseEcdictCsv(csv);
if (args.flags.has('dry-run')) {
  const matched = rows.filter((row) => tags.some((tag) => row.tag.toLowerCase().split(/\s+/u).includes(tag))).length;
  console.log(JSON.stringify({ dryRun: true, rows: rows.length, matched, tags, manifest: entry.id }, null, 2));
  process.exit(0);
}

const db = openDatabase(path.resolve(dbPath));
try {
  migrate(db);
  const result = await importEcdict({
    repo: createWordRepository(db),
    rows,
    entry,
    deviceId: `import-${process.platform}`,
    now: new Date(),
    tags,
    sourceFilePath: csvPath,
    allowedLicenses: allow,
  });
  console.log(JSON.stringify({ ...result, rows: rows.length }, null, 2));
} finally {
  closeDatabase(db);
}
