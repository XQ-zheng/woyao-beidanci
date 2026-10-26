/**
 * `@woyao/services` 的公开入口。
 *
 * 分层约定：
 * - `ports`：依赖注入边界（异步仓储、时钟、id、设备号、日志）；
 * - `dto`：对外视图类型与 zod 入参校验；
 * - `errors`：稳定的服务层错误码（`VALIDATION_FAILED` / `NOT_FOUND` / `CONFLICT` / `NOT_CONFIGURED`）；
 * - `settingsService` / `libraryService`：5A 的两个服务。
 *
 * 5B 会补 `studyService` / `reportService`，5C 补内容、云同步、认证与导出服务；
 * 它们共用本文件导出的 `ServiceContext` 与错误类型。
 */

export * from './dto';
export * from './errors';
export * from './libraryService';
export * from './ports';
export * from './settingsService';
