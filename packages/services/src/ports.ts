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
  LearningRepository,
  SettingsRepository,
  SyncRepository,
  WordRepository,
} from '@woyao/data';

/**
 * 把同步方法映射成返回 `Promise` 的异步方法。
 *
 * 只映射方法（`T[K]` 是函数）的键；非方法键在本仓库的四个仓储里不存在，
 * 但保留这条过滤可以让「以后给仓储加个常量」不会静默变成 `never`。
 */
export type Asyncify<T> = {
  [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: T[K] extends (
    ...args: infer A
  ) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

/** 四个仓储的异步视图。 */
export interface AsyncRepositories {
  readonly words: Asyncify<WordRepository>;
  readonly learning: Asyncify<LearningRepository>;
  readonly sync: Asyncify<SyncRepository>;
  readonly settings: Asyncify<SettingsRepository>;
}

/** 同步仓储集合（`@woyao/data` 的四个工厂产出）。 */
export interface SyncRepositories {
  readonly words: WordRepository;
  readonly learning: LearningRepository;
  readonly sync: SyncRepository;
  readonly settings: SettingsRepository;
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
 * @param input 四个同步仓储。
 * @returns 四个异步仓储。
 */
export function asyncifyRepositories(input: SyncRepositories): AsyncRepositories {
  return {
    words: asyncifyMethods(input.words),
    learning: asyncifyMethods(input.learning),
    sync: asyncifyMethods(input.sync),
    settings: asyncifyMethods(input.settings),
  };
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

/** 服务运行上下文：所有服务共享这一份依赖。 */
export interface ServiceContext {
  readonly repos: AsyncRepositories;
  readonly clock: Clock;
  readonly ids: IdGeneratorPort;
  readonly device: DeviceInfoPort;
  readonly log: LoggerPort;
}
