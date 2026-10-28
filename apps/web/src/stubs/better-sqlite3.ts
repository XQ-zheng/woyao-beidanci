/**
 * `better-sqlite3` 的浏览器端占位模块（仅被 `apps/web/vite.config.ts` 的 alias 使用）。
 *
 * 背景：渲染进程永远不该碰 SQLite——桌面端页面通过 IPC 白名单访问主进程，
 * 网页模式下 `services` 为 `null`。但 `@woyao/services` 的桶导出会经
 * `libraryService`/`runtime` 的**值导入**（`LOCAL_OWNER_SCOPE`）把
 * `@woyao/data` 的入口拖进 web 构建，其中 `connection.ts` 顶层
 * `import Database from 'better-sqlite3'` 会让打包器把它的 CommonJS 壳
 * 一起塞进浏览器 chunk。该壳在模块求值期就会执行
 * `const { promisify } = require('node:util')` 之类的 Node 调用，在渲染
 * 进程里得到空对象，随即抛 `TypeError: i is not a function`，React 根本
 * 挂载不上——用户看到的就是「只剩菜单栏的空白窗口」。
 *
 * 本桩保持与真实驱动相同的「默认导出一个类」形状：模块求值绝对安全；
 * 万一未来有代码真的在渲染进程实例化它，会在第一时间收到一句可读的
 * 错误，而不是沉默的空对象解构崩溃。
 */

const RENDERER_ERROR =
  'better-sqlite3 只能在桌面主进程使用；渲染进程不应触碰数据库（请检查这条调用链是否绕过了 IPC）。';

export default class BetterSqlite3RendererStub {
  constructor() {
    throw new Error(RENDERER_ERROR);
  }
}
