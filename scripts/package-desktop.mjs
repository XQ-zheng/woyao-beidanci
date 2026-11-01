#!/usr/bin/env node
/**
 * 跨平台桌面发布打包：把「我要背单词」组装成可分发的应用，并产出**安装包**。
 *
 * 一条命令做完全部事情：
 *   构建 web/主进程产物 → 校验产物 → 组装应用目录（Electron 运行时 + resources/app）
 *   → 按平台产出安装包（Windows: NSIS `.exe`；macOS: `.dmg`）→ 打印体积与 sha256。
 *
 * 与 `scripts/package-win.mjs` 的分工（两者**故意共存**，不互相 import）：
 * - `package-win.mjs`：开发机自用，组装完直接**覆盖安装**到
 *   `E:\我要背单词——相关文件夹\程序` + 建桌面/开始菜单快捷方式。它依赖 E 盘、
 *   `.env.local` 和 Windows 独有能力，是“给自己装一份”的路径，产物不是安装包。
 * - 本脚本：面向**对外发布**。产物落在仓库 `release/` 下，名字/版本来自
 *   `package.json`，任何一台 Windows / macOS 机器（含 GitHub Actions）都能跑。
 *   它不写 E 盘、不建快捷方式；没有 `.env.local` 也能跑（只是包里没有云配置）。
 *
 * 为什么 Windows 安装包用 electron-builder 的 `--prepackaged`：
 * 应用目录的组装规则（web 产物落 `resources/app/dist/web`、原生模块必须是实体文件、
 * 字体/OCR/词库这些 resources 子目录）已在 `package-win.mjs` 里被真实安装验证过，
 * 复用它、只把“组装好的目录”交给 electron-builder 打 NSIS，比让 electron-builder
 * 自己从 monorepo 里猜文件更可控，也避免它去下载一整套 Electron 运行时。
 *
 * 为什么 macOS 不走 electron-builder：`node_modules/electron/dist` 里的
 * `Electron.app` 只需要改 Info.plist 与可执行文件名就能变成我们的 .app，
 * 再用系统自带 `hdiutil` 生成 dmg，全程零下载（CI 上最不容易挂）。
 *
 * 不用 asar：`better-sqlite3` 是原生模块，asar 内必须 unpack，反而多一层
 * “路径对不对”的调试成本；安装体积本来就和 Electron 运行时同量级，
 * 压缩收益不值得这个风险（结论沿用 `package-win.mjs` 的实测经验）。
 *
 * 用法：
 *   npm run package:exe                      # Windows：产出 release/woyao-beidanci-Setup-<ver>.exe
 *   npm run package:dmg                      # macOS：产出 release/woyao-beidanci-<ver>-<arch>.dmg
 *   node scripts/package-desktop.mjs --target=dir     # 只组装、不打包（排查用）
 *   node scripts/package-desktop.mjs --skip-build     # 复用已有 dist 产物
 *   node scripts/package-desktop.mjs --with-cloud     # 把 .env.local 的云配置嵌进包（发布流水线会带上它）
 *
 * 两条硬规则（都由本脚本保证，别改成“看有没有文件就写”）：
 * - **永不写** `resources/data-location.json`：运行期的 `resolveDataDir()` 读到它就不再
 *   校验盘符，把打包机的 `E:\...` 烤进去等于让所有没有 E 盘的用户装完打不开；
 * - `resources/cloud-config.json` **默认不嵌**；发布流水线通过 secret `WB_CLOUD_ENV`
 *   + `--with-cloud` 显式嵌入。做成显式开关（而不是“有就嵌”）是为了让「这个包到底
 *   有没有云配置」由命令决定，而不是由打包机上恰好存不存在 `.env.local` 决定。
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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录。 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** 组装与安装包共用的工作目录（已被 .gitignore 忽略）。 */
const buildRoot = path.join(repoRoot, 'build', 'desktop');

/** 最终安装包的输出目录（已被 .gitignore 忽略）。 */
const releaseDir = path.join(repoRoot, 'release');

/** 产品展示名：安装包、快捷方式、窗口标题都用它。 */
const APP_DISPLAY_NAME = '我要背单词';

/** 可执行文件名（由 Electron 运行时改名而来；macOS 上是 `.app` 内的二进制）。 */
const APP_EXE_NAME = 'woyao-beidanci';

/** macOS `.app` 包目录名（Finder 里显示的名字）。 */
const MAC_BUNDLE_NAME = `${APP_DISPLAY_NAME}.app`;

/** 应用 ID（与主进程 `app.setAppUserModelId` 一致）。 */
const APP_ID = 'com.woyao.beidanci';

/** web 产物目录（`vite.config.ts` 的 `build.outDir`）。 */
const webDistDir = path.join(repoRoot, 'dist', 'apps', 'web');

/** Electron 主进程 / preload 产物目录。 */
const electronDistDir = path.join(repoRoot, 'apps', 'electron', 'dist');

/** Electron 官方运行时（`npm ci` 装完就在，无需任何下载）。 */
const electronRuntimeDir = path.join(repoRoot, 'node_modules', 'electron', 'dist');

/** 图标资源目录。 */
const assetsDir = path.join(repoRoot, 'apps', 'electron', 'assets');

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

/** 各步骤耗时，最后统一打印，便于发现哪一步拖慢打包。 */
const timings = [];

/** 当前平台标签（如 `win32-x64`、`darwin-arm64`）。 */
const platformKey = `${process.platform}-${process.arch}`;

/** 本次组装出来的应用目录（Windows 是应用根；macOS 是放 `.app` 的父目录）。 */
const stageRoot = path.join(buildRoot, platformKey);

/** 打包目标。 */
const VALID_TARGETS = new Set(['exe', 'dmg', 'dir']);

/**
 * 解析命令行开关。
 *
 * @param {readonly string[]} argv 进程参数（不含 node 与脚本名）。
 * @returns {{target: string, skipBuild: boolean, withCloud: boolean}} 开关。
 */
function parseArgs(argv) {
  let target = process.platform === 'darwin' ? 'dmg' : 'exe';
  for (const argument of argv) {
    if (argument.startsWith('--target=')) {
      target = argument.slice('--target='.length);
    }
  }
  if (!VALID_TARGETS.has(target)) {
    throw new Error(`未知的 --target=${target}，可选：${[...VALID_TARGETS].join(' / ')}`);
  }
  return {
    target,
    skipBuild: argv.includes('--skip-build'),
    withCloud: argv.includes('--with-cloud'),
  };
}

/**
 * 跑一个子进程，失败就抛（错误信息带上命令行，方便定位）。
 *
 * @param {string} command 可执行文件。
 * @param {readonly string[]} args 参数。
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, shell?: boolean}} [options] 选项。
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: 'inherit',
    // Windows 上 npm/electron-builder 是 .cmd，必须经 shell 才能启动；
    // macOS 上走 shell 会把参数再解析一遍，路径含空格（本仓库路径就有）时容易出错。
    shell: options.shell ?? process.platform === 'win32',
  });
  if (result.error !== undefined && result.error !== null) {
    throw new Error(`执行失败：${command} ${args.join(' ')} → ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`执行失败：${command} ${args.join(' ')}（退出码 ${String(result.status)}）`);
  }
}

/**
 * 跑一个步骤并记录耗时。
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
 * 递归复制目录（自己走一遍，而不是 `fs.cpSync`）。
 *
 * 两个原因：
 * 1. 需要过滤（跳过嵌套 node_modules、剪掉其它平台的预编译产物）；
 * 2. 需要进度——一次性复制 250MB+ 的运行时如果没有任何输出，看起来像卡死。
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
      // 符号链接（workspace 包）按目标实体复制：安装目录里不该出现指向仓库的链接。
      copyFileSync(fromPath, toPath);
      stats.files += 1;
      stats.bytes += statSync(toPath).size;
      if (onProgress !== undefined && stats.files % 200 === 0) {
        onProgress(stats.files, stats.bytes);
      }
    }
  }
  return stats;
}

/**
 * 递归统计目录/文件大小（字节）。
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
 * 计算文件 sha256。
 *
 * @param {string} filePath 文件路径。
 * @returns {string} 十六进制摘要。
 */
function sha256Of(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
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
            '  若目录被占用，请先退出正在运行的应用再重试。',
          { cause: error },
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
}

/**
 * 从 `fromDir` 往上找 `node_modules/<name>`。
 *
 * @param {string} name 包名（可带 scope）。
 * @param {string} fromDir 起始目录。
 * @returns {string | null} 找到的包目录。
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
 * 为什么保留“包在仓库里原来的相对位置”（`node_modules/x`、`node_modules/a/node_modules/b`）：
 * 同一个包可能存在多个版本，顶层摊平会改变解析结果。
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
 * 当前平台需要的 better-sqlite3 预编译产物文件名。
 *
 * 打包机与目标平台一致（Windows 打包 Windows、macOS 打包 macOS），
 * 所以只需保留本机那一份 `.node`；其它平台的预编译产物（每份约 2MB）剪掉。
 *
 * @returns {readonly string[]} 需要保留的预编译文件名。
 */
function nativePrebuildNames() {
  if (process.platform === 'win32') {
    return process.arch === 'arm64' ? ['win32-arm64.node'] : ['win32-x64.node'];
  }
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? ['darwin-arm64.node'] : ['darwin-x64.node'];
  }
  return ['linux-x64.node'];
}

/**
 * 复制一个包目录（跳过它自己的 node_modules —— 嵌套依赖由闭包各自负责）。
 *
 * @param {{name: string, sourceDir: string, destRel: string}} entry 复制计划。
 * @param {string} appDir 应用根目录（`resources/app`）。
 */
function copyPackage(entry, appDir) {
  const keepPrebuilds = new Set(nativePrebuildNames());
  const destination = path.join(appDir, entry.destRel);
  copyTree(entry.sourceDir, destination, (source) => {
    const relative = path.relative(entry.sourceDir, source);
    if (relative === '') {
      return true;
    }
    const segments = relative.split(path.sep);
    const firstSegment = segments[0];
    if (firstSegment === 'node_modules') {
      return false;
    }
    if (entry.name === 'better-sqlite3') {
      // 只留本平台的预编译产物；sqlite3 的 C 源码与 deps 约 20MB，运行期用不到。
      if (firstSegment === 'prebuilds') {
        return segments.length === 1 || keepPrebuilds.has(path.basename(source));
      }
      if (firstSegment === 'deps' || firstSegment === 'src' || firstSegment === 'binding.gyp') {
        return false;
      }
    }
    return true;
  });
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
 * 读云公共配置（可选）。
 *
 * 与 `package-win.mjs`（缺配置直接失败）不同，这里允许没有 `.env.local`：
 * 仓库里不放 key，官方 Release 的配置来自 GitHub Actions secret `WB_CLOUD_ENV`
 * （被写成 `.env.local` 后由 `--with-cloud` 读走）；fork 后没配 secret 时
 * `.env.local` 不存在，此时产出的安装包打开账号页会如实显示“云服务未配置”，
 * **本地学习功能完全不受影响**。
 *
 * @returns {{config: Record<string, string> | null, reason: string}} 配置与说明。
 */
function readCloudConfigIfAny() {
  const envPath = path.join(repoRoot, '.env.local');
  if (!existsSync(envPath)) {
    return {
      config: null,
      reason: '没有 .env.local → 安装包不含云配置（账号页显示“未配置”，本地功能不受影响）',
    };
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
  for (const [target, key] of required) {
    const value = env[key]?.trim() ?? '';
    if (value === '') {
      return { config: null, reason: `.env.local 缺少 ${key} → 安装包不含云配置` };
    }
    config[target] = value;
  }
  if (!String(config.endpoint).startsWith('https://')) {
    return { config: null, reason: 'VITE_WB_CLOUD_ENDPOINT 不是 https → 安装包不含云配置' };
  }
  return { config, reason: '已嵌入云公共配置（publishableKey 为公开值，不打印）' };
}

/**
 * 断言构建产物齐全（缺任何一项都直接失败，不要产出半成品安装包）。
 */
function assertBuildOutputs() {
  const required = [
    path.join(webDistDir, 'index.html'),
    path.join(electronDistDir, 'main', 'index.cjs'),
    path.join(electronDistDir, 'preload', 'index.cjs'),
    path.join(assetsDir, 'icon.png'),
    path.join(assetsDir, 'icon.ico'),
    path.join(repoRoot, 'packages', 'exporters', 'fonts', 'NotoSansSC-Variable.ttf'),
    path.join(repoRoot, 'packages', 'importer', 'assets', 'tessdata', 'eng.traineddata.gz'),
    path.join(repoRoot, 'packages', 'importer', 'assets', 'wordbooks', 'index.json'),
  ];
  const missing = required.filter((file) => !existsSync(file));
  if (missing.length > 0) {
    throw new Error(`构建产物缺失：\n  ${missing.join('\n  ')}`);
  }
  assertWebBundleIsBrowserOnly();
}

/**
 * 断言 web 产物没有把 Node 专属模块（better-sqlite3）打包进浏览器 chunk。
 *
 * 事故复盘见 `package-win.mjs`：驱动壳在浏览器里求值即抛错，窗口只剩菜单栏。
 * 发布包里出现这个问题的代价比本机大得多（用户装完打不开 = 直接差评）。
 */
function assertWebBundleIsBrowserOnly() {
  /** better-sqlite3 打进浏览器产物时的稳定特征串。 */
  const markers = [/cppdb/u, /EXPLAIN \$\{/u];
  const webAssetsDir = path.join(webDistDir, 'assets');
  if (!existsSync(webAssetsDir)) {
    throw new Error(`web 产物缺少 assets 目录：${webAssetsDir}`);
  }
  const offenders = [];
  for (const file of readdirSync(webAssetsDir)) {
    if (!file.endsWith('.js')) {
      continue;
    }
    const source = readFileSync(path.join(webAssetsDir, file), 'utf8');
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
        '  修复：检查 apps/web/vite.config.ts 的 better-sqlite3 桩 alias 是否被移除。',
      ].join('\n'),
    );
  }
  console.log('  web 产物未检出 Node 专属模块特征（cppdb/EXPLAIN）');
}

/**
 * 检查主进程产物里 `require()` 的裸模块名，确保它们都在打包清单里。
 *
 * 漏了的后果是安装版启动白屏，而开发态（node_modules 齐全）完全复现不出来。
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
    const coveredByPrefix = RUNTIME_DEPENDENCIES.some(
      (dep) => name === dep || name.startsWith(`${dep}/`),
    );
    return !coveredByPrefix;
  });
  if (unknown.length > 0) {
    throw new Error(
      `主进程产物依赖了未纳入打包清单的模块：${unknown.join(', ')}\n` +
        '  修复：把包名加到 scripts/package-desktop.mjs 的 RUNTIME_DEPENDENCIES。',
    );
  }
  console.log(
    `  产物 require 的裸模块：${[...required].filter((n) => !n.startsWith('node:')).join(', ')}`,
  );
}

/**
 * 组装 `resources/app`：package.json + 主进程/preload 产物 + web 产物 + 图标 + 运行期依赖。
 *
 * @param {string} resourcesDir 目标 `resources` 目录（Windows: `<应用根>/resources`；
 *   macOS: `<App>.app/Contents/Resources`）。
 * @param {ReadonlyArray<{name: string, sourceDir: string, destRel: string}>} closure 依赖闭包。
 */
function assembleAppResources(resourcesDir, closure) {
  const appDir = path.join(resourcesDir, 'app');
  mkdirSync(appDir, { recursive: true });

  const rootManifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

  // 1) 应用清单：Electron 靠它找入口；`type: commonjs` 让 .cjs 解析稳定。
  writeFileSync(
    path.join(appDir, 'package.json'),
    `${JSON.stringify(
      {
        name: APP_EXE_NAME,
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

  // 4) 图标：窗口/托盘用 icon.png。
  copyTree(assetsDir, path.join(appDir, 'assets'));

  // 5) 运行期 node_modules（better-sqlite3 等必须真实存在的包）。
  for (const entry of closure) {
    copyPackage(entry, appDir);
  }
  console.log(
    `  运行期依赖 ${closure.length} 个包，共 ${formatSize(sizeOf(path.join(appDir, 'node_modules')))}`,
  );

  // 6) PDF 导出用的中文字体：导出服务会查 `resources/fonts`。
  const fontsDir = path.join(resourcesDir, 'fonts');
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

  // 7) OCR 语言包：导入服务会查 `resources/tessdata/eng.traineddata.gz`。
  const tessdataDir = path.join(resourcesDir, 'tessdata');
  mkdirSync(tessdataDir, { recursive: true });
  copyFileSync(
    path.join(repoRoot, 'packages', 'importer', 'assets', 'tessdata', 'eng.traineddata.gz'),
    path.join(tessdataDir, 'eng.traineddata.gz'),
  );

  // 8) 内置词库（四级/六级/考研）。
  const wordbooksDir = path.join(resourcesDir, 'wordbooks');
  mkdirSync(wordbooksDir, { recursive: true });
  const builtinWordbooks = path.join(repoRoot, 'packages', 'importer', 'assets', 'wordbooks');
  for (const file of readdirSync(builtinWordbooks)) {
    copyFileSync(path.join(builtinWordbooks, file), path.join(wordbooksDir, file));
  }

  // 9) 许可证随包分发（MIT 要求保留版权声明）。
  for (const licenseFile of ['LICENSE']) {
    const source = path.join(repoRoot, licenseFile);
    if (existsSync(source)) {
      copyFileSync(source, path.join(resourcesDir, licenseFile));
    }
  }
}

/**
 * 确保产物里**没有**数据位置引导文件 `resources/data-location.json`。
 *
 * 为什么发布包必须没有它（P0 事故预防）：
 * `apps/electron/src/main/dataLocation.ts` 的 `resolveDataDir()` 一旦读到引导文件就
 * **无条件返回该路径**，不校验盘符是否存在/可写；随后 `openDatabase()` 直接
 * `new Database(<userData>/woyao.sqlite3)`，目录不存在就是 SQLITE_CANTOPEN。
 * 也就是说：谁在打包机上把 `E:\我要背单词——相关文件夹` 烤进安装包，所有没有 E 盘
 * 的用户（绝大多数）装完就打不开应用。
 *
 * 正确行为由运行期负责：`resolveDataDir()` 在**没有**引导文件时会自己判断
 * `existsSync('E:\\') && ensureWritableDir(...)`，不满足就用 Electron 默认的
 * `%APPDATA%\woyao-beidanci`。发布包要做的事就是“什么都不写”。
 *
 * 想固化数据目录的开发者请用 `scripts/package-win.mjs`（本机自用安装），
 * 那条路会照旧写这个文件。
 *
 * @param {string} resourcesDir 目标 `resources` 目录。
 */
function ensureNoDataLocationHint(resourcesDir) {
  const target = path.join(resourcesDir, 'data-location.json');
  if (existsSync(target)) {
    rmSync(target, { force: true });
    console.log('  已删除残留的 data-location.json（发布包不固化数据目录）');
  }
  console.log('  数据目录：不写引导文件，由运行期按 E 盘是否存在自动选择');
}

/**
 * 处理云公共配置（默认**不**嵌入，需显式 `--with-cloud` 才写）。
 *
 * 为什么要显式开关而不是“有 `.env.local` 就嵌”：
 * 后者会让「这个安装包有没有云配置」取决于打包机上恰好有没有那个文件——
 * 本地开发和 CI 会产出内容不同的同一版本，Release 资产没法复现，
 * 也没法在日志里一眼看出“这个包到底带没带”。
 *
 * 官方 Release 的配置来源是 GitHub Actions secret `WB_CLOUD_ENV`
 * （流水线把它写成 `.env.local`，再带 `--with-cloud` 打包）。
 *
 * 本机自用/内网分发：
 *   node scripts/package-desktop.mjs --target=exe --with-cloud
 *
 * @param {string} resourcesDir 目标 `resources` 目录。
 * @param {boolean} withCloud 是否嵌入云公共配置。
 */
function applyCloudConfig(resourcesDir, withCloud) {
  const target = path.join(resourcesDir, 'cloud-config.json');
  if (!withCloud) {
    if (existsSync(target)) {
      rmSync(target, { force: true });
    }
    console.log('  云配置：未加 --with-cloud，不嵌入（账号页会显示云服务未配置，本地功能不受影响）');
    return;
  }
  const { config, reason } = readCloudConfigIfAny();
  console.log(`  云配置：${reason}`);
  if (config === null) {
    return;
  }
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  console.log('  已写入 resources/cloud-config.json（publishableKey 为公开值，不打印）');
}

/**
 * 组装 Windows 应用目录：Electron 运行时 + `electron.exe` 改名 + resources。
 */
function assembleWindowsApp() {
  if (!existsSync(path.join(electronRuntimeDir, 'electron.exe'))) {
    throw new Error(
      `找不到 Electron 运行时：${electronRuntimeDir}\n  修复：npm ci（把 electron 装回来）。`,
    );
  }
  console.log(`  复制 Electron 运行时（${formatSize(sizeOf(electronRuntimeDir))}）…`);
  const copied = copyTree(electronRuntimeDir, stageRoot, undefined, (files, bytes) => {
    console.log(`    已复制 ${files} 个文件 / ${formatSize(bytes)}`);
  });
  console.log(`  运行时复制完成：${copied.files} 个文件，${formatSize(copied.bytes)}`);

  const originalExe = path.join(stageRoot, 'electron.exe');
  const targetExe = path.join(stageRoot, `${APP_EXE_NAME}.exe`);
  copyFileSync(originalExe, targetExe);
  rmSync(originalExe, { force: true });
  console.log(
    `  运行时：Electron ${readFileSync(path.join(stageRoot, 'version'), 'utf8').trim()}`,
  );
  return path.join(stageRoot, 'resources');
}

/**
 * 把 `Electron.app` 搬成 `我要背单词.app`：改 Info.plist、改可执行文件名、塞 resources。
 *
 * macOS 的 `.app` 是“目录当程序”，所以要点只有三个：
 * 1. `Contents/MacOS/<CFBundleExecutable>` 必须与 Info.plist 里的名字一致；
 * 2. 我们的 resources（app/fonts/tessdata/wordbooks）放在 `Contents/Resources` 下，
 *    这与主进程里 `process.resourcesPath` 的语义完全一致；
 * 3. 改过的包签名必然失效，删掉 `_CodeSignature` 让系统按“未签名”处理，
 *    否则会报“已损坏”。用户首次打开需右键 →「打开」。
 *
 * @returns {string} `Contents/Resources` 目录。
 */
function assembleMacApp() {
  const electronAppDir = path.join(electronRuntimeDir, 'Electron.app');
  if (!existsSync(electronAppDir)) {
    throw new Error(
      `找不到 macOS Electron 运行时：${electronAppDir}\n  修复：在 macOS 上执行 npm ci。`,
    );
  }
  const appBundle = path.join(stageRoot, MAC_BUNDLE_NAME);
  console.log(`  复制 Electron.app（${formatSize(sizeOf(electronAppDir))}）…`);
  copyTree(electronAppDir, appBundle, undefined, (files, bytes) => {
    console.log(`    已复制 ${files} 个文件 / ${formatSize(bytes)}`);
  });

  const contentsDir = path.join(appBundle, 'Contents');
  const macOsDir = path.join(contentsDir, 'MacOS');
  const resourcesDir = path.join(contentsDir, 'Resources');

  // 1) 改名可执行文件（Electron → woyao-beidanci）。
  const originalBinary = path.join(macOsDir, 'Electron');
  const targetBinary = path.join(macOsDir, APP_EXE_NAME);
  if (existsSync(originalBinary)) {
    copyFileSync(originalBinary, targetBinary);
    rmSync(originalBinary, { force: true });
  } else if (!existsSync(targetBinary)) {
    throw new Error(`Electron.app 结构异常：找不到 Contents/MacOS/Electron`);
  }

  // 2) 改 Info.plist。
  const rootManifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const plistPath = path.join(contentsDir, 'Info.plist');
  let plist = readFileSync(plistPath, 'utf8');
  plist = setPlistValue(plist, 'CFBundleExecutable', APP_EXE_NAME);
  plist = setPlistValue(plist, 'CFBundleIdentifier', APP_ID);
  plist = setPlistValue(plist, 'CFBundleName', APP_DISPLAY_NAME);
  plist = setPlistValue(plist, 'CFBundleDisplayName', APP_DISPLAY_NAME);
  plist = setPlistValue(plist, 'CFBundleShortVersionString', String(rootManifest.version));
  plist = setPlistValue(plist, 'CFBundleVersion', String(rootManifest.version));
  plist = setPlistValue(plist, 'NSHumanReadableCopyright', 'Copyright (c) 2026 郑宇轩');
  // 图标：能生成 .icns 就用自己的，否则保留 Electron 默认图标（不伪造成功）。
  const icns = path.join(resourcesDir, 'woyao.icns');
  if (tryCreateIcns(path.join(assetsDir, 'icon.png'), icns)) {
    plist = setPlistValue(plist, 'CFBundleIconFile', 'woyao.icns');
  }
  writeFileSync(plistPath, plist, 'utf8');

  // 3) 改包里的 helper 可执行文件名/描述不需要动（它们是独立 bundle，行为不变）。
  // 4) 删掉失效签名，避免 Gatekeeper 报“已损坏”。
  const signatureDir = path.join(contentsDir, '_CodeSignature');
  if (existsSync(signatureDir)) {
    removeDirectory(signatureDir);
    console.log('  已移除原 Electron 代码签名目录（改包后签名必然失效）');
  }

  return resourcesDir;
}

/**
 * 改 Info.plist 里的一个字符串项（存在则替换，不存在则插到最后一个 `</dict>` 之前）。
 *
 * 只处理 `<key>X</key><string>Y</string>` 这种最简单的结构 —— Electron 自带的
 * Info.plist 全是这种，不需要引入 plist 解析库。
 *
 * @param {string} plistText 原始 XML。
 * @param {string} key 键名。
 * @param {string} value 新值（不需要 XML 转义：内容都是产品名/版本号）。
 * @returns {string} 修改后的 XML。
 */
function setPlistValue(plistText, key, value) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`(<key>${escapedKey}</key>\\s*<string>)[^<]*(</string>)`, 'u');
  if (pattern.test(plistText)) {
    return plistText.replace(pattern, `$1${value}$2`);
  }
  const closing = plistText.lastIndexOf('</dict>');
  if (closing < 0) {
    throw new Error('Info.plist 结构异常：找不到 </dict>');
  }
  return `${plistText.slice(0, closing)}<key>${key}</key>\n<string>${value}</string>\n${plistText.slice(closing)}`;
}

/**
 * 用系统自带 `sips` + `iconutil` 把 PNG 转成 `.icns`（仅 macOS，失败不阻断）。
 *
 * @param {string} pngPath 源 PNG（512x512 或更大）。
 * @param {string} icnsPath 目标 `.icns`。
 * @returns {boolean} 是否成功。
 */
function tryCreateIcns(pngPath, icnsPath) {
  if (process.platform !== 'darwin' || !existsSync(pngPath)) {
    return false;
  }
  const iconset = path.join(buildRoot, 'icon.iconset');
  try {
    rmSync(iconset, { recursive: true, force: true });
    mkdirSync(iconset, { recursive: true });
    /** @type {ReadonlyArray<[number, string]>} */
    const sizes = [
      [16, 'icon_16x16.png'],
      [32, 'icon_16x16@2x.png'],
      [32, 'icon_32x32.png'],
      [64, 'icon_32x32@2x.png'],
      [128, 'icon_128x128.png'],
      [256, 'icon_128x128@2x.png'],
      [256, 'icon_256x256.png'],
      [512, 'icon_256x256@2x.png'],
      [512, 'icon_512x512.png'],
      [1024, 'icon_512x512@2x.png'],
    ];
    for (const [size, name] of sizes) {
      const result = spawnSync('sips', ['-z', String(size), String(size), pngPath, '--out', path.join(iconset, name)], {
        stdio: 'ignore',
        shell: false,
      });
      if (result.status !== 0) {
        return false;
      }
    }
    const result = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', icnsPath], {
      stdio: 'ignore',
      shell: false,
    });
    return result.status === 0 && existsSync(icnsPath);
  } catch {
    return false;
  }
}

/**
 * 用 electron-builder 把已组装好的目录打成 Windows NSIS 安装包。
 *
 * 关键参数：
 * - `--prepackaged`：直接复用本脚本组装的目录，electron-builder 不下载 Electron、
 *   不重新收拾 monorepo 文件；
 * - `--config`：见 `electron-builder.config.cjs`（`asar: false`，原生模块保持实体文件）。
 *
 * @returns {Promise<string>} 生成的 `.exe` 绝对路径。
 */
async function buildWindowsInstaller() {
  const configPath = path.join(repoRoot, 'electron-builder.config.cjs');
  if (!existsSync(configPath)) {
    throw new Error(`缺少 electron-builder 配置：${configPath}`);
  }
  mkdirSync(releaseDir, { recursive: true });

  const binary = createRequire(path.join(repoRoot, 'noop.js')).resolve('electron-builder/out/cli/cli.js');
  if (!existsSync(binary)) {
    throw new Error('electron-builder 未安装：请先 npm ci（或 npm i -D electron-builder）');
  }
  // 用 node 直接跑 CLI（不用 shell）：本仓库路径含空格与中文，Windows 下经
  // shell 传参会把 `E:\Workbuddy 思考文件\...` 截成 `E:\Workbuddy`。
  run(
    process.execPath,
    [
      binary,
      '--prepackaged',
      stageRoot,
      '--win',
      'nsis',
      `--${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
      '--config',
      configPath,
    ],
    { shell: false },
  );

  const artifact = path.join(
    releaseDir,
    `woyao-beidanci-Setup-${readVersion()}.exe`,
  );
  if (!existsSync(artifact)) {
    const produced = existsSync(releaseDir)
      ? readdirSync(releaseDir).filter((name) => name.endsWith('.exe'))
      : [];
    throw new Error(
      `electron-builder 未产出预期文件：${artifact}\n  实际产出：${produced.join(', ') || '（空）'}`,
    );
  }
  return artifact;
}

/**
 * 用系统 `hdiutil` 把组装好的 `.app` 打成 dmg（仅 macOS）。
 *
 * @returns {string} 生成的 `.dmg` 绝对路径。
 */
function buildMacDmg() {
  if (process.platform !== 'darwin') {
    throw new Error('package:dmg 只能在 macOS 上运行（dmg 需要系统 hdiutil）。');
  }
  const appBundle = path.join(stageRoot, MAC_BUNDLE_NAME);
  if (!existsSync(appBundle)) {
    throw new Error(`找不到 ${appBundle}，组装步骤可能失败`);
  }
  // 拖拽安装惯例：dmg 里带一个指向 /Applications 的软链接。
  const applicationsLink = path.join(stageRoot, 'Applications');
  if (!existsSync(applicationsLink)) {
    symlinkSync('/Applications', applicationsLink, 'dir');
  }
  mkdirSync(releaseDir, { recursive: true });
  // 文件名带架构：CI 上会分别在 Apple Silicon 与 Intel 机器上各打一次，
  // 不带架构后缀会互相覆盖。
  const dmgPath = path.join(
    releaseDir,
    `woyao-beidanci-${readVersion()}-${process.arch}.dmg`,
  );
  rmSync(dmgPath, { force: true });
  run('hdiutil', [
    'create',
    '-volname',
    `${APP_DISPLAY_NAME} ${readVersion()}`,
    '-srcfolder',
    stageRoot,
    '-ov',
    '-format',
    'UDZO',
    dmgPath,
  ]);
  return dmgPath;
}

/**
 * 读根 `package.json` 的版本号（安装包文件名用它，避免多处漂移）。
 *
 * @returns {string} 版本号。
 */
function readVersion() {
  return JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
}

/**
 * 主流程。
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.target === 'exe' && process.platform !== 'win32') {
    throw new Error('package:exe 只能在 Windows 上运行（NSIS 需要 Windows 环境）。');
  }
  if (options.target === 'dmg' && process.platform !== 'darwin') {
    throw new Error('package:dmg 只能在 macOS 上运行（dmg 需要系统 hdiutil）。');
  }

  console.log(`仓库：${repoRoot}`);
  console.log(`平台：${platformKey} / 目标：${options.target}`);

  if (options.skipBuild) {
    console.log('\n▶ 跳过构建（--skip-build），复用现有产物');
  } else {
    await step('构建 web 产物（→ dist/apps/web）', () => {
      run('npm', ['run', 'build', '--workspace', '@woyao/web']);
    });
    await step('构建 Electron 主进程与 preload（→ apps/electron/dist）', () => {
      run('npm', ['run', 'build', '--workspace', '@woyao/electron']);
    });
  }

  await step('校验构建产物', () => {
    assertBuildOutputs();
    assertRuntimeDependenciesCovered();
  });

  const closure = collectRuntimeClosure(RUNTIME_DEPENDENCIES);

  let resourcesDir = '';
  await step('组装应用目录', () => {
    if (existsSync(stageRoot)) {
      removeDirectory(stageRoot);
    }
    mkdirSync(stageRoot, { recursive: true });
    resourcesDir = process.platform === 'darwin' ? assembleMacApp() : assembleWindowsApp();
    assembleAppResources(resourcesDir, closure);
    applyCloudConfig(resourcesDir, options.withCloud);
    ensureNoDataLocationHint(resourcesDir);
    console.log(`  应用目录：${formatSize(sizeOf(stageRoot))}`);
  });

  if (options.target === 'dir') {
    console.log('\n▶ 仅组装（--target=dir），不产出安装包');
    console.log(`应用目录：${stageRoot}`);
    return;
  }

  if (options.target === 'exe') {
    const artifact = await (async () => {
      let produced = '';
      await step('生成 Windows NSIS 安装包（electron-builder --prepackaged）', async () => {
        produced = await buildWindowsInstaller();
      });
      return produced;
    })();
    reportArtifact(artifact, 'Windows NSIS 安装包');
    return;
  }

  let dmg = '';
  await step('生成 macOS dmg（hdiutil）', () => {
    dmg = buildMacDmg();
  });
  reportArtifact(dmg, 'macOS dmg');
}

/**
 * 打印产物信息（路径、体积、sha256），并写出同名 `.sha256` 校验文件。
 *
 * 注意：产物文件名**带版本号**（`woyao-beidanci-Setup-<version>.exe`），
 * 不做“重命名成固定名”这种动作——Release 资产必须能一眼看出是哪一版。
 *
 * @param {string} artifactPath 产物路径。
 * @param {string} label 人类可读的产物类型。
 */
function reportArtifact(artifactPath, label) {
  const size = formatSize(statSync(artifactPath).size);
  const digest = sha256Of(artifactPath);
  console.log(`\n═══ 打包完成 ═══`);
  console.log(`${label}：${artifactPath}`);
  console.log(`体积：${size}`);
  console.log(`sha256：${digest}`);
  writeFileSync(
    `${artifactPath}.sha256`,
    `${digest}  ${path.basename(artifactPath)}\n`,
    'utf8',
  );
  console.log(`校验文件：${artifactPath}.sha256`);
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
