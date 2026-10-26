/**
 * `@woyao/services` 的公开入口。
 *
 * 分层约定：
 * - `ports`：依赖注入边界（异步仓储、时钟、id、设备号、日志）；
 * - `dto`：对外视图类型与 zod 入参校验；
 * - `errors`：稳定的服务层错误码（`VALIDATION_FAILED` / `NOT_FOUND` / `CONFLICT` / `NOT_CONFIGURED`）；
 * - `frequencyView`：词频视图的**唯一**装配口径（词库与学习卡片共用）；
 * - `settingsService` / `libraryService`：5A 的设置与词库服务；
 * - `studyService` / `reportService`：5B 的学习闭环与报表服务。
 *
 * 5C 会补内容、云同步、认证与导出服务；它们共用本文件导出的 `ServiceContext` 与错误类型。
 */

export * from './associationService';
export * from './contentService';
export * from './dto';
export * from './errors';
export * from './frequencyView';
export * from './libraryService';
export * from './onlineService';
export * from './ports';
export * from './reportService';
export * from './settingsService';
export * from './sourceBootstrap';
export * from './studyService';
