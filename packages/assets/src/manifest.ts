/**
 * 资源清单：把“用了谁的数据、什么版本、什么许可、校验和是多少”写成可校验的 JSON。
 *
 * 设计取舍：
 * - **没有 checksum 就不算清单**：没有校验和就无法证明导入的是同一份数据，
 *   也无法在数据被替换时及时发现。
 * - **未核验许可不得随包分发**：`redistributionAllowed=false` 的条目可以本地导入，
 *   但不能被安装包携带；`requireRedistribution` 会把这类条目直接拦下。
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** 资源种类。 */
export type AssetKind = 'DICTIONARY' | 'FREQUENCY' | 'AUDIO' | 'ASSOCIATION';

/** 许可信息。 */
export interface AssetLicense {
  /** SPDX 标识或 `UNVERIFIED`。 */
  readonly code: string;
  /** 许可全文地址。 */
  readonly url: string;
  /** 署名文本（必须能追溯到作者/项目）。 */
  readonly attribution: string;
  /** 是否允许随应用再分发；未核验时必须为 `false`。 */
  readonly redistributionAllowed: boolean;
}

/** 数据来源。 */
export interface AssetSource {
  readonly name: string;
  readonly url: string;
  /** 上游版本/快照日期，必填：没有版本就无法复现导入结果。 */
  readonly version: string;
  readonly license: AssetLicense;
}

/** 一条资源条目。 */
export interface AssetEntry {
  readonly id: string;
  readonly kind: AssetKind;
  /** 相对清单文件或数据根的文件名。 */
  readonly path: string;
  /** 文件格式（csv/json/zip/mp3）。 */
  readonly format: string;
  readonly source: AssetSource;
  readonly checksum: { readonly algorithm: 'sha256'; readonly value: string };
  readonly notes?: string;
}

/** 一份清单。 */
export interface AssetManifest {
  readonly schemaVersion: 1;
  readonly assets: readonly AssetEntry[];
  readonly notes?: readonly string[];
}

/** 清单校验错误。 */
export class AssetValidationError extends Error {
  readonly path: string;

  /**
   * @param path 出问题的字段路径。
   * @param message 说明。
   */
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'AssetValidationError';
    this.path = path;
  }
}

/** 校验选项。 */
export interface ValidateOptions {
  /** 允许的许可标识；不给则不按许可白名单限制。 */
  readonly allowedLicenses?: readonly string[];
  /** 是否要求可再分发（随安装包发布时为 true）。 */
  readonly requireRedistribution?: boolean;
}

/** 非空字符串断言。 */
function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AssetValidationError(path, '必须是非空字符串');
  }
  return value;
}

/** SHA-256 十六进制校验和格式。 */
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * 校验并规范一份清单。
 *
 * @param raw 未知输入（来自 JSON）。
 * @param options 许可约束。
 * @returns 校验通过的清单。
 */
export function validateManifest(raw: unknown, options: ValidateOptions = {}): AssetManifest {
  if (raw === null || typeof raw !== 'object') {
    throw new AssetValidationError('manifest', '必须是对象');
  }
  const input = raw as Record<string, unknown>;
  if (input.schemaVersion !== 1) {
    throw new AssetValidationError('schemaVersion', '只支持版本 1');
  }
  const assetsInput = input.assets;
  if (!Array.isArray(assetsInput)) {
    throw new AssetValidationError('assets', '必须是数组');
  }

  const ids = new Set<string>();
  const assets: AssetEntry[] = [];
  for (const [index, item] of assetsInput.entries()) {
    const path = `assets[${index}]`;
    if (item === null || typeof item !== 'object') {
      throw new AssetValidationError(path, '必须是对象');
    }
    const entry = item as Record<string, unknown>;
    const id = requireString(entry.id, `${path}.id`);
    if (ids.has(id)) {
      throw new AssetValidationError(`${path}.id`, `重复的资源 id：${id}`);
    }
    ids.add(id);

    const kind = requireString(entry.kind, `${path}.kind`);
    if (!['DICTIONARY', 'FREQUENCY', 'AUDIO', 'ASSOCIATION'].includes(kind)) {
      throw new AssetValidationError(`${path}.kind`, `未知资源种类：${kind}`);
    }
    const filePath = requireString(entry.path, `${path}.path`);
    if (filePath.startsWith('/') || filePath.split('/').includes('..')) {
      throw new AssetValidationError(`${path}.path`, '必须是清单目录内的相对路径');
    }
    const format = requireString(entry.format, `${path}.format`);

    const sourceRaw = entry.source;
    if (sourceRaw === null || typeof sourceRaw !== 'object') {
      throw new AssetValidationError(`${path}.source`, '必须包含来源信息');
    }
    const source = sourceRaw as Record<string, unknown>;
    const name = requireString(source.name, `${path}.source.name`);
    const url = requireString(source.url, `${path}.source.url`);
    const version = requireString(source.version, `${path}.source.version`);

    const licenseRaw = source.license;
    if (licenseRaw === null || typeof licenseRaw !== 'object') {
      throw new AssetValidationError(`${path}.source.license`, '必须包含许可信息');
    }
    const license = licenseRaw as Record<string, unknown>;
    const code = requireString(license.code, `${path}.source.license.code`);
    const licenseUrl = requireString(license.url, `${path}.source.license.url`);
    const attribution = requireString(license.attribution, `${path}.source.license.attribution`);
    if (typeof license.redistributionAllowed !== 'boolean') {
      throw new AssetValidationError(`${path}.source.license.redistributionAllowed`, '必须是布尔值');
    }
    if (options.allowedLicenses !== undefined && !options.allowedLicenses.includes(code)) {
      throw new AssetValidationError(
        `${path}.source.license.code`,
        `许可 ${code} 不在允许列表（${options.allowedLicenses.join(', ')}）中`,
      );
    }
    if (options.requireRedistribution === true && license.redistributionAllowed !== true) {
      throw new AssetValidationError(`${path}.source.license`, `许可 ${code} 不允许再分发，不能随安装包发布`);
    }

    const checksumRaw = entry.checksum;
    if (checksumRaw === null || typeof checksumRaw !== 'object') {
      throw new AssetValidationError(`${path}.checksum`, '必须提供校验和');
    }
    const checksum = checksumRaw as Record<string, unknown>;
    if (checksum.algorithm !== 'sha256') {
      throw new AssetValidationError(`${path}.checksum.algorithm`, '只支持 sha256');
    }
    const value = requireString(checksum.value, `${path}.checksum.value`).toLowerCase();
    if (!SHA256_PATTERN.test(value)) {
      throw new AssetValidationError(`${path}.checksum.value`, '必须是 64 位十六进制 SHA-256');
    }

    assets.push({
      id,
      kind: kind as AssetKind,
      path: filePath,
      format,
      source: {
        name,
        url,
        version,
        license: {
          code,
          url: licenseUrl,
          attribution,
          redistributionAllowed: license.redistributionAllowed,
        },
      },
      checksum: { algorithm: 'sha256', value },
      notes: typeof entry.notes === 'string' ? entry.notes : undefined,
    });
  }

  return {
    schemaVersion: 1,
    assets,
    notes: Array.isArray(input.notes) ? input.notes.filter((note): note is string => typeof note === 'string') : undefined,
  };
}

/**
 * 从文件读取并校验清单。
 *
 * @param manifestPath 清单路径。
 * @param options 许可约束。
 * @returns 清单。
 */
export async function loadManifest(manifestPath: string, options: ValidateOptions = {}): Promise<AssetManifest> {
  const text = await readFile(manifestPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new AssetValidationError('manifest', `不是合法 JSON：${String(error)}`);
  }
  return validateManifest(parsed, options);
}

/**
 * 计算文件 SHA-256。
 *
 * @param filePath 文件路径。
 * @returns 64 位小写十六进制。
 */
export async function sha256File(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 校验文件是否与清单一致（导入前必须调用）。
 *
 * @param entry 清单条目。
 * @param filePath 实际文件路径。
 */
export async function assertChecksum(entry: AssetEntry, filePath: string): Promise<void> {
  const actual = await sha256File(filePath);
  if (actual !== entry.checksum.value) {
    throw new AssetValidationError(
      'checksum',
      `文件与清单不一致：期望 ${entry.checksum.value}，实际 ${actual}`,
    );
  }
}

/**
 * 断言该条目允许被当前动作使用。
 *
 * @param entry 清单条目。
 * @param options 约束（许可白名单/是否要求可再分发）。
 */
export function assertEntryUsable(entry: AssetEntry, options: ValidateOptions = {}): void {
  if (options.allowedLicenses !== undefined && !options.allowedLicenses.includes(entry.source.license.code)) {
    throw new AssetValidationError(
      'source.license.code',
      `许可 ${entry.source.license.code} 不在允许列表（${options.allowedLicenses.join(', ')}）中`,
    );
  }
  if (options.requireRedistribution === true && !entry.source.license.redistributionAllowed) {
    throw new AssetValidationError('source.license', `许可 ${entry.source.license.code} 不允许再分发`);
  }
}
