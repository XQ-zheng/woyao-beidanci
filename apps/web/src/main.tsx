import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { bootstrap } from './bootstrap';
import { createIpcServices, type WoyaoBridge } from './services/ipcServices';
import './styles.css';

const container = document.getElementById('root');

if (container === null) {
  throw new Error('找不到根容器 #root，index.html 可能已被破坏。');
}

/**
 * 桌面端由 preload 注入 `window.woyao`；浏览器里没有它，服务保持 `null`
 * （页面显示“数据服务未接入”）。这条分支让同一个构建产物既能开网页也能进桌面壳。
 */
const bridge = (globalThis as { woyao?: WoyaoBridge }).woyao;
const services = bridge === undefined ? null : createIpcServices(bridge);

bootstrap();

createRoot(container).render(
  <StrictMode>
    <App services={services} />
  </StrictMode>,
);
