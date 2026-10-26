import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { bootstrap } from './bootstrap';
import './styles.css';

const container = document.getElementById('root');

if (container === null) {
  throw new Error('找不到根容器 #root，index.html 可能已被破坏。');
}

bootstrap();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
