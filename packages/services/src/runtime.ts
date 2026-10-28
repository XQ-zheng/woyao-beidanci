/**
 * 服务运行时装配器：把 `ServiceContext` + 少量外壳参数装配成 9 个服务实例。
 *
 * 为什么集中在这里而不是让页面各自 `createXxxService`：九个服务之间有明确的依赖
 * （study 依赖 settings；content/association 依赖 online），各自建一套会得到“设置改了
 * 学习排期不跟着变”的隐形分叉。这里**只建一次、按依赖顺序组装**，保证注入的是同一实例。
 *
 * Web 壳在浏览器里拿不到 SQLite，所以真正的 `ServiceContext` 由 Task 7（Electron 主进程
 * 经 IPC 桥）注入；本文件只负责“给定 context 就装配出全部服务”，不关心 context 从哪来。
 */

import { LOCAL_OWNER_SCOPE } from '@woyao/data';

import { createAssociationService, type AssociationService } from './associationService';
import { createAuthService, type AuthService } from './authService';
import { createContentService, type ContentService } from './contentService';
import { createExportService, type ExportService } from './exportService';
import { createImportService, type ImportService } from './importService';
import { createLibraryService, type LibraryService } from './libraryService';
import { createOnlineService, type OnlineService } from './onlineService';
import type { ServiceContext } from './ports';
import { createReportService, type ReportService } from './reportService';
import { createSettingsService, type SettingsService } from './settingsService';
import { createStudyService, type StudyService } from './studyService';
import { createSyncService, type SyncService } from './syncService';

/** 应用服务全家桶（页面只通过 `useServices()` 拿到它，不直接 import 具体实例）。 */
export interface Services {
  readonly settings: SettingsService;
  readonly library: LibraryService;
  readonly import: ImportService;
  readonly study: StudyService;
  readonly report: ReportService;
  readonly content: ContentService;
  readonly online: OnlineService;
  readonly association: AssociationService;
  readonly sync: SyncService;
  readonly auth: AuthService;
  readonly export: ExportService;
}

/** 装配参数。 */
export interface CreateRuntimeOptions {
  readonly context: ServiceContext;
  /** 计划/历史折算的缺省时区（外壳传 `Intl.DateTimeFormat().resolvedOptions().timeZone`）。 */
  readonly defaultTimeZone: string;
  /** 归属范围：未登录 `LOCAL`，登录后 `acct:<id>`。缺省 `LOCAL`。 */
  readonly ownerScope?: string;
}

/**
 * 装配 9 个服务。
 *
 * 依赖顺序（不能乱）：
 * 1. settings / library（无依赖）；
 * 2. online（content / association 依赖它）；
 * 3. study（依赖 settings）；
 * 4. content / association（依赖 online）；
 * 5. report / sync / auth / export（无服务间依赖）。
 *
 * @param options 上下文、时区与归属范围。
 * @returns 服务全家桶。
 */
export function createServiceRuntime(options: CreateRuntimeOptions): Services {
  const { context, defaultTimeZone } = options;
  const ownerScope = options.ownerScope ?? LOCAL_OWNER_SCOPE;

  const settings = createSettingsService({ context, defaultTimeZone });
  const library = createLibraryService({ context, ownerScope });
  const importService = createImportService({ context, library, ownerScope });
  const online = createOnlineService({ context });
  const study = createStudyService({ context, settings, ownerScope });
  const content = createContentService({
    context,
    contentCache: context.repos.contentCache,
    online,
  });
  const association = createAssociationService({
    context,
    associations: context.repos.associations,
    online,
    ownerScope,
  });
  const report = createReportService({ context });
  const sync = createSyncService({ context });
  const auth = createAuthService({ context });
  const exportService = createExportService({ context, defaultTimeZone });

  return {
    settings,
    library,
    import: importService,
    study,
    report,
    content,
    online,
    association,
    sync,
    auth,
    export: exportService,
  };
}
