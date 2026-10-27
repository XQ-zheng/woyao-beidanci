# 第三方数据与许可核验记录

本项目代码使用 MIT。**数据文件的许可与代码许可分开处理**：不把“仓库是 MIT”误当成“里面的词典数据也能随便分发”。

## 候选来源与结论

| 来源 | 用途 | 许可现状 | 是否随包分发 |
|---|---|---|---|
| [ECDICT](https://github.com/skywind3000/ECDICT) | 英汉词典（词形、音标、中文释义、考试标签） | 仓库代码为 MIT；README 未对**词典数据**单独给出可再分发许可，数据来源为多方汇总 | **否**。只支持用户本地导入，manifest 中 `redistributionAllowed=false` |
| [exam-data/NETEMVocabulary](https://github.com/exam-data/NETEMVocabulary) | 考研词频与语料版本 | 数据为 **CC BY-NC-SA 4.0**（非商业 + 相同方式共享），代码为 MIT | **否**。本地导入需保留署名；商业分发前必须重新取得授权 |
| 发音音频 | 英/美音播放 | 尚未选定合规来源；不使用商业词典音频 | 否 |
| 图词联想素材 | 图词联想 | 尚未选定合规图库 | 否 |

## 规则

1. `manifest.json` 的条目必须有 `source`、`version`、`license`、`checksum(sha256)`；缺一项即视为非法清单。
2. 未核验许可的数据一律 `redistributionAllowed=false`，`validate-assets --bundle` 会直接拒绝。
3. 导入前校验文件 SHA-256；清单与文件不一致时拒绝导入，避免“导入了一份不知道是什么的数据”。
4. 考研词频没有可靠来源时，界面显示“未知”，不编造“高频/中频”。

## 字体

PDF 导出使用 Noto Sans SC（SIL Open Font License 1.1），许可见 `packages/exporters/fonts/OFL.txt`。
