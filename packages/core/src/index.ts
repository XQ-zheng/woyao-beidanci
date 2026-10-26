/**
 * `@woyao/core` 的公开入口。
 *
 * 核心包是纯 TypeScript 领域层：不依赖 React / Electron / Capacitor / 网络，
 * 时间与随机性全部由调用方注入，因此桌面与移动端得到完全一致的学习结果。
 */

export * from './clock';
export * from './models';
export * from './queue';
export * from './scheduler';
