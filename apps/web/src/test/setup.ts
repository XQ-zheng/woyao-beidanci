import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

/**
 * 放宽 `findBy*` 的默认等待时间（1s → 5s）。
 *
 * 本仓的 web 测试是懒加载页 + MUI 主题，首次模块转换在冷启动时可能超过 1 秒；
 * 并行跑多个 workspace 时更容易踩线。放宽只影响“等多久”，不改变断言内容，
 * 真正的失败仍会让用例在 5 秒后报错。
 */
configure({ asyncUtilTimeout: 5000 });
