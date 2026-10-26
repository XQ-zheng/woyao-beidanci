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

/** 默认落地页。 */
export const defaultRoutePath = '/today';
