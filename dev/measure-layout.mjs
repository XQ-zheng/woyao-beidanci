/**
 * 学习页布局测量（真实浏览器）。
 *
 * 为什么需要它：jsdom 不做布局，`getBoundingClientRect()` 全为 0，单元测试无法证明
 * “两个视口下控件不被固定底栏遮挡”。这个脚本用 Chromium 打开
 * `/dev/study-harness.html`，量真实矩形并断言互不相交、按钮高度、底栏之上、无横向溢出。
 *
 * 前置：
 *   1. `npm run dev`（另开一个终端，保持运行）
 *   2. `npm i -D playwright-core`（或全局已装）
 *   3. Chromium：脚本优先用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE`，否则用 playwright 缓存目录
 *
 * 运行：`npm run verify:layout`
 * 产物：`verification/6b-layout/layout-report.json` + 同目录截图
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const harnessUrl = process.env.LAYOUT_URL ?? 'http://localhost:5173/dev/study-harness.html';
const outDir = path.join(repoRoot, 'verification', '6b-layout');

/**
 * 解析 Chromium 可执行文件。
 *
 * 顺序：环境变量 → playwright 自报路径 → 在 ms-playwright 缓存里找任意已安装版本。
 * 最后一步是为了“本机装的是 chromium-1234、playwright-core 却想要 1248”这种版本错位：
 * 校验脚本只关心真实浏览器能不能开，不该因为版本号差一位就拒绝运行。
 */
async function resolveExecutable(chromium) {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  }
  try {
    const own = chromium.executablePath();
    if (own && existsSync(own)) {
      return own;
    }
  } catch {
    // 继续走缓存探测
  }
  const root =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    path.join(process.env.LOCALAPPDATA ?? process.env.HOME ?? '.', 'ms-playwright');
  if (!existsSync(root)) {
    return undefined;
  }
  const candidates = readdirSync(root)
    .filter((name) => name.startsWith('chromium-'))
    .sort()
    .reverse();
  for (const name of candidates) {
    for (const relative of [
      path.join(name, 'chrome-win64', 'chrome.exe'),
      path.join(name, 'chrome-win', 'chrome.exe'),
      path.join(name, 'chrome-linux', 'chrome'),
      path.join(name, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ]) {
      const candidate = path.join(root, relative);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('缺少 playwright-core：先在仓库根执行 `npm i -D playwright-core`，再运行本脚本。');
  process.exit(2);
}

const R = (box) => ({
  top: Math.round(box.y * 10) / 10,
  bottom: Math.round((box.y + box.height) * 10) / 10,
  left: Math.round(box.x * 10) / 10,
  right: Math.round((box.x + box.width) * 10) / 10,
  width: Math.round(box.width * 10) / 10,
  height: Math.round(box.height * 10) / 10,
});
const intersects = (a, b) =>
  !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
const boxOf = async (locator) => {
  const box = await locator.boundingBox();
  return box === null ? null : R(box);
};

const executablePath = await resolveExecutable(chromium);
const browser = await chromium.launch({ executablePath, headless: true });
const report = { url: harnessUrl, at: new Date().toISOString(), viewports: [] };

for (const viewport of [
  { name: 'desktop-1280x800', width: 1280, height: 800 },
  { name: 'mobile-390x844', width: 390, height: 844 },
]) {
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('404')) {
      errors.push(message.text());
    }
  });

  await page.goto(harnessUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'abandon' }).waitFor({ timeout: 30000 });

  const nav = page.locator('[aria-label="移动端导航"]');
  const navVisible = await nav.isVisible();
  const result = { name: viewport.name, size: `${viewport.width}x${viewport.height}`, navVisible, checks: [], errors };

  const options = page.getByTestId('word-option');
  const actions = page.getByTestId('study-actions');

  await page.evaluate(() => window.scrollTo(0, 0));
  const optionCount = await options.count();
  const optionBoxes = [];
  for (let index = 0; index < optionCount; index += 1) {
    optionBoxes.push(await boxOf(options.nth(index)));
  }
  const actionsBox = await boxOf(actions);
  const sliderBox = await boxOf(page.locator('.MuiSlider-root').first());
  result.beforeSelect = { options: optionBoxes, actions: actionsBox, volumeSlider: sliderBox };

  // 选中正确答案 → 出现“认识/不认识”
  await page.getByRole('button', { name: '放弃', exact: true }).click();
  await page.waitForTimeout(400);
  const recognition = page.locator('[data-testid="study-actions"] button');
  const recognitionBoxes = [];
  for (let index = 0; index < (await recognition.count()); index += 1) {
    recognitionBoxes.push(await boxOf(recognition.nth(index)));
  }
  result.afterSelect = { actionButtons: recognitionBoxes };
  await page.screenshot({ path: path.join(outDir, `${viewport.name}-select.png`) });

  // 提交 → 反馈 + 下一题
  await page.getByRole('button', { name: '认识', exact: true }).click();
  const nextButton = page.getByRole('button', { name: /下一题|完成学习/ });
  await nextButton.waitFor({ timeout: 15000 });
  result.afterSubmit = { nextButton: await boxOf(nextButton) };
  await page.screenshot({ path: path.join(outDir, `${viewport.name}-feedback.png`) });

  for (const [index, box] of optionBoxes.entries()) {
    result.checks.push({ name: `option-${index}-vs-actions`, pass: actionsBox !== null && !intersects(box, actionsBox) });
    result.checks.push({ name: `volume-slider-vs-option-${index}`, pass: sliderBox !== null && !intersects(sliderBox, box) });
    for (let other = index + 1; other < optionBoxes.length; other += 1) {
      result.checks.push({ name: `option-${index}-vs-option-${other}`, pass: !intersects(box, optionBoxes[other]) });
    }
  }

  if (navVisible) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
    const navBox = await boxOf(nav);
    const nextBox = await boxOf(nextButton);
    const actionsBottom = await boxOf(actions);
    result.bottomScroll = { nav: navBox, next: nextBox, actions: actionsBottom };
    result.checks.push({ name: 'next-button-above-fixed-bottom-nav', pass: navBox !== null && nextBox !== null && nextBox.bottom <= navBox.top + 0.5 });
    result.checks.push({ name: 'actions-above-fixed-bottom-nav', pass: navBox !== null && actionsBottom !== null && actionsBottom.bottom <= navBox.top + 0.5 });
    await page.screenshot({ path: path.join(outDir, `${viewport.name}-bottom.png`) });
  } else {
    result.checks.push({ name: 'no-fixed-bottom-nav-on-desktop', pass: true });
  }

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  result.overflowX = overflow;
  result.checks.push({ name: 'no-horizontal-overflow', pass: overflow.scrollWidth <= overflow.innerWidth + 1 });

  for (const [index, box] of recognitionBoxes.entries()) {
    result.checks.push({ name: `recognition-${index}-min-height-44`, pass: box !== null && box.height >= 43.5 });
  }
  if (result.afterSubmit.nextButton !== null) {
    result.checks.push({ name: 'next-button-min-height-44', pass: result.afterSubmit.nextButton.height >= 43.5 });
  }

  report.viewports.push(result);
  await page.close();
}

await browser.close();
report.passed = report.viewports.every((viewport) => viewport.checks.every((check) => check.pass) && viewport.errors.length === 0);
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'layout-report.json'), JSON.stringify(report, null, 2), 'utf8');

for (const viewport of report.viewports) {
  const failed = viewport.checks.filter((check) => !check.pass);
  console.log(`${viewport.name}: ${viewport.checks.length - failed.length}/${viewport.checks.length} 通过${failed.length === 0 ? '' : `，失败：${failed.map((check) => check.name).join(',')}`}`);
}
console.log(report.passed ? '布局断言全部通过。' : '布局断言未通过。');
process.exit(report.passed ? 0 : 1);
