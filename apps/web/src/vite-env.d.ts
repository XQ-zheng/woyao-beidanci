/// <reference types="vite/client" />

/**
 * 由 vite.config.ts 的 `define` 在构建、开发与测试时注入，
 * 取值来自根 package.json 的 `version`（唯一版本来源）。
 * 声明放在没有 import/export 的 .d.ts 里，因此是全局声明。
 */
declare const __APP_VERSION__: string;
