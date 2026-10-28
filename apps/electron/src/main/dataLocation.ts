/**
 * 数据储存位置管理：解析默认数据目录、读写位置引导文件、迁移数据。
 *
 * 背景（2026-10-28 用户需求）：所有数据默认存到
 * `E:\我要背单词——相关文件夹`，为 C 盘节省空间；设置页可改，改时三重
 * 确认并自动迁移。
 *
 * 设计：
 * - 数据目录的「记忆」不能存在数据库里（数据库本身在数据目录里，鸡生蛋），
 *   所以用**引导文件** `resources/data-location.json`，跟程序走。
 * - 解析优先级：环境变量 `WOYAO_DATA_DIR`（调试用）> 引导文件 >
 *   默认值（E 盘可写则 `E:\我要背单词——相关文件夹`，否则 Electron 默认）。
 * - 主进程启动最早调用 `applyDataDir(resolveDataDir())`，一次
 *   `app.setPath('userData', ...)` 让数据库/日志/凭据/Local Storage 全部跟随。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

/** 用户指定的默认数据根目录。 */
export const PREFERRED_DATA_DIR = 'E:\\我要背单词——相关文件夹';

/** 位置引导文件名（位于 resources/ 下，跟程序走）。 */
const LOCATION_HINT_FILE = 'data-location.json';

/** 引导文件结构。 */
interface LocationHint {
  readonly dataDir: string;
}

/** 迁移时随数据一起搬的**文件**白名单（缓存类不搬，可自动重建）。 */
const MIGRATE_FILES: readonly string[] = [
  'woyao.sqlite3',
  'woyao.sqlite3-wal',
  'woyao.sqlite3-shm',
  'device-id',
  'cloud-auth.bin',
  'cloud-config.json',
  'Preferences',
  'Local State',
];

/** 迁移时随数据一起搬的**目录**白名单（递归复制）。 */
const MIGRATE_DIRS: readonly string[] = ['logs', 'Local Storage', 'Session Storage', 'Shared Dictionary'];

/**
 * 引导文件绝对路径（打包态在 resources/ 下；开发态不存在、返回 null 语义由读取方处理）。
 *
 * @returns 引导文件路径。
 */
export function hintFilePath(): string {
  return path.join(process.resourcesPath ?? '', LOCATION_HINT_FILE);
}

/**
 * 读引导文件里记录的数据目录。
 *
 * @returns 数据目录路径；没有引导文件或内容非法时返回 null。
 */
export function readLocationHint(): string | null {
  const file = hintFilePath();
  if (!process.resourcesPath || !existsSync(file)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as LocationHint;
    return typeof parsed.dataDir === 'string' && parsed.dataDir.trim() !== '' ? parsed.dataDir : null;
  } catch {
    return null;
  }
}

/**
 * 把数据目录写进引导文件（更改位置成功后调用，下次启动生效）。
 *
 * @param dataDir 新数据目录。
 */
export function writeLocationHint(dataDir: string): void {
  const file = hintFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ dataDir } satisfies LocationHint, null, 2)}\n`, 'utf8');
}

/**
 * 确保目录存在且可写（写探针文件再删掉）。
 *
 * @param dir 目录绝对路径。
 * @returns 错误消息（不可用时）；可用返回 null。
 */
export function ensureWritableDir(dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.woyao-write-probe');
    writeFileSync(probe, 'ok', 'utf8');
    rmSync(probe);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * 解析本次运行的数据目录（优先级见文件头）。
 *
 * @returns 数据目录绝对路径。
 */
export function resolveDataDir(): string {
  const fromEnv = process.env.WOYAO_DATA_DIR;
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return fromEnv.trim();
  }
  const hint = readLocationHint();
  if (hint !== null) {
    return hint;
  }
  // 默认：E 盘存在且可写则用用户指定目录，否则退回 Electron 默认（C 盘）。
  if (existsSync('E:\\') && ensureWritableDir(PREFERRED_DATA_DIR) === null) {
    return PREFERRED_DATA_DIR;
  }
  return app.getPath('userData');
}

/**
 * 把 userData 重定向到指定目录。
 *
 * **必须在 `app.ready` 之前、且在任何 `getPath('userData')` 调用之前**执行；
 * 数据库、日志、凭据、Local Storage 会全部跟随。
 *
 * @param dir 数据目录绝对路径。
 */
export function applyDataDir(dir: string): void {
  app.setPath('userData', dir);
}

/** 迁移成功报告。 */
export interface MigrationReport {
  /** 搬过去的条目（文件名或「目录/」）。 */
  readonly files: readonly string[];
  /** 总字节数。 */
  readonly bytes: number;
}

/** 一个目录的总大小（字节）。 */
function sizeOfDir(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stats = statSync(full);
    total += stats.isDirectory() ? sizeOfDir(full) : stats.size;
  }
  return total;
}

/**
 * 把数据文件从旧目录复制到新目录（**复制**而非移动：失败时旧数据完好无损）。
 *
 * 必须在数据库连接**已关闭**之后调用（WAL checkpoint 落盘），否则复制的
 * 数据库可能缺最新写入。缓存类目录（Cache/GPUCache 等）不搬——新位置会
 * 自动重建。
 *
 * @param fromDir 旧数据目录。
 * @param toDir 新数据目录。
 * @returns 成功返回报告；失败返回错误消息（字符串）。
 */
export function migrateDataFiles(fromDir: string, toDir: string): MigrationReport | string {
  if (path.resolve(fromDir) === path.resolve(toDir)) {
    return '新位置与当前位置相同，无需迁移。';
  }
  const dirError = ensureWritableDir(toDir);
  if (dirError !== null) {
    return `新位置不可用：${dirError}`;
  }
  const files: string[] = [];
  let bytes = 0;
  try {
    for (const name of MIGRATE_FILES) {
      const source = path.join(fromDir, name);
      if (!existsSync(source)) {
        continue;
      }
      copyFileSync(source, path.join(toDir, name));
      files.push(name);
      bytes += statSync(source).size;
    }
    for (const name of MIGRATE_DIRS) {
      const source = path.join(fromDir, name);
      if (!existsSync(source) || !statSync(source).isDirectory()) {
        continue;
      }
      cpSync(source, path.join(toDir, name), { recursive: true, force: true });
      files.push(`${name}/`);
      bytes += sizeOfDir(source);
    }
    // 校验：数据库是命根子，必须存在且大小一致（源里有的话）。
    const sourceDb = path.join(fromDir, 'woyao.sqlite3');
    if (existsSync(sourceDb)) {
      const targetDb = path.join(toDir, 'woyao.sqlite3');
      if (!existsSync(targetDb) || statSync(targetDb).size !== statSync(sourceDb).size) {
        return '迁移校验失败：数据库文件不完整（大小不一致）。旧数据未受影响，可重试。';
      }
    }
    return { files, bytes };
  } catch (error) {
    return `迁移失败：${error instanceof Error ? error.message : String(error)}`;
  }
}
