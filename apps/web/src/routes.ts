/**
 * 路由清单。这里只描述结构，渲染由 router.tsx 负责，
 * 避免把「导航数据」和「React 组件」混在同一个模块里。
 */
export interface AppRoute {
  /** 路由路径，同时作为导航项的 key。 */
  readonly path: string;
  /** 导航与页面标题使用的中文名称。 */
  readonly label: string;
  /** 占位说明，后续任务替换为真实页面后即可删除。 */
  readonly summary: string;
}

/** 主导航栏目（侧栏 / 底栏的 8 项）。 */
export const appRoutes: readonly AppRoute[] = [
  { path: '/today', label: '今日学习', summary: '每日新词与到期复习任务' },
  { path: '/library', label: '词库', summary: '四级、六级、考研词库与自建词库' },
  { path: '/notebook', label: '单词本', summary: '收藏的单词与自定义单词本' },
  { path: '/mistakes', label: '错词', summary: '累计答错的单词与最近错误信息' },
  { path: '/history', label: '历史', summary: '按日期、词库与训练模式查看学习记录' },
  { path: '/assessment', label: '水平评估', summary: '基于近期作答的可解释水平参考' },
  { path: '/account', label: '账号', summary: '登录、云同步与本地数据管理' },
  { path: '/settings', label: '设置', summary: '每日计划、复习节点、训练模式与外观' },
];

/**
 * 学习流程页：进路由表，但**不进**侧栏/底栏导航。
 *
 * `/study` 是逐词作答的临时页，`/review` 是本次会话的完成页；把它们塞进主导航会让
 * 8 项固定栏目变成 10 项，也会让“学习流程”被误当成可随时切入的栏目。
 */
export const flowRoutes: readonly AppRoute[] = [
  { path: '/study', label: '学习', summary: '逐词作答的学习主流程' },
  { path: '/review', label: '学习完成', summary: '本次会话的新词、复习、时长与答对数' },
];

/**
 * 流程页归属的主导航栏目。
 *
 * 流程页自身不高亮导航项，但“学习”属于“今日学习”这条主线：在 `/study`、`/review`
 * 期间让“今日学习”保持选中，用户不会觉得导航失去了位置。
 */
export const flowRouteParent: Readonly<Record<string, string>> = {
  '/study': '/today',
  '/review': '/today',
};

/** 默认落地页。 */
export const defaultRoutePath = '/today';

/**
 * 由当前路径推导“应当高亮的导航项”。
 *
 * 桌面侧栏与移动底栏**共用这一个函数**，避免两套匹配规则（6A 交付时侧栏用
 * `useMatch(end:false)`、底栏用字符串前缀）在引入子路由后给出不一致的选中态。
 *
 * 规则：先按流程页归属映射取父栏目，再按“等于或前缀匹配”找栏目，最后回落默认页。
 *
 * @param pathname 当前路径（`location.pathname`）。
 * @returns 需要高亮的主导航路径。
 */
export function activeNavPath(pathname: string): string {
  const normalize = (value: string): string =>
    value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
  const path = normalize(pathname);

  for (const [flowPath, parent] of Object.entries(flowRouteParent)) {
    if (path === flowPath || path.startsWith(`${flowPath}/`)) {
      return parent;
    }
  }

  const matched = appRoutes.find(
    (route) => path === route.path || path.startsWith(`${route.path}/`),
  );
  return matched?.path ?? defaultRoutePath;
}
