/**
 * 学习页布局测量入口（**仅开发用**，不参与生产构建）。
 *
 * jsdom 不做布局，`getBoundingClientRect()` 全是 0，不能拿它冒充“两种视口无遮挡”的
 * 验收结论。这里用真实浏览器加载真实 `<App>`（真外壳、真路由、真 MUI 主题），
 * 只把数据服务换成假实现，从而能在 1280×800 / 390×844 下量到真实矩形。
 *
 * 打开方式：`npm run dev` 后访问 `/dev/study-harness.html`。
 */
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles.css';
import { createFakeServices, defaultSettings, makeCard, makeSession } from './test/fakeServices';

// StudyPage 支持 `?deckId=` 直达（刷新/无路由 state 时重建会话）；
// 先改地址再挂载，BrowserRouter 才能按 /study 渲染。
window.history.replaceState({}, '', '/study?deckId=deck-cet4');

const cards = [
  makeCard(),
  makeCard({
    wordId: 'w-brief',
    lemma: 'brief',
    prompt: 'brief',
    answer: '简短的',
    options: ['简短的', '昂贵的', '复杂的', '安静的'],
  }),
];

const services = createFakeServices({
  settings: {
    getSnapshot: async () => ({ ...defaultSettings, questionStyle: 'CHOICE', volume: 0.8 }),
  },
  study: {
    startSession: async () => makeSession(cards),
  },
});

const container = document.getElementById('root');
if (container === null) {
  throw new Error('找不到根容器 #root');
}

createRoot(container).render(<App services={services} />);
