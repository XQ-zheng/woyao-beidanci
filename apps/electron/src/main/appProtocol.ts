/**
 * 自定义 `app://` 协议：让打包后的页面用正经 origin 加载。
 *
 * 为什么不用 `file://`：Chromium 对 `file://` 下的 ES module 走 CORS 检查（origin 为 null），
 * 产物里的 `<script type="module">` 会被直接拒绝。把文件挂到一个注册为标准 scheme 的
 * 协议上，既保住 `webSecurity: true`，又不用为加载本地页面关掉同源策略。
 */
import { protocol } from 'electron';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
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
    const file = await resolveSpaFile(root, requested);
    if (file === null) {
      return new Response('Not Found', { status: 404 });
    }
    try {
      const body = await readFile(file);
      return new Response(body, { headers: { 'content-type': contentTypeOf(file) } });
    } catch (error: unknown) {
      console.error('[woyao] app:// 读取失败', file, error);
      return new Response('Not Found', { status: 404 });
    }
  });
}

/**
 * 把请求路径解析成真实文件；找不到且看起来是路由（无扩展名）时回退到 `index.html`。
 *
 * 为什么需要回退：界面用 `BrowserRouter`，打包后地址是 `app://bundle/settings`。
 * 用户在窗口里刷新（或者未来做深链接）时，协议层收到的是没有扩展名的路径，
 * 直接 404 会让整个窗口变成 Chromium 的错误页——看起来就像“软件坏了”。
 *
 * @param root web 产物根目录。
 * @param requested 已解析且通过穿越检查的目标路径。
 * @returns 可以读取的文件路径；确实不存在时返回 null。
 */
async function resolveSpaFile(root: string, requested: string): Promise<string | null> {
  if (await isReadableFile(requested)) {
    return requested;
  }
  if (path.extname(requested) !== '') {
    console.error('[woyao] app:// 资源不存在', requested);
    return null;
  }
  const entry = path.join(root, 'index.html');
  if (await isReadableFile(entry)) {
    return entry;
  }
  console.error('[woyao] app:// 回退 index.html 失败，产物目录可能不完整', entry);
  return null;
}

/**
 * 判断路径是否是可读文件。
 *
 * @param target 绝对路径。
 * @returns 是否可读。
 */
async function isReadableFile(target: string): Promise<boolean> {
  try {
    await access(target, constants.R_OK);
    return true;
  } catch {
    return false;
  }
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
