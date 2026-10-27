/**
 * 自定义 `app://` 协议：让打包后的页面用正经 origin 加载。
 *
 * 为什么不用 `file://`：Chromium 对 `file://` 下的 ES module 走 CORS 检查（origin 为 null），
 * 产物里的 `<script type="module">` 会被直接拒绝。把文件挂到一个注册为标准 scheme 的
 * 协议上，既保住 `webSecurity: true`，又不用为加载本地页面关掉同源策略。
 */
import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** 协议名与主机名。 */
export const APP_SCHEME = 'app';
export const APP_HOST = 'bundle';

/**
 * 在 app ready **之前**声明协议特权（Electron 要求此时注册）。
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/**
 * 在 app ready **之后**挂上处理器，把 `app://bundle/...` 映射到 webRoot 下的文件。
 *
 * @param webRoot 打包后的 web 产物目录（含 index.html）。
 */
export function serveAppProtocol(webRoot: string): void {
  const root = path.resolve(webRoot);

  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) {
      return new Response('Not Found', { status: 404 });
    }
    const relative = decodeURIComponent(url.pathname);
    const requested = path.resolve(root, `.${relative === '/' ? '/index.html' : relative}`);
    // 目录穿越防护：只允许读 webRoot 里的文件。
    if (!requested.startsWith(root + path.sep) && requested !== path.join(root, 'index.html')) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const body = await readFile(requested);
      return new Response(body, { headers: { 'content-type': contentTypeOf(requested) } });
    } catch (error: unknown) {
      console.error('[woyao] app:// 读取失败', requested, error);
      return new Response('Not Found', { status: 404 });
    }
  });
}

/**
 * 按扩展名给出 Content-Type。
 *
 * 少了它 Chromium 会拒绝把 .js 当模块执行（严格 MIME 检查），页面白屏但控制台只有一条
 * “Failed to load module script”。
 *
 * @param file 文件路径。
 * @returns MIME 类型。
 */
function contentTypeOf(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

/** 打包后的入口地址。 */
export const APP_ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;
