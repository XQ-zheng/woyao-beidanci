#!/usr/bin/env node
/**
 * 把「我要背单词」打成一件**用户能双击打开的 Windows 软件**。
 *
 * 一条命令做完全部事情：
 *   构建 web → 构建 Electron 主进程/preload → 组装应用目录 → 复制 Electron 运行时
 *   → 写入云公共配置 → 停掉正在运行的旧版本 → 覆盖安装到 %LOCALAPPDATA%\Programs
 *   → 建桌面与开始菜单快捷方式（图标、工作目录、描述都设好）。
 *
 * 设计取舍（为什么不直接用 electron-builder）：
 * - 只需 Windows 安装，且要**离线可复现**：直接复用 `node_modules/electron/dist` 的官方
 *   运行时，把 exe 改名放进安装目录，应用放在 `resources/app/`。没有下载步骤、没有 NSIS、
 *   没有签名工具链，失败点少；`npm ci` 装完就能打包。
 * - 不用 asar：`better-sqlite3` 是原生模块，asar 里必须 unpack，反而多一层“路径对不对”的
 *   调试成本；安装目录本来就不给用户改，压缩收益不值得这个风险。
 * - 代价是安装体积约等于 Electron 运行时（~250MB），对桌面软件来说可接受。
 *
 * 用法：
 *   npm run package:win                       # 完整流程
 *   npm run package:win -- --skip-build       # 复用已有产物（调试安装/快捷方式用）
 *   npm run package:win -- --no-rcedit        # 不尝试把图标写进 exe
 *   WOYAO_INSTALL_DIR=... npm run package:win # 换安装目录
 *
 * 注意：`.env.local` 里的 publishableKey 只写进**安装目录**的 `resources/cloud-config.json`，
 * 绝不写进仓库内任何被提交的文件，也不打印到日志。
 */
import { spawnSync } from 'node:child_process';
import { builtinModules, createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 仓库根目录。 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** 打包用的临时目录（已被 .gitignore 忽略）。 */
const buildRoot = path.join(repoRoot, 'build');

/** 组装目录：先在 build 下拼好，成功了再整体覆盖到安装目录。 */
const stagingDir = path.join(buildRoot, 'package', 'woyao-beidanci');

/** 安装目录：纯 ASCII 路径，避开中文目录带来的诡异问题。 */
const installDir =
  process.env.WOYAO_INSTALL_DIR ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'woyao-beidanci');

/** 安装后的可执行文件名（由 electron.exe 改名而来）。 */
const APP_EXE_NAME = 'woyao-beidanci.exe';

/** 界面上显示的名字：快捷方式名、产品名都用它。 */
const APP_DISPLAY_NAME = '我要背单词';

/** 应用 ID（与主进程 app.setAppUserModelId 保持一致）。 */
const APP_ID = 'com.woyao.beidanci';

/** web 产物目录（vite.config.ts 的 build.outDir）。 */
const webDistDir = path.join(repoRoot, 'dist', 'apps', 'web');

/** Electron 主进程产物目录。 */
const electronDistDir = path.join(repoRoot, 'apps', 'electron', 'dist');

/** Electron 官方运行时（`npm ci` 装完就在，无需下载）。 */
const electronRuntimeDir = path.join(repoRoot, 'node_modules', 'electron', 'dist');

/** 运行期**不能被 bundle** 的依赖：主进程产物里仍然 `require()` 它们。 */
const RUNTIME_DEPENDENCIES = [
  'better-sqlite3',
  'docx',
  'exceljs',
  'jszip',
  'pdfkit',
  'pdfjs-dist',
  'tesseract.js',
  'tesseract.js-core',
  '@tencent-ai/workbuddy-cloud-sdk',
  'zod',
];

/** 允许出现在主进程产物里的“进程内置”模块前缀。 */
const EXTERNAL_ALLOWLIST = new Set(['electron', ...RUNTIME_DEPENDENCIES]);

/** 各步骤的耗时记录，最后一起打印，便于发现哪一步拖慢了打包。 */
const timings = [];

/**
 * 解析命令行开关。
 *
 * @param {readonly string[]} argv 进程参数。
 * @returns {{skipBuild: boolean, useRcedit: boolean}} 开关。
 */
function parseArgs(argv) {
  return {
    skipBuild: argv.includes('--skip-build'),
    useRcedit: !argv.includes('--no-rcedit'),
  };
}

/**
 * 跑一个子进程，失败就抛（错误信息里带上命令行，方便定位）。
 *
 * @param {string} command 可执行文件。
 * @param {readonly string[]} args 参数。
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv}} [options] 选项。
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: 'inherit',
    // Windows 上 npm 是 .cmd，必须经 shell 才能启动。
    shell: process.platform === 'win32',
  });
  if (result.error !== undefined && result.error !== null) {
    throw new Error(`执行失败：${command} ${args.join(' ')} → ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`执行失败：${command} ${args.join(' ')}（退出码 ${String(result.status)}）`);
  }
}

/**
 * 跑一个步骤并记录耗时（任务可以是同步或异步）。
 *
 * @param {string} label 步骤名。
 * @param {() => void | Promise<void>} task 步骤实现。
 */
async function step(label, task) {
  const startedAt = Date.now();
  console.log(`\n▶ ${label}`);
  await task();
  const elapsed = Date.now() - startedAt;
  timings.push({ label, elapsed });
  console.log(`✓ ${label}（${(elapsed / 1000).toFixed(1)}s）`);
}

/**
 * 读取 `.env.local`（KEY=VALUE，# 注释）。
 *
 * @param {string} filePath 文件路径。
 * @returns {Record<string, string>} 键值对。
 */
function readEnvFile(filePath) {
  const values = {};
  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[line.slice(0, separator).trim()] = value;
  }
  return values;
}

/**
 * 从 `.env.local` 生成云公共配置。
 *
 * 缺任何一项都直接失败：静默产出一个“没有云”的包，用户看到的就是
 * “发验证码失败/云服务未配置”，而排查要从安装包倒推回源码，代价极高。
 *
 * @returns {{resourceId: string, endpoint: string, oauthRelayBaseUrl: string, publishableKey: string}} 配置。
 */
function readCloudConfig() {
  const envPath = path.join(repoRoot, '.env.local');
  if (!existsSync(envPath)) {
    throw new Error(
      [
        '缺少 .env.local，无法把云配置嵌进安装包。',
        '  修复：cp .env.example .env.local，再用 workbuddy_cloud_service 的 publicConfig 覆盖四个 VITE_WB_CLOUD_* 值。',
        '  说明：没有云配置的安装包打开账号页只会显示“云服务未配置”，手机验证码发不出去。',
      ].join('\n'),
    );
  }
  const env = readEnvFile(envPath);
  /** @type {ReadonlyArray<[string, string]>} */
  const required = [
    ['resourceId', 'VITE_WB_CLOUD_RESOURCE_ID'],
    ['endpoint', 'VITE_WB_CLOUD_ENDPOINT'],
    ['oauthRelayBaseUrl', 'VITE_WB_CLOUD_OAUTH_RELAY_BASE_URL'],
    ['publishableKey', 'VITE_WB_CLOUD_PUBLISHABLE_KEY'],
  ];
  /** @type {Record<string, string>} */
  const config = {};
  const missing = [];
  for (const [target, key] of required) {
    const value = env[key];
    if (value === undefined || value.trim() === '') {
      missing.push(key);
      continue;
    }
    config[target] = value.trim();
  }
  if (missing.length > 0) {
    throw new Error(`.env.local 缺少云配置：${missing.join(', ')}（见 .env.example）`);
  }
  if (!String(config.endpoint).startsWith('https://')) {
    throw new Error(`VITE_WB_CLOUD_ENDPOINT 必须是 https 地址，当前是 ${String(config.endpoint)}`);
  }
  return {
    resourceId: config.resourceId,
    endpoint: config.endpoint,
    oauthRelayBaseUrl: config.oauthRelayBaseUrl,
    publishableKey: config.publishableKey,
  };
}

/**
 * 断言构建产物齐全。
 */
function assertBuildOutputs() {
  const required = [
    path.join(webDistDir, 'index.html'),
    path.join(electronDistDir, 'main', 'index.cjs'),
    path.join(electronDistDir, 'preload', 'index.cjs'),
    path.join(repoRoot, 'apps', 'electron', 'assets', 'icon.png'),
    path.join(repoRoot, 'apps', 'electron', 'assets', 'icon.ico'),
    path.join(repoRoot, 'packages', 'exporters', 'fonts', 'NotoSansSC-Variable.ttf'),
    path.join(repoRoot, 'packages', 'importer', 'assets', 'tessdata', 'eng.traineddata.gz'),
  ];
  const missing = required.filter((file) => !existsSync(file));
  if (missing.length > 0) {
    throw new Error(`构建产物缺失：\n  ${missing.join('\n  ')}`);
  }
  assertWebBundleIsBrowserOnly();
}

/**
 * 断言 web 产物没有把 Node 专属模块打包进浏览器 chunk。
 *
 * 事故复盘（2026-10-28）：`@woyao/services` 桶导出把 `@woyao/data/connection`
 * 拖进渲染进程，其顶层的 `import Database from 'better-sqlite3'` 让打包器把
 * 驱动的 CommonJS 壳塞进了 web chunk；该壳在模块求值期就解构
 * `require('node:util')`（浏览器里是空对象），抛 `TypeError: i is not a
 * function`，React 挂载失败 → 用户看到只剩菜单栏的空白窗口。
 *
 * 防线有三层：web 构建的 better-sqlite3 桩（apps/web/vite.config.ts）、
 * 本函数的产物扫描、冒烟报告的渲染进程 console 错误。这里用驱动内部
 * 稳定的特征串（`cppdb`、`prepare(\`EXPLAIN`）做识别，避免依赖路径名。
 */
function assertWebBundleIsBrowserOnly() {
  /** better-sqlite3 打进浏览器产物时的稳定特征串。 */
  const markers = [/cppdb/u, /EXPLAIN \$\{/u];
  const assetsDir = path.join(webDistDir, 'assets');
  if (!existsSync(assetsDir)) {
    throw new Error(`web 产物缺少 assets 目录：${assetsDir}`);
  }
  const offenders = [];
  for (const file of readdirSync(assetsDir)) {
    if (!file.endsWith('.js')) {
      continue;
    }
    const source = readFileSync(path.join(assetsDir, file), 'utf8');
    if (markers.some((marker) => marker.test(source))) {
      offenders.push(file);
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      [
        'web 产物里混入了 Node 专属模块（better-sqlite3）的特征代码：',
        `  ${offenders.join(', ')}`,
        '  后果：渲染进程模块求值即崩溃，窗口只剩菜单栏。',
        '  修复：检查 apps/web/vite.config.ts 的 better-sqlite3 桩 alias 是否被移除，',
        '  或渲染代码是否新增了直接引用 @woyao/data/@woyao/exporters 运行时值的导入。',
      ].join('\n'),
    );
  }
  console.log('  web 产物未检出 Node 专属模块特征（cppdb/EXPLAIN）');
}

/**
 * 检查主进程产物里 `require()` 的裸模块名，确保它们都在打包清单里。
 *
 * 这是防“改代码加了新依赖、打包时忘了复制”的保险丝：漏了的后果是安装版启动白屏，
 * 而在开发态（node_modules 齐全）完全复现不出来。
 */
function assertRuntimeDependenciesCovered() {
  const bundlePath = path.join(electronDistDir, 'main', 'index.cjs');
  const source = readFileSync(bundlePath, 'utf8');
  const required = new Set();
  for (const match of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
    required.add(match[1]);
  }
  const nodeBuiltins = new Set(builtinModules);
  const unknown = [...required].filter((name) => {
    if (name.startsWith('node:') || name.startsWith('.')) {
      return false;
    }
    if (nodeBuiltins.has(name) || EXTERNAL_ALLOWLIST.has(name)) {
      return false;
    }
    // 子路径导入（如 `pdfjs-dist/legacy/build/pdf.mjs`）也算已覆盖：
    // 只要包名进了 RUNTIME_DEPENDENCIES，它的子路径文件就随包一起被复制。
    const coveredByPrefix = RUNTIME_DEPENDENCIES.some((dep) => name === dep || name.startsWith(`${dep}/`));
    return !coveredByPrefix;
  });
  if (unknown.length > 0) {
    throw new Error(
      `主进程产物依赖了未纳入打包清单的模块：${unknown.join(', ')}\n` +
        '  修复：把包名加到 scripts/package-win.mjs 的 RUNTIME_DEPENDENCIES。',
    );
  }
  console.log(`  产物 require 的裸模块：${[...required].filter((n) => !n.startsWith('node:')).join(', ')}`);
}

/**
 * 从 `fromDir` 往上找 `node_modules/<name>`。
 *
 * @param {string} name 包名（可带 scope）。
 * @param {string} fromDir 起始目录（其自身及祖先的 node_modules 都会尝试）。
 * @returns {string | null} 找到的包目录（逻辑路径，不代表 realpath）。
 */
function findPackageDir(name, fromDir) {
  let current = fromDir;
  for (;;) {
    const candidate = path.join(current, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * 收集运行期依赖闭包：这些包必须以**真实文件**形式出现在 `resources/app/node_modules`。
 *
 * 为什么不能只复制顶层包：同一个包可能存在多个版本（`readable-stream` 就有 5 份），
 * 顶层摊平会改变解析结果。这里保留“包在仓库里原来的相对位置”
 * （`node_modules/x`、`node_modules/a/node_modules/b`），解析行为与开发态一致。
 *
 * @param {readonly string[]} roots 直接依赖的包名。
 * @returns {ReadonlyArray<{name: string, version: string, sourceDir: string, destRel: string}>} 复制计划。
 */
function collectRuntimeClosure(roots) {
  /** @type {Map<string, {name: string, version: string, sourceDir: string, destRel: string}>} */
  const collected = new Map();
  const queue = roots.map((name) => ({ name, fromDir: repoRoot }));

  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) {
      break;
    }
    const packageDir = findPackageDir(item.name, item.fromDir);
    if (packageDir === null) {
      throw new Error(`找不到运行期依赖 ${item.name}（from ${item.fromDir}），请先 npm ci`);
    }
    // 去重用 realpath：同一份物理目录只复制一次，符号链接也不会重复。
    const realDir = path.resolve(packageDir);
    if (collected.has(realDir)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    const destRel = path.relative(repoRoot, packageDir);
    if (destRel.startsWith('..')) {
      throw new Error(`依赖 ${item.name} 位于仓库之外（${packageDir}），无法按相对路径复制`);
    }
    collected.set(realDir, {
      name: manifest.name,
      version: manifest.version,
      sourceDir: packageDir,
      destRel,
    });

    /** @type {Record<string, string>} */
    const dependencies = manifest.dependencies ?? {};
    for (const dependencyName of Object.keys(dependencies)) {
      queue.push({ name: dependencyName, fromDir: packageDir });
    }
  }

  // 纯类型包没有运行期作用，复制过去只是浪费体积。
  return [...collected.values()]
    .filter((entry) => !String(entry.name).startsWith('@types/'))
    .sort((left, right) => left.destRel.localeCompare(right.destRel));
}

/**
 * 复制一个包目录（跳过它自己的 node_modules —— 嵌套依赖由闭包里各自的条目负责）。
 *
 * @param {{sourceDir: string, destRel: string}} entry 复制计划。
 * @param {string} appDir 应用根目录（`resources/app`）。
 */
function copyPackage(entry, appDir) {
  const destination = path.join(appDir, entry.destRel);
  copyTree(entry.sourceDir, destination, (source) => {
    const relative = path.relative(entry.sourceDir, source);
    if (relative === '') {
      return true;
    }
    const firstSegment = relative.split(path.sep)[0];
    if (firstSegment === 'node_modules') {
      return false;
    }
    if (entry.name === 'better-sqlite3') {
      // 只需 Windows x64 的预编译产物；另外 sqlite3 源码/deps 约 20MB，运行期用不到。
      if (relative.startsWith(`prebuilds${path.sep}`)) {
        return path.basename(source) === 'win32-x64.node';
      }
      if (firstSegment === 'deps' || firstSegment === 'src' || firstSegment === 'binding.gyp') {
        return false;
      }
    }
    return true;
  });
}

/**
 * 递归复制目录（自己走一遍，而不是 `fs.cpSync`）。
 *
 * 两个原因：
 * 1. 需要过滤（跳过嵌套 node_modules、剪掉非 Windows 的预编译产物）；
 * 2. 需要进度——一次性复制 350MB 的运行时如果没有任何输出，用户会以为卡死了。
 *
 * @param {string} source 源目录。
 * @param {string} destination 目标目录。
 * @param {(sourcePath: string) => boolean} [filter] 过滤器，返回 false 表示跳过。
 * @param {(copiedFiles: number, copiedBytes: number) => void} [onProgress] 进度回调。
 * @returns {{files: number, bytes: number}} 复制统计。
 */
function copyTree(source, destination, filter, onProgress) {
  const stats = { files: 0, bytes: 0 };
  const stack = [{ from: source, to: destination }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    mkdirSync(current.to, { recursive: true });
    for (const entry of readdirSync(current.from, { withFileTypes: true })) {
      const fromPath = path.join(current.from, entry.name);
      const toPath = path.join(current.to, entry.name);
      if (filter !== undefined && !filter(fromPath)) {
        continue;
      }
      if (entry.isDirectory()) {
        stack.push({ from: fromPath, to: toPath });
        continue;
      }
      // 符号链接（工作区包）按目标实体复制：安装目录里不该出现指向仓库的链接。
      copyFileSync(fromPath, toPath);
      stats.files += 1;
      const size = statSync(toPath).size;
      stats.bytes += size;
      if (onProgress !== undefined && stats.files % 50 === 0) {
        onProgress(stats.files, stats.bytes);
      }
    }
  }
  return stats;
}

/**
 * 递归统计目录大小（字节）。
 *
 * @param {string} target 目录或文件。
 * @returns {number} 字节数。
 */
function sizeOf(target) {
  if (!existsSync(target)) {
    return 0;
  }
  const stats = statSync(target);
  if (!stats.isDirectory()) {
    return stats.size;
  }
  let total = 0;
  for (const entry of readdirSync(target)) {
    total += sizeOf(path.join(target, entry));
  }
  return total;
}

/**
 * 把字节数格式化成 MB 字符串。
 *
 * @param {number} bytes 字节数。
 * @returns {string} 展示用字符串。
 */
function formatSize(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 删目录，遇到占用重试几次（Windows 上刚退出的进程会短暂占用文件句柄）。
 *
 * @param {string} target 目录。
 * @param {number} [attempts] 最多尝试次数。
 */
function removeDirectory(target, attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 3 });
      return;
    } catch (error) {
      if (attempt === attempts) {
        throw new Error(
          `无法删除 ${target}：${error instanceof Error ? error.message : String(error)}\n` +
            '  可能还有旧版本在运行，请先退出「我要背单词」再重试。',
          { cause: error },
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
}

/**
 * 关掉正在运行的旧版本，避免覆盖安装时文件被占用。
 *
 * 只在“确实在跑”时才动手，并且用 taskkill 正常结束；失败也不阻断打包（后面还有重试）。
 */
function stopRunningApp() {
  const listed = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${APP_EXE_NAME}`, '/NH'], {
    encoding: 'utf8',
    shell: false,
  });
  const stdout = typeof listed.stdout === 'string' ? listed.stdout : '';
  if (!stdout.toLowerCase().includes(APP_EXE_NAME.toLowerCase())) {
    console.log(`  ${APP_EXE_NAME} 未在运行`);
    return;
  }
  console.log(`  检测到 ${APP_EXE_NAME} 正在运行，先结束它`);
  spawnSync('taskkill', ['/IM', APP_EXE_NAME, '/F'], { stdio: 'inherit', shell: false });
}

/**
 * 组装 `resources/app`：package.json + 主进程/preload 产物 + web 产物 + 图标 + 运行期依赖。
 *
 * @param {ReadonlyArray<{name: string, version: string, sourceDir: string, destRel: string}>} closure 依赖闭包。
 */
function assembleApp(closure) {
  const appDir = path.join(stagingDir, 'resources', 'app');
  mkdirSync(appDir, { recursive: true });

  const rootManifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

  // 1) 应用清单：Electron 靠它找入口；`type: commonjs` 让 .cjs 之外的解析也稳定。
  writeFileSync(
    path.join(appDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'woyao-beidanci',
        productName: APP_DISPLAY_NAME,
        version: rootManifest.version,
        description: rootManifest.description,
        license: rootManifest.license,
        applicationId: APP_ID,
        main: 'dist/main/index.cjs',
        type: 'commonjs',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // 2) 主进程与 preload。
  copyTree(path.join(electronDistDir, 'main'), path.join(appDir, 'dist', 'main'));
  copyTree(path.join(electronDistDir, 'preload'), path.join(appDir, 'dist', 'preload'));

  // 3) web 产物：主进程按 `resources/app/dist/web` 找（见 index.ts 的 resolveStaticRoots）。
  copyTree(webDistDir, path.join(appDir, 'dist', 'web'));

  // 4) 图标：窗口/托盘用 icon.png，快捷方式与 exe 用 icon.ico。
  copyTree(path.join(repoRoot, 'apps', 'electron', 'assets'), path.join(appDir, 'assets'));

  // 5) 运行期 node_modules（better-sqlite3 等必须真实存在的包）。
  for (const entry of closure) {
    copyPackage(entry, appDir);
  }
  console.log(`  运行期依赖 ${closure.length} 个包，共 ${formatSize(sizeOf(path.join(appDir, 'node_modules')))}`);

  // 6) PDF 导出用的中文字体：database.ts 会查 `resources/fonts`。
  const fontsDir = path.join(stagingDir, 'resources', 'fonts');
  mkdirSync(fontsDir, { recursive: true });
  copyFileSync(
    path.join(repoRoot, 'packages', 'exporters', 'fonts', 'NotoSansSC-Variable.ttf'),
    path.join(fontsDir, 'NotoSansSC-Variable.ttf'),
  );
  for (const license of ['OFL.txt', 'LICENSE.md']) {
    const source = path.join(repoRoot, 'packages', 'exporters', 'fonts', license);
    if (existsSync(source)) {
      copyFileSync(source, path.join(fontsDir, license));
    }
  }

  // 7) OCR 语言包：importer.ts 会查 `resources/tessdata/eng.traineddata.gz`。
  const tessdataDir = path.join(stagingDir, 'resources', 'tessdata');
  mkdirSync(tessdataDir, { recursive: true });
  copyFileSync(
    path.join(repoRoot, 'packages', 'importer', 'assets', 'tessdata', 'eng.traineddata.gz'),
    path.join(tessdataDir, 'eng.traineddata.gz'),
  );
}

/**
 * 把 Electron 官方运行时搬进组装目录，并把 electron.exe 改名成 woyao-beidanci.exe。
 */
function copyElectronRuntime() {
  if (!existsSync(path.join(electronRuntimeDir, 'electron.exe'))) {
    throw new Error(
      `找不到 Electron 运行时：${electronRuntimeDir}\n  修复：npm ci（或 npm install）把 electron 装回来。`,
    );
  }
  console.log(`  复制 Electron 运行时（${formatSize(sizeOf(electronRuntimeDir))}）…`);
  const copied = copyTree(electronRuntimeDir, stagingDir, undefined, (files, bytes) => {
    console.log(`    已复制 ${files} 个文件 / ${formatSize(bytes)}`);
  });
  console.log(`  运行时复制完成：${copied.files} 个文件，${formatSize(copied.bytes)}`);
  const originalExe = path.join(stagingDir, 'electron.exe');
  const targetExe = path.join(stagingDir, APP_EXE_NAME);
  copyFileSync(originalExe, targetExe);
  rmSync(originalExe, { force: true });
  console.log(`  运行时：Electron ${readFileSync(path.join(stagingDir, 'version'), 'utf8').trim()}`);
}

/**
 * 找 rcedit：先看仓库依赖，再看 build/tools 这份一次性工具目录。
 *
 * @returns {string | null} 解析到的绝对路径。
 */
function resolveRcedit() {
  for (const base of [repoRoot, path.join(buildRoot, 'tools')]) {
    try {
      return createRequire(path.join(base, 'noop.js')).resolve('rcedit');
    } catch {
      // 没装就继续找下一个位置。
    }
  }
  return null;
}

/**
 * 把图标/产品名/版本写进 exe（可选增强，任何失败都只降级不中断打包）。
 *
 * 为什么它对用户不是必需：桌面/开始菜单快捷方式的图标指向 `assets\icon.ico`，
 * 窗口与任务栏图标来自 `BrowserWindow` 的 icon，都已经就位。rcedit 只是让
 * 资源管理器「属性 → 详细信息」和任务管理器里也显示我们的名字和图标。
 *
 * @param {string} exePath 安装目录里的 exe。
 * @param {string} iconPath 安装目录里的 icon.ico。
 * @returns {Promise<boolean>} 是否写入成功。
 */
async function tryEmbedExeResources(exePath, iconPath) {
  let resolved = resolveRcedit();
  if (resolved === null) {
    // 一次性装到 build/tools（不进 package.json / package-lock，失败就静默跳过）。
    console.log('  未找到 rcedit，尝试临时安装到 build/tools …');
    spawnSync(
      'npm',
      ['install', '--prefix', path.join(buildRoot, 'tools'), '--no-save', '--no-package-lock', 'rcedit'],
      { cwd: repoRoot, stdio: 'ignore', shell: process.platform === 'win32', timeout: 180000 },
    );
    resolved = resolveRcedit();
  }
  if (resolved === null) {
    console.log('  拿不到 rcedit，跳过 exe 图标/版本写入（快捷方式与窗口图标不受影响）');
    return false;
  }
  try {
    const module = await import(pathToFileURL(resolved).href);
    const rcedit = typeof module.rcedit === 'function' ? module.rcedit : module.default;
    if (typeof rcedit !== 'function') {
      throw new Error('rcedit 模块导出里没有可调用的函数');
    }
    const version = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
    await rcedit(exePath, {
      icon: iconPath,
      'file-version': version,
      'product-version': version,
      'version-string': {
        CompanyName: APP_DISPLAY_NAME,
        FileDescription: APP_DISPLAY_NAME,
        ProductName: APP_DISPLAY_NAME,
        OriginalFilename: APP_EXE_NAME,
      },
    });
    console.log('  已把图标/产品名/版本写进 exe');
    return true;
  } catch (error) {
    console.log(`  写入 exe 资源失败，已忽略：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * 建桌面与开始菜单快捷方式（WScript.Shell COM），并回读校验。
 *
 * @param {string} installPath 安装目录。
 * @returns {ReadonlyArray<string>} 创建出的 .lnk 路径。
 */
function createShortcuts(installPath) {
  const scriptPath = path.join(repoRoot, 'scripts', 'lib', 'create-shortcuts.ps1');
  const exePath = path.join(installPath, APP_EXE_NAME);
  const iconPath = path.join(installPath, 'resources', 'app', 'assets', 'icon.ico');
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-ExePath',
      exePath,
      '-IconPath',
      iconPath,
      '-WorkDir',
      installPath,
      '-AppName',
      APP_DISPLAY_NAME,
    ],
    { encoding: 'utf8', shell: false },
  );
  if (typeof result.stdout === 'string' && result.stdout.trim() !== '') {
    console.log(result.stdout.trim());
  }
  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(`创建快捷方式失败（退出码 ${String(result.status)}）：${stderr}`);
  }
  // 从 PowerShell 的 `shortcut: <路径>` 输出里回收真实路径：
  // 桌面可能被重定向（本机就是 D:\...\桌面），绝不能靠拼接 USERPROFILE 猜。
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  return stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('shortcut: '))
    .map((line) => line.slice('shortcut: '.length).trim());
}

/**
 * 安装（覆盖）到目标目录。
 *
 * @param {string} targetDir 安装目录。
 */
function installTo(targetDir) {
  mkdirSync(path.dirname(targetDir), { recursive: true });
  if (existsSync(targetDir)) {
    console.log(`  覆盖安装：清理旧目录 ${targetDir}`);
    removeDirectory(targetDir);
  }
  const copied = copyTree(stagingDir, targetDir, undefined, (files, bytes) => {
    console.log(`    已复制 ${files} 个文件 / ${formatSize(bytes)}`);
  });
  console.log(`  安装完成：${copied.files} 个文件，${formatSize(copied.bytes)}`);
}

/**
 * 安装后自检：关键文件在、且安装目录里没有任何源码/密钥残留。
 *
 * @param {string} targetDir 安装目录。
 */
function verifyInstall(targetDir) {
  const expected = [
    APP_EXE_NAME,
    path.join('resources', 'app', 'package.json'),
    path.join('resources', 'app', 'dist', 'main', 'index.cjs'),
    path.join('resources', 'app', 'dist', 'preload', 'index.cjs'),
    path.join('resources', 'app', 'dist', 'web', 'index.html'),
    path.join('resources', 'app', 'assets', 'icon.png'),
    path.join('resources', 'app', 'assets', 'icon.ico'),
    path.join('resources', 'app', 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node'),
    path.join('resources', 'fonts', 'NotoSansSC-Variable.ttf'),
    path.join('resources', 'cloud-config.json'),
  ];
  const missing = expected.filter((relative) => !existsSync(path.join(targetDir, relative)));
  if (missing.length > 0) {
    throw new Error(`安装目录缺少文件：\n  ${missing.join('\n  ')}`);
  }
  if (existsSync(path.join(targetDir, 'resources', 'app', '.env.local'))) {
    throw new Error('安装目录里出现了 .env.local —— 密钥不应该随包分发');
  }
  console.log('  安装目录自检通过');
}

/**
 * 主流程。
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (process.platform !== 'win32') {
    throw new Error('npm run package:win 只能在 Windows 上运行（要产出 .exe 与 .lnk）。');
  }
  if (process.env.LOCALAPPDATA === undefined && process.env.WOYAO_INSTALL_DIR === undefined) {
    throw new Error('环境变量 LOCALAPPDATA 不存在，无法定位安装目录（可用 WOYAO_INSTALL_DIR 指定）。');
  }

  console.log(`仓库：${repoRoot}`);
  console.log(`安装目录：${installDir}`);

  let cloudConfig = null;
  await step('读取云公共配置（.env.local）', () => {
    cloudConfig = readCloudConfig();
    console.log(`  endpoint=${cloudConfig.endpoint} resourceId=${cloudConfig.resourceId}`);
    console.log(`  publishableKey 已读取（${cloudConfig.publishableKey.length} 字符），不会打印、不进仓库`);
  });

  if (options.skipBuild) {
    console.log('\n▶ 跳过构建（--skip-build），复用现有产物');
  } else {
    await step('构建 web（产物 → dist/apps/web）', () => {
      run('npm', ['run', 'build', '--workspace', '@woyao/web']);
    });
    await step('构建 Electron 主进程与 preload', () => {
      run('npm', ['run', 'build', '--workspace', '@woyao/electron']);
    });
  }

  await step('校验构建产物', () => {
    assertBuildOutputs();
    assertRuntimeDependenciesCovered();
  });

  const closure = collectRuntimeClosure(RUNTIME_DEPENDENCIES);

  await step('组装应用目录（build/package）', () => {
    if (existsSync(stagingDir)) {
      removeDirectory(stagingDir);
    }
    mkdirSync(stagingDir, { recursive: true });
    copyElectronRuntime();
    assembleApp(closure);
  });

  await step('停止正在运行的旧版本', () => {
    stopRunningApp();
  });

  await step('安装到用户目录', () => {
    installTo(installDir);
  });

  await step('写入云配置到 resources/cloud-config.json', () => {
    // 只写最终安装目录：仓库里的任何文件都不含 publishableKey。
    const target = path.join(installDir, 'resources', 'cloud-config.json');
    writeFileSync(target, `${JSON.stringify(cloudConfig, null, 2)}\n`, 'utf8');
    console.log(`  已写入 ${target}`);
  });

  if (options.useRcedit) {
    await step('写入 exe 图标与产品信息（可选）', async () => {
      await tryEmbedExeResources(
        path.join(installDir, APP_EXE_NAME),
        path.join(installDir, 'resources', 'app', 'assets', 'icon.ico'),
      );
    });
  }

  let shortcuts = [];
  await step('创建桌面与开始菜单快捷方式', () => {
    shortcuts = createShortcuts(installDir);
  });

  await step('安装后自检', () => {
    verifyInstall(installDir);
  });

  console.log('\n═══ 打包完成 ═══');
  console.log(`应用：${path.join(installDir, APP_EXE_NAME)}`);
  console.log(`云配置：${path.join(installDir, 'resources', 'cloud-config.json')}`);
  for (const shortcut of shortcuts) {
    console.log(`快捷方式：${shortcut}`);
  }
  console.log(`体积：安装目录 ${formatSize(sizeOf(installDir))}`);
  console.log('\n步骤耗时：');
  for (const timing of timings) {
    console.log(`  ${timing.label}：${(timing.elapsed / 1000).toFixed(1)}s`);
  }
}

main().catch((error) => {
  console.error(`\n✗ 打包失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

// 打包是长事务：任何未捕获异常都要留下“死在哪个步骤”的线索，否则只看到一个退出码。
process.on('uncaughtException', (error) => {
  console.error('\n✗ 未捕获异常：', error);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('\n✗ 未处理的 Promise 拒绝：', reason);
  process.exit(1);
});
