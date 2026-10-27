import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertChecksum,
  loadManifest,
  sha256File,
  validateManifest,
  type AssetEntry,
} from './manifest';

/** 一条结构完整的清单条目。 */
function validEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ecdict',
    kind: 'DICTIONARY',
    path: 'ecdict.csv',
    format: 'csv',
    source: {
      name: 'ECDICT',
      url: 'https://github.com/skywind3000/ECDICT',
      version: '2026-10-24',
      license: {
        code: 'MIT',
        url: 'https://github.com/skywind3000/ECDICT/blob/master/LICENSE',
        attribution: 'ECDICT contributors',
        redistributionAllowed: true,
      },
    },
    checksum: { algorithm: 'sha256', value: 'a'.repeat(64) },
    ...overrides,
  };
}

describe('manifest 校验', () => {
  it('接受结构完整的清单', () => {
    const manifest = validateManifest({ schemaVersion: 1, assets: [validEntry()] });
    expect(manifest.assets[0]?.source.version).toBe('2026-10-24');
    expect(manifest.assets[0]?.checksum.value).toBe('a'.repeat(64));
  });

  it('缺 version / checksum 直接拒绝', () => {
    expect(() =>
      validateManifest({
        schemaVersion: 1,
        assets: [
          validEntry({
            source: {
              name: 'X',
              url: 'https://example.com',
              license: {
                code: 'MIT',
                url: 'https://example.com/license',
                attribution: 'X',
                redistributionAllowed: true,
              },
            },
          }),
        ],
      }),
    ).toThrow(/version/);

    expect(() => validateManifest({ schemaVersion: 1, assets: [validEntry({ checksum: undefined })] })).toThrow(
      /checksum/,
    );
  });

  it('许可不在白名单时拒绝', () => {
    const raw = { schemaVersion: 1, assets: [validEntry()] };
    expect(() => validateManifest(raw, { allowedLicenses: ['CC-BY-4.0'] })).toThrow(/不在允许列表/);
  });

  it('不允许再分发的条目不能作为随包资源', () => {
    const entry = validEntry();
    const license = (entry.source as Record<string, unknown>).license as Record<string, unknown>;
    license.redistributionAllowed = false;
    expect(() => validateManifest({ schemaVersion: 1, assets: [entry] }, { requireRedistribution: true })).toThrow(
      /不允许再分发/,
    );
  });

  it('重复 id 被拒绝', () => {
    expect(() =>
      validateManifest({ schemaVersion: 1, assets: [validEntry(), validEntry()] }),
    ).toThrow(/重复/);
  });
});

describe('checksum 校验', () => {
  it('文件内容与清单一致时通过，不一致时拒绝', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'woyao-assets-'));
    const file = path.join(dir, 'ecdict.csv');
    writeFileSync(file, 'word,translation\nabandon,放弃\n', 'utf8');
    const value = await sha256File(file);
    const entry = validateManifest({
      schemaVersion: 1,
      assets: [validEntry({ checksum: { algorithm: 'sha256', value } })],
    }).assets[0] as AssetEntry;

    await expect(assertChecksum(entry, file)).resolves.toBeUndefined();
    writeFileSync(file, 'word,translation\nabandon,抛弃\n', 'utf8');
    await expect(assertChecksum(entry, file)).rejects.toThrow(/不一致/);
  });

  it('从磁盘读取 JSON 清单', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'woyao-assets-'));
    const manifestPath = path.join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, assets: [] }), 'utf8');
    await expect(loadManifest(manifestPath)).resolves.toMatchObject({ schemaVersion: 1, assets: [] });
  });
});
