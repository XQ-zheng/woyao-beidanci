/**
 * 导入本地 NETEM 词频 JSON。
 *
 * 用法：
 *   npm run import:frequency -- --db data.sqlite3 --json netem_full_list.json \
 *     --manifest packages/assets/frequency/manifest.json --exam=NETEM --version=netem-2026-10 \
 *     [--allow=CC-BY-NC-SA-4.0]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { closeDatabase, createWordRepository, migrate, openDatabase } from '@woyao/data';

import { importFrequency, loadManifest, parseNetemJson } from '../packages/assets/src/index';
import { parseArgs, requireOption } from './args';

const args = parseArgs(process.argv.slice(2));
const dbPath = requireOption(args, 'db');
const jsonPath = requireOption(args, 'json');
const manifestPath = requireOption(args, 'manifest');
const exam = args.values.get('exam') ?? 'NETEM';
const corpusVersion = requireOption(args, 'version');
const allow = args.values.get('allow')?.split(',').map((item) => item.trim());

const manifest = await loadManifest(manifestPath);
const entry = manifest.assets.find((asset) => asset.kind === 'FREQUENCY');
if (entry === undefined) {
  throw new Error('清单里没有 FREQUENCY 条目');
}

const rows = parseNetemJson(JSON.parse(await readFile(jsonPath, 'utf8')));
if (args.flags.has('dry-run')) {
  console.log(JSON.stringify({ dryRun: true, rows: rows.length, exam, version: corpusVersion }, null, 2));
  process.exit(0);
}

const db = openDatabase(path.resolve(dbPath));
try {
  migrate(db);
  const result = await importFrequency({
    repo: createWordRepository(db),
    rows,
    entry,
    exam,
    corpusVersion,
    deviceId: `import-${process.platform}`,
    now: new Date(),
    sourceFilePath: jsonPath,
    allowedLicenses: allow,
  });
  console.log(JSON.stringify({ ...result, rows: rows.length }, null, 2));
} finally {
  closeDatabase(db);
}
