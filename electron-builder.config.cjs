/**
 * electron-builder 配置（由 `scripts/package-desktop.mjs` 以 `--config` 传入）。
 *
 * 这里只描述“怎么把已组装好的应用目录包成安装包”，不描述“应用里有什么文件”：
 * 应用内容由 `scripts/package-desktop.mjs` 组装（产物布局与 `package-win.mjs`
 * 真机安装验证过的一致），electron-builder 通过 `--prepackaged` 直接吃那个目录，
 * 因此它不会去下载 Electron 运行时、也不会重新猜 monorepo 的文件结构。
 *
 * 三条硬约束：
 * 1. `asar: false` —— `better-sqlite3` 是原生模块，打进 asar 必须 unpack，
 *    多一层“路径对不对”的排查成本，收益不值得（沿用 package-win.mjs 的结论）。
 * 2. `npmRebuild: false` —— prepackaged 目录里的 `.node` 已经是本平台预编译产物，
 *    重新 rebuild 需要 C++ 工具链，CI 上反而更容易失败。
 * 3. 不签名 —— 没有证书就如实未签名，绝不假装已签名（macOS 用户需右键打开）。
 *
 * @type {import('electron-builder').Configuration}
 */
module.exports = {
  appId: 'com.woyao.beidanci',
  productName: '我要背单词',
  copyright: 'Copyright (c) 2026 郑宇轩',
  asar: false,
  npmRebuild: false,
  buildDependenciesFromSource: false,
  // 发布包不需要开发依赖，也不该带 npm 生命周期脚本。
  removePackageScripts: true,
  directories: {
    output: 'release',
    buildResources: 'apps/electron/assets',
  },
  win: {
    target: [
      {
        target: 'nsis',
        arch: ['x64'],
      },
    ],
    icon: 'apps/electron/assets/icon.ico',
    executableName: 'woyao-beidanci',
    artifactName: 'woyao-beidanci-Setup-${version}.${ext}',
  },
  nsis: {
    // 不用一键安装：让用户能选安装位置（默认仍是 %LOCALAPPDATA%\Programs）。
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: '我要背单词',
    // 卸载时不要删用户的学习数据（数据在独立目录，删了无法恢复）。
    deleteAppDataOnUninstall: false,
    artifactName: 'woyao-beidanci-Setup-${version}.${ext}',
    installerLanguages: ['zh_CN'],
    language: '2052',
  },
  mac: {
    target: [
      {
        target: 'dmg',
        arch: ['arm64', 'x64'],
      },
    ],
    icon: 'apps/electron/assets/icon.png',
    category: 'public.app-category.education',
    identity: null,
  },
  dmg: {
    title: '我要背单词 ${version}',
    artifactName: 'woyao-beidanci-${version}.${ext}',
  },
};
