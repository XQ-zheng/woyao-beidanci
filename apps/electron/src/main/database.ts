/**
 * 主进程的数据库与依赖装配。
 *
 * 只有这一层碰 `better-sqlite3`、文件系统与系统 API；服务层看到的全是端口。
 * 数据库放在 `userData` 下（不是安装目录：安装目录通常只读，且升级会覆盖）。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  asyncifyRepositories,
  createNoopCloud,
  createServiceRuntime,
  NotConfiguredError,
  type DocumentWriterPort,
  type HttpPort,
  type Services,
  type ServiceContext,
} from '@woyao/services';
import {
  createAssociationRepository,
  createContentCacheRepository,
  createLearningRepository,
  createSettingsRepository,
  createSyncRepository,
  createWordRepository,
  migrate,
  openDatabase,
  type SqliteDatabase,
} from '@woyao/data';

/** 打开后的运行时：服务 + 关闭数据库的收尾函数。 */
export interface DesktopRuntime {
  readonly services: Services;
  readonly context: ServiceContext;
  /** 关闭数据库连接（退出前调用）。 */
  close(): void;
}

/** 装配参数。 */
export interface CreateDesktopRuntimeOptions {
  /** 数据目录（通常是 `app.getPath('userData')`）。 */
  readonly userDataPath: string;
  /** IANA 时区（`Intl.DateTimeFormat().resolvedOptions().timeZone`）。 */
  readonly timeZone: string;
  /** 是否联网（由 Electron 的 `net.isOnline()` 提供）。 */
  readonly isOnline: () => boolean;
  /** 是否允许网络请求（离线/隐私模式下返回 false）。 */
  readonly networkEnabled?: () => boolean;
}

/**
 * 读取或创建本机设备 id。
 *
 * 设备号参与同步元数据：每次启动都换一个，云端就会把同一台机器当成多台，
 * 冲突与去重都会算错。所以落盘一次、之后复用。
 *
 * @param userDataPath 数据目录。
 * @returns 稳定的设备 id。
 */
function loadDeviceId(userDataPath: string): string {
  const file = path.join(userDataPath, 'device-id');
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length > 0) {
      return existing;
    }
  }
  mkdirSync(userDataPath, { recursive: true });
  const created = randomUUID();
  writeFileSync(file, created, 'utf8');
  return created;
}

/** 用 Node 的 `fetch` 实现 HttpPort（带超时），服务层不直接联网。 */
function createHttpPort(isOnline: () => boolean): HttpPort {
  const request = async (url: string, headers: Record<string, string> | undefined, timeoutMs: number) => {
    if (!isOnline()) {
      throw new Error('当前处于离线状态');
    }
    return fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  };

  return {
    async getJson(input) {
      const response = await request(input.url, input.headers, input.timeoutMs ?? 8000);
      return { status: response.status, data: await response.json() };
    },
    async getText(input) {
      const response = await request(input.url, input.headers, input.timeoutMs ?? 8000);
      return { status: response.status, body: await response.text() };
    },
  };
}

/** 导出器尚未接入（Task 8）：明确抛 NOT_CONFIGURED，不假装写出了文件。 */
function createPendingWriter(): DocumentWriterPort {
  return {
    async write() {
      throw new NotConfiguredError('export', '本地导出器尚未接入（Task 8）');
    },
  };
}

/**
 * 打开数据库并装配 9 个服务。
 *
 * @param options 数据目录、时区与联网状态。
 * @returns 运行时（服务、上下文与关闭函数）。
 */
export function createDesktopRuntime(options: CreateDesktopRuntimeOptions): DesktopRuntime {
  const { userDataPath, timeZone } = options;
  mkdirSync(userDataPath, { recursive: true });

  const db: SqliteDatabase = openDatabase(path.join(userDataPath, 'woyao.sqlite3'));
  migrate(db);

  const repos = asyncifyRepositories({
    words: createWordRepository(db),
    learning: createLearningRepository(db),
    settings: createSettingsRepository(db),
    sync: createSyncRepository(db),
    associations: createAssociationRepository(db),
    contentCache: createContentCacheRepository(db),
  });

  const context: ServiceContext = {
    repos,
    clock: { now: () => new Date() },
    ids: { nextId: () => randomUUID() },
    device: { deviceId: () => loadDeviceId(userDataPath) },
    log: {
      warn: (message, detail) => {
        console.warn(`[woyao] ${message}`, detail ?? '');
      },
    },
    http: createHttpPort(options.isOnline),
    network: { isOnline: options.isOnline },
    // 云服务在 Task 10 激活；现在注入的是“未配置”，服务层据此如实返回 NOT_CONFIGURED。
    cloud: createNoopCloud(),
    writer: createPendingWriter(),
  };

  const services = createServiceRuntime({ context, defaultTimeZone: timeZone });

  return {
    services,
    context,
    close: () => {
      db.close();
    },
  };
}
