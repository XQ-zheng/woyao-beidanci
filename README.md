# 我要背单词（woyao-beidanci）

> 本地优先的跨端英语单词学习应用：背单词、复习、词书、学习统计。
> 桌面端基于 Electron + React，数据全部存在你自己的电脑上。

![platform](https://img.shields.io/badge/Windows-10%2F11%20x64-0078D4)
![platform](https://img.shields.io/badge/macOS-%E6%9C%AA%E7%AD%BE%E5%90%8D-lightgrey)
![license](https://img.shields.io/badge/license-MIT-green)

---

## ⚠️ 重要提示（请先读这里）

1. **手机号 + 短信验证码登录路径存在 Bug，当前无法使用。** 即使填了正确的手机号、收到了短信，登录步骤也无法完成。这是一个已知问题，修复后会在这里更新。
2. **如果你需要登录，请使用「邮箱验证码」登录。** 账号页有两个 Tab，默认停在「手机验证码」上，请手动切到「邮箱验证码」。
   （补充说明：从 [Releases](../../releases) 下载的官方安装包**没有内置云服务配置**——仓库里不能放 key，CI 也没有。所以这些构建里账号页会显示「云服务未配置」，登录功能整体不可用；只有自己按[从源码构建](#从源码构建)填好 `.env.local`、并用 `--with-cloud` 打的包才带登录能力。）
3. **不登录也可以完整使用软件内的全部功能。** 本软件是本地优先的：词库、学习记录、错词、设置、统计全部保存在本机 SQLite 数据库里，登录只影响「云端账号」相关的部分（而云同步目前也尚未接入）。你可以完全不碰账号页。

---

## 项目简介

「我要背单词」是一款把「今日任务 → 逐词作答 → 复习调度 → 错词回收 → 数据复盘」串成闭环的背单词工具。它不依赖任何在线服务也能完成全部学习流程：安装完、打开、选词库、开始背，就这样。

- 主界面白底黑字，答对用绿色、答错用红色，仅表示学习反馈。
- 学习数据保存在本机 SQLite（`better-sqlite3`），默认位置在 `E:\我要背单词——相关文件夹`（没有 E 盘则回退到 Windows 用户数据目录，见[下载安装](#下载安装)）。
- 手机端、云端同步等能力还没有做完，具体状态见[平台支持矩阵](#平台支持矩阵)与[已知不足](#已知不足必须显式声明)。

## 功能特性

以下功能全部在应用里可以直接点到，不存在「文档里有、软件里没有」的条目。

### 学习与复习

- **今日学习**：显示当天的新词任务、到期复习任务、当前训练模式与题型，一键进入学习。
- **逐词作答**：默认英译中，可切换中译英与混合模式；选项含语义/拼写相似干扰项，可遮住中文翻译自测。
- **即时反馈**：答对绿色、答错红色，可选择「认识 / 不认识」；同一词累计错误 ≥ 2 次时会提示累计错误数。
- **发音**：每个词都带英式/美式音标与发音按钮，优先播放真人发音音频，网络不可用时自动回退到系统语音合成（TTS）。
- **收藏与详解**：学习页可随时把单词收进单词本，并展开查看简解、语境详解与多义项。
- **复习调度**：默认艾宾浩斯间隔，复习节点可自定义（如 `1,2,4,7,15,30` 天）；高频错词提高出现权重，正确率高则降低权重；标记「不再出现」后立刻退出队列。
- **完成统计**：一次学习结束展示当次新词数、复习数、学习时长与答对数。

### 词库与词表

- **内置词库**：四级（CET-4）、六级（CET-6）、考研英语、考研高频词，随安装包分发，离线可用。
- **自建词库**：新建自己的词库、往里面加词、软删除（词与历史记录仍保留在本地）。
- **批量导入**：手动输入英文单词/短语；或选择图片（自动 OCR 识别英文）、文档（Excel / Word / PDF / PPT / 文本）批量识别。每个词先查本地内置词典，查不到时用云端大模型生成释义；两者都失败则明确跳过并列出原因，不会塞进「暂无释义」的占位词条。
- **单词本**：收藏的单词集中管理，可随时收词/取词。

### 复盘与统计

- **错词库**：显示每个词的最近错误日期与累计错误次数，可重新加入学习或收藏。
- **历史**：最近 14 天的逐日统计（新词/复习/时长）与会话列表，按设置里的时区折算本地日期。
- **水平评估**：基于近期作答给出分数、等级、词库覆盖率、置信度与学习建议，并提供一组词汇速测题。样本不足时**不显示分数**，只说明「还没数据」——不会把 0 分当成成绩。

### 设置与桌面集成

- **每日计划**：每日新词上限、每日复习上限、复习节点、一个或多个学习时段。
- **训练偏好**：训练模式（英译中/中译英/混合）、题型、默认口音（英式/美式）、背词轮换顺序。
- **外观**：字号缩放、音量、界面字体（可搜索系统字体）、壁纸。
- **桌面专属**：开机自启、关闭窗口时最小化到托盘（两者默认关闭，可随时关掉）。
- **数据位置**：设置页可查看并迁移数据目录，迁移前会二次确认，迁移时复制而非移动（失败不影响原数据）。

### 账号（可选）

- 邮箱验证码登录 / 注册，支持记住登录与退出登录。
- 「立即同步」按钮存在，但云端同步表结构与 RLS 尚未设计，点击后会如实提示「云同步尚未接入」。

## 下载安装

### Windows 10/11 (x64)

1. 到 [Releases](../../releases) 页面，下载最新版的 `woyao-beidanci-Setup-x.y.z.exe`。
2. 双击安装。安装向导允许你改安装目录（默认装在 `%LOCALAPPDATA%\Programs\woyao-beidanci`），会创建桌面与开始菜单快捷方式。
3. 安装包**未做代码签名**，Windows SmartScreen 可能提示「Windows 已保护你的电脑」。点「更多信息」→「仍要运行」即可（源码全部在本仓库，你可以自己构建一份，见[从源码构建](#从源码构建)）。
4. 卸载：在「设置 → 应用」或「控制面板 → 程序和功能」里卸载。**卸载不会删除你的学习数据。**

**数据存放位置**（**由应用在首次启动时自行判断，安装包里不固化任何路径**）：

- Windows 上有 E 盘时，数据默认放在 `E:\我要背单词——相关文件夹`（数据库 `woyao.sqlite3`、日志、本地存储都在这里）。
- 没有 E 盘时，回退到 Electron 的默认用户数据目录：`%APPDATA%\woyao-beidanci`（即 `C:\Users\<你>\AppData\Roaming\woyao-beidanci`）。
- 在「设置 → 数据位置」里可以看到当前实际路径，也可以改到别的地方（会复制既有数据过去）。改过一次之后，这个位置会记录在安装目录的 `resources\data-location.json` 里——**这个文件只会由应用在运行时写入，发布包里没有它**。

### macOS（Apple Silicon / Intel）

> **先说清楚：macOS 产物从未被验证过。** 本项目只在 Windows 上有真实的构建、安装与启动记录；dmg 由 GitHub Actions 在 macOS 机器上按同一套脚本组装（复制 `Electron.app` → 改 Info.plist 与二进制名 → `hdiutil` 打包），但**开发者手上没有 macOS 机器，也没有跑过一次 CI**。也就是说：产物可能存在、可能直接跑不起来，下载前请知悉这是「尽力构建」而非「已验证可用」。

1. 到 [Releases](../../releases) 下载对应架构的 dmg：`woyao-beidanci-x.y.z-arm64.dmg`（Apple Silicon）或 `woyao-beidanci-x.y.z-x64.dmg`（Intel）。是否真的存在取决于 CI 那次构建有没有成功（Intel 那份用的是逐步退役的 `macos-13` 镜像，可能直接不可用）。
2. 打开 dmg，把「我要背单词」拖进「应用程序」。
3. **本应用未做苹果代码签名与公证（notarization）**，首次打开会被 Gatekeeper 拦下。解决方法任选一个：
   - 在 Finder 里**右键点击应用图标 → 打开 → 再点「打开」**；
   - 或先尝试双击，然后在「系统设置 → 隐私与安全性」页面底部点「仍要打开」。
4. 若提示「应用已损坏」，通常是 dmg 下载不完整或隔离属性异常，可执行：
   ```bash
   xattr -dr com.apple.quarantine /Applications/我要背单词.app
   ```

## 平台支持矩阵

| 平台 | 状态 | 安装包 |
| --- | --- | --- |
| Windows 10 / 11 x64 | ✅ 支持（已构建、已启动验证） | `woyao-beidanci-Setup-x.y.z.exe`（NSIS 安装版） |
| macOS（Apple Silicon / Intel） | ⚠️ 未验证（未签名、未公证、未跑过真机） | `woyao-beidanci-x.y.z-arm64.dmg` / `woyao-beidanci-x.y.z-x64.dmg`——由 CI 尽力构建，可能缺失或无法启动 |
| Android | ❌ 暂不支持 | 无。应用基于 Electron 桌面架构，主进程承载 SQLite、文件系统与 IPC 桥接；移动端需要重写存储层（换 `@capacitor-community/sqlite`）与整套原生桥，已列入 v1.1 路线图。 |
| iOS | ❌ 暂不支持 | 无。技术原因同 Android，另外还需要 Apple 开发者账号才能签名分发。 |
| Linux | ❌ 暂未验证 | 无。源码理论上可构建，但没有做过任何验证，因此不提供产物、也不声称支持。 |

**手机端替代建议**：`apps/web` 是一套纯浏览器可运行的 React 界面（`vite build` 产物即可用任意静态服务器托管），在没有登录/云同步的前提下，它需要配合桌面端的数据才能发挥作用；因此现阶段手机端只能算「勉强能看」，不是可用方案。真正可用的手机端要等 v1.1。

## 已知不足（必须显式声明）

**本软件在设计上仍然很简陋，存在许多不足。** 这里如实列出，不做美化：

1. **手机号 + 短信验证码登录存在 Bug，当前不可用**（修好后应改用邮箱验证码登录；而下面第 12 条又会说明发布包里连邮箱登录也用不了）。
2. **云同步没有实现**：账号页的「立即同步」只会提示「云同步尚未接入」。也就是说，两台设备之间**无法同步**学习进度、词库、错词与设置，多设备用户目前只能各背各的。
3. **导出功能没有接入界面**：服务层已经能生成 Word / PDF / Excel（`docx`、`exceljs`、`pdfkit` 与内置中文字体都已随包分发），但页面上还没有导出按钮，用户拿不到这些文件。
4. **没有自动更新**：升级只能手动去 Releases 下载新版本覆盖安装。
5. **安装包未签名**：Windows 会弹 SmartScreen 提示，macOS 需要右键打开；也没有公证，企业环境可能直接拦截。
6. **界面主要按桌面分辨率设计**：窄窗口、小屏幕、高 DPI 缩放下布局会挤，响应式适配做得不完整，个别弹层在极小窗口下可能遮挡内容。
7. **发音依赖在线音频**：真人发音来自在线词典接口，断网或接口变动时回退系统 TTS（机器音），且**没有音频缓存管理**——重复播放会重复请求，离线时听不到真人音，也不会提示原因。
8. **词库导入格式单一**：只导入「英文词形」，音标、例句、词性、搭配等都靠内置词典或大模型补，导入自定义词表时无法保留原始释义排版。
9. **没有移动端**：Android / iOS 都不支持（原因见上表）。
10. **错误提示偏粗糙**：多数失败场景只给一句「XX 失败：<原始错误>」，没有操作建议，也没有一键重试。
11. **没有系统通知提醒**：设置里能配学习时段，但到点不会弹系统通知（该能力未实现）。
12. **官方 Release 安装包不含云服务配置**：仓库里不能放 key、CI 也没有，所以下载版打开账号页只会看到「云服务未配置」，邮箱登录也不可用。想要带登录的包，得自己填 `.env.local` 后用 `--with-cloud` 重新构建。
13. **云同步缺失导致「记住登录」只能单机生效**，换机器等于重新开始。
14. **macOS 产物从未被验证**：没有 macOS 机器、也没跑过 CI，dmg 只是「尽力构建」，不保证存在、也不保证能启动（详见上文 macOS 小节）。
15. **数据目录只在启动时判断一次**：应用启动时若检测到 E 盘就把数据放过去；如果用户之后把 E 盘拔了/改名，启动会因为数据目录不存在而失败——目前没有「引导路径失效自动回退」的保护。

以上问题**后续会持续优化**，优先级与进度见[路线图](#路线图roadmap)。

## 从源码构建

环境要求：**Node.js ≥ 22.12**、npm ≥ 10。

```bash
git clone <this-repo>
cd woyaobeidanci
npm ci
```

### 开发

```bash
npm run dev        # 启动 Vite 开发服务器（浏览器里跑界面）
npm run typecheck  # 全仓库类型检查
npm run lint       # ESLint
npm run test       # 单元测试（Vitest）
```

> 开发态在浏览器里跑时，SQLite / 文件导入 / 托盘等桌面能力不可用，需要桌面壳：
> 先 `npm run build`，再 `npm run start --workspace @woyao/electron`。

### 构建与打包

```bash
npm run build          # 构建全部 workspace（web 产物 → dist/apps/web，主进程 → apps/electron/dist）

# 方式一：安装包（对外发布用，产物落在 release/）
npm run package:exe    # Windows：release/woyao-beidanci-Setup-<version>.exe（NSIS 安装版）
npm run package:dmg    # macOS：release/woyao-beidanci-<version>-<arch>.dmg（需在 macOS 上执行）

# 方式二：只组装、不打包（排查目录结构用）
npm run package:dir    # build/desktop/<platform>-<arch>/

# 方式三：开发机自用的一键安装（Windows，会覆盖安装到 E:\我要背单词——相关文件夹\程序）
npm run package:win

# 自用分发：把 .env.local 里的云公共配置嵌进安装包（发布版默认不嵌，见下）
npm run package:exe -- --with-cloud
```

打包脚本说明：

- `scripts/package-desktop.mjs`：跨平台组装 + 出安装包。Windows 分支把 `electron.exe` 改名并交给 electron-builder 打 NSIS；macOS 分支把 `Electron.app` 改成 `我要背单词.app`（改 Info.plist、改二进制名）后用系统 `hdiutil` 生成 dmg，全程零下载。
- `scripts/package-win.mjs`：保留的本机安装脚本，组装完直接覆盖安装到 `E:\我要背单词——相关文件夹\程序` 并创建快捷方式，不是安装包。
- 两者都**不使用 asar**：`better-sqlite3` 是原生模块，必须保持未压缩的实体文件，否则加载失败。
- 发布态的两条固定行为（不是“看有没有文件就写”，否则同一版本在不同机器上产出的包内容会不一样）：
  1. **不写 `resources/data-location.json`**：运行期读到它就不再校验盘符，把打包机的 `E:\...` 烤进包会让没有 E 盘的用户装完打不开应用；
  2. **不嵌 `resources/cloud-config.json`**：需要时显式加 `--with-cloud`。

### 云服务配置（可选）

不配置也能用——只是账号页会显示「云服务未配置」，导入时跳过 AI 补释义。
需要时可 `cp .env.example .env.local`，填入 WorkBuddy Cloud 的公开配置（`VITE_WB_CLOUD_*`）。

开发态（`npm run dev` / `npm run start --workspace @woyao/electron`）会自动读 `.env.local`；
打包成安装包时，配置**默认不会**被嵌入（见上一节的「发布态两条固定行为」），要嵌请加 `--with-cloud`。

> **绝对不要把 `.env.local` 提交到仓库**。它已被 `.gitignore` 忽略；仓库里只有 `.env.example` 这种空壳模板。
> 打包脚本只在 `.env.local` 存在时才把配置写进产物的 `resources/cloud-config.json`，没有就跳过（CI 上不会有）。

## 目录结构

```text
.
├── apps
│   ├── web                 # React 19 + MUI + Tailwind 界面（页面、路由、hooks、服务装配）
│   └── electron            # Electron 45 主进程、preload 安全桥、托盘/自启/数据位置
├── packages
│   ├── core                # 纯 TS 领域逻辑：调度、出题、干扰项、水平评估、频率
│   ├── data                # SQLite migration、Repository、导入校验
│   ├── services            # 应用用例：学习、词库、导入、导出、账号、同步端口
│   ├── cloud               # WorkBuddy Cloud 适配（认证网关、LLM、公共配置）
│   ├── importer            # OCR / 文档解析、内置词库与 tessdata
│   ├── exporters           # Word / PDF / Excel 导出与中文字体
│   └── assets              # 资源清单与许可
├── scripts                 # 打包、导入词库、校验资源等运维脚本
├── docs                    # PRD、系统设计、架构与序列图
├── electron-builder.config.cjs   # 安装包配置（asar: false）
├── vite.config.ts          # 根 Vite 配置（别名、base、产物目录）
└── release/                # 安装包产物（git 忽略）
```

## 技术栈

| 层 | 选型 |
| --- | --- |
| 界面 | React 19、React Router 7、MUI 9、Tailwind CSS 4、Vite 8 |
| 桌面壳 | Electron 45（主进程 + preload 白名单 IPC，渲染进程不开 Node 集成） |
| 数据 | SQLite（`better-sqlite3`，本机文件）、本地 migration |
| 领域层 | TypeScript 严格模式，纯函数实现调度/出题/评估 |
| 导入 | `tesseract.js`（OCR）、`pdfjs-dist`（PDF）、`exceljs` / `docx`（Office 文档） |
| 导出 | `docx`、`exceljs`、`pdfkit` + Noto Sans SC 字体 |
| 测试 | Vitest、React Testing Library |
| 打包 | electron-builder（Windows NSIS）、`hdiutil`（macOS dmg） |

## 路线图（Roadmap）

**v1.0（当前，版本号 1.0.0）**：Windows 安装包（已构建、已启动验证）；macOS dmg 由 CI 尽力构建、**尚未验证**。本地学习闭环、内置四/六/考研词库、批量导入、错词与历史统计、水平评估。

**v1.1（计划）**

- 修复手机号 + 短信验证码登录。
- 接入云同步（表结构、RLS、冲突合并、断网重连去重）。
- 把 Word / PDF / Excel 导出接到界面上（服务层已就绪）。
- 补齐响应式适配，优化窄窗口与小屏布局。
- 学习时段的系统通知提醒。

**v2.0（探索）**

- Android / iOS：重写存储层与原生桥接（Capacitor），复用现有 UI 与领域逻辑。
- 自动更新（签名后再做，否则更新链路本身不可信）。
- 更多词库、图词联想资源、学习趋势图表。

## 贡献指南

欢迎 Issue 与 PR，请注意几点：

1. **不要提交任何密钥/凭据**（`.env.local`、token、`publishableKey`）。提交前自查 `git diff`。
2. 提交信息用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：`feat:`、`fix:`、`docs:`、`build:`、`chore:`……
3. 改动前后请跑：
   ```bash
   npm run typecheck && npm run lint && npm run test
   ```
4. 新增运行期依赖如果要进安装包，记得同步 `scripts/package-desktop.mjs` 与 `scripts/package-win.mjs` 里的 `RUNTIME_DEPENDENCIES`（打包脚本会校验主进程产物里 `require()` 的裸模块，漏了会直接失败）。
5. 不要引入第三方未授权词库、音频、图片或界面资源；MIT 只覆盖本仓库有权开放的代码与明文列出的自有资源。

## License

代码采用 [MIT License](./LICENSE)，Copyright (c) 2026 郑宇轩。

随包分发的第三方资源另有其许可证（例如 PDF 中文字体 Noto Sans SC 为 SIL Open Font License，许可证文件随安装包放在 `resources/fonts/` 下）。MIT 不自动授予第三方词库、字体、音频或图片的再分发权。
