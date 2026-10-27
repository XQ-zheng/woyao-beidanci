/**
 * 服务层端口（依赖注入的边界）。
 *
 * 三条设计约束（与 brief §0 对应）：
 * 1. **服务层不碰平台 API**：时间靠 `Clock`、id 靠 `IdGeneratorPort`、设备号靠 `DeviceInfoPort`、
 *    日志靠 `LoggerPort`。因此本包既不 `import 'node:*'`，也没有 `new Date()` / `fetch` / `window`。
 * 2. **仓储一律异步**：不是为了桌面端，而是因为 Task 11 的 `@capacitor-community/sqlite` 只有异步 API。
 *    现在就把端口定义成异步，移动端换实现时 9 个服务不用重写。
 * 3. **同步仓储 → 异步端口**只做一层极薄的包装（`asyncifyRepositories`），
 *    异常实例必须原样冒泡：上层靠 `instanceof` 与 `code` 分支，包一层 `new Error(...)`
 *    就会把“表单填错”和“代码有 bug”混成一种。
 */

import type { Clock } from '@woyao/core';
import type {
  AssociationRepository,
  ContentCacheRepository,
  EntityChange,
  EntityType,
  LearningRepository,
  SettingsRepository,
  SyncRepository,
  WordRepository,
} from '@woyao/data';

// 仅类型引用：ExportModel/ExportReceipt 定义在 exportService.ts，这里是 type-only import，
// 编译期擦除，不产生运行时环（exportService 运行时 import 本文件）。
import type { ExportModel, ExportReceipt } from './exportService';

/**
 * 把同步方法映射成返回 `Promise` 的异步方法。
 *
 * 只映射方法（`T[K]` 是函数）的键；非方法键在本仓库的仓储里不存在，
 * 但保留这条过滤可以让「以后给仓储加个常量」不会静默变成 `never`。
 */
export type Asyncify<T> = {
  [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: T[K] extends (
    ...args: infer A
  ) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

/** 六个仓储的异步视图。 */
export interface AsyncRepositories {
  readonly words: Asyncify<WordRepository>;
  readonly learning: Asyncify<LearningRepository>;
  readonly sync: Asyncify<SyncRepository>;
  readonly settings: Asyncify<SettingsRepository>;
  readonly associations: Asyncify<AssociationRepository>;
  readonly contentCache: Asyncify<ContentCacheRepository>;
}

/** 同步仓储集合（`@woyao/data` 的六个工厂产出）。 */
export interface SyncRepositories {
  readonly words: WordRepository;
  readonly learning: LearningRepository;
  readonly sync: SyncRepository;
  readonly settings: SettingsRepository;
  readonly associations: AssociationRepository;
  readonly contentCache: ContentCacheRepository;
}

/**
 * 把一个对象上的方法逐个包成 `async`。
 *
 * 关键细节：`await` 一个同步返回值与直接返回值对调用方无差别，但**异常必须先落到
 * 被 `await` 的 Promise 上**——所以这里是 `async` 函数直接调用原方法，
 * 而不是 `Promise.resolve().then(...)` 之后再 try/catch：前者让原异常自然冒泡，
 * 栈里能追到仓储内部；后者会把栈截断在包装层。
 *
 * @param source 同步实现（仓储对象）。
 * @returns 只含同名异步方法的对象。
 */
function asyncifyMethods<T extends object>(source: T): Asyncify<T> {
  const wrapped: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    const value = (source as Record<string, unknown>)[key];
    if (typeof value !== 'function') {
      continue;
    }
    const method = value as (...args: unknown[]) => unknown;
    wrapped[key] = async (...args: unknown[]): Promise<unknown> => method.apply(source, args);
  }
  return wrapped as Asyncify<T>;
}

/**
 * 把 Task 4 的同步数据层包成异步端口。
 *
 * 每个仓储各自包装，**不共享**任何可变状态：包装层只做转发，
 * 事务边界仍然由数据层的方法自己控制（服务层不再套一层事务）。
 *
 * @param input 六个同步仓储。
 * @returns 六个异步仓储。
 */
export function asyncifyRepositories(input: SyncRepositories): AsyncRepositories {
  return {
    words: asyncifyMethods(input.words),
    learning: asyncifyMethods(input.learning),
    sync: asyncifyMethods(input.sync),
    settings: asyncifyMethods(input.settings),
    associations: asyncifyMethods(input.associations),
    contentCache: asyncifyMethods(input.contentCache),
  };
}

/**
 * 把任意同步仓储包成异步视图。
 *
 * `associationRepository` / `contentCacheRepository` 已进入 `AsyncRepositories`
 * （6A 装配 `contentService` / `associationService` 需要），但本工具仍保留给
 * 测试里单独包装某个仓储的场合。
 *
 * @param source 同步仓储。
 * @returns 只含同名异步方法的对象。
 */
export function asyncify<T extends object>(source: T): Asyncify<T> {
  return asyncifyMethods(source);
}

/** id 生成端口（外壳注入：桌面用 uuid，移动端可换成设备侧实现）。 */
export interface IdGeneratorPort {
  nextId(): string;
}

/** 日志端口：只提供 `warn`，因为服务层不该用日志代替错误返回。 */
export interface LoggerPort {
  warn(message: string, detail?: unknown): void;
}

/**
 * 设备标识端口。
 *
 * 桌面端取主机名散列、移动端取安装 id——**由外壳注入**，服务层不自己算：
 * 设备号参与同步元数据，端上算错一次就会在云端产生两个设备。
 */
export interface DeviceInfoPort {
  deviceId(): string;
}

/**
 * HTTP 端口（外壳注入）。
 *
 * 服务层**禁止 `fetch`/`node:*`**：网络能力由外壳（Electron 主进程 / WebView 桥）提供。
 * 只暴露 `getJson`/`getText` 两种最小形态，够词典/翻译/联想用即可。
 * **隐私红线**：调用方只传用户主动查的那一个词的 URL，绝不在 headers 里夹带 token/历史。
 */
export interface HttpPort {
  getJson(input: {
    url: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<{ status: number; data: unknown }>;
  getText(input: {
    url: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<{ status: number; body: string }>;
}

/**
 * LLM 端口（外壳注入）。
 *
 * 只用于“翻译”这一类**明确标 AI 生成**的能力；结果不写进词典义项。
 * 未配置（`null`/未提供实现）时，服务层抛 `NotConfiguredError('llm')`。
 */
export interface LlmPort {
  translate(input: { text: string; target: 'zh' | 'en' }): Promise<string>;
}

/** 网络可达性端口（外壳注入，决定降级路径是否走在线）。 */
export interface NetworkMonitorPort {
  isOnline(): boolean;
}

/** 一次登录返回的会话（服务层只透传，**不存 token**——安全存储在 Task 7/10）。 */
export interface AuthSession {
  readonly userId: string;
  readonly token: string;
  readonly refreshToken: string;
  readonly expiresAt: string | null;
}

/** 登录方式。 */
export interface SignInInput {
  readonly provider: 'email' | 'phone' | 'wechat' | 'qq';
  readonly credential: string;
}

/** 认证网关（外壳注入的云端认证实现；WorkBuddy Cloud 未激活时为 `null`）。 */
export interface AuthGateway {
  signIn(input: SignInInput): Promise<AuthSession>;
  refresh(session: AuthSession): Promise<AuthSession>;
  signOut(session: AuthSession): Promise<void>;
}

/** 远端的一条变更（pull 返回）。 */
export interface RemoteChange {
  readonly entityType: EntityType;
  readonly entityId: string;
  readonly operation: 'UPSERT' | 'DELETE';
  readonly payload: unknown;
  readonly revision: number;
  readonly deviceId: string;
}

/** pull 的一页结果。 */
export interface PullPage {
  readonly changes: RemoteChange[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** 同步网关（外壳注入的云端同步实现；WorkBuddy Cloud 未激活时为 `null`）。 */
export interface SyncGateway {
  push(change: EntityChange): Promise<'OK' | 'DUPLICATE'>;
  pull(cursor: string | null): Promise<PullPage>;
}

/**
 * 云端端口。
 *
 * `configured === false` 表示 WorkBuddy Cloud 未激活（本轮常态）：`auth`/`sync` 都是 `null`。
 * 服务层据此诚实地报 `NOT_CONFIGURED`，**绝不伪造“已登录/已同步”**。
 */
export interface CloudPort {
  readonly configured: boolean;
  readonly auth: AuthGateway | null;
  readonly sync: SyncGateway | null;
}

/** 创建一个“未配置”的云端端口（WorkBuddy Cloud 激活前的默认实现）。 */
export function createNoopCloud(): CloudPort {
  return { configured: false, auth: null, sync: null };
}

/** 导出文件格式。 */
export type ExportFormat = 'WORD' | 'PDF' | 'EXCEL';

/**
 * 文档写出端口（外壳注入，Task 8 提供 docx/exceljs/pdfkit 的真实实现）。
 *
 * 服务层只产出渲染器无关的 `ExportModel`，**不碰文件系统、不碰 node:*、不联网**；
 * 是否真正写成功由本端口回报（`ExportReceipt`），服务层不伪造“已写出”。
 */
export interface DocumentWriterPort {
  write(model: ExportModel, format: ExportFormat, destination: string): Promise<ExportReceipt>;
}

/** 服务运行上下文：所有服务共享这一份依赖。 */
export interface ServiceContext {
  readonly repos: AsyncRepositories;
  readonly clock: Clock;
  readonly ids: IdGeneratorPort;
  readonly device: DeviceInfoPort;
  readonly log: LoggerPort;
  /** 在线词典/翻译/联想的网络能力（服务层不直接 fetch）。 */
  readonly http: HttpPort;
  /**
   * AI 翻译能力。
   *
   * **可选**：外壳没接 LLM 时留 `undefined`，服务层据此抛 `NotConfiguredError('llm')`
   * 而不是假装能翻译。
   */
  readonly llm?: LlmPort;
  /** 网络可达性；离线时服务层走降级路径。 */
  readonly network: NetworkMonitorPort;
  /** 云端端口（auth + sync）；未激活时注入 `createNoopCloud()`。 */
  readonly cloud: CloudPort;
  /** 文档写出端口（导出服务用，Task 8 前注入假实现）。 */
  readonly writer: DocumentWriterPort;
}
