# WorkBuddy Cloud 兼容性核验（Task 10 前置）

> 真实 `publicConfig` 只存在 `.env.local`（被 git 忽略），本文件不记录 endpoint / key / resource id。

## 1. 环境状态

- 应用：`我要背单词`（复用已有应用，未重复开通）
- `billingStatus=normal`、`provisionStatus=assigned`、`reusedExisting=true`
- 四个模块共用一个环境；激活只发生一次。

## 2. 已验证的能力（2026-10-28）

| 能力 | 方式 | 结果 |
|---|---|---|
| LLM 模型目录 | 官方 SDK `cloud.llm.models.list()` | 35 个模型，35 个可用（`enabled !== false` 且未 `disabled`） |
| LLM 流式对话 | 官方 SDK `create({ stream: true })`，`deepseek-v4.1-flash` | 返回“连通正常”，`finish_reason=stop`，27 tokens |
| Database 管理面 | `workbuddy_cloudservice_db_list_tables` | 正常返回，当前 0 张表 |
| Auth 管理面 | `workbuddy_cloudservice_user_list_end_users` | 正常返回，当前 0 个终端用户 |
| Auth 数据面 | 官方 SDK `cloud.auth.getSession()` | 正常返回，未登录 `signedIn=false`；短信/邮件发送未实测 |
| Node 运行时 Origin | 上述 SDK 调用来自 Node（无浏览器 Origin） | 通过；**浏览器/Electron 的精确 Origin 仍需在发布域上验证** |

可复现命令：`npm run cloud:check`（需要 `.env.local`，只输出模型数量与回复文本，不输出任何密钥）。

## 3. 认证：已按两段式 OTP 实现

登录方式定为：**手机短信验证码（主）+ 邮箱验证码（辅助）**。

- `AuthGateway` / `AuthService` 已移除单步 `signIn({provider,credential})`，改为
  `requestOtp({channel,target})` → `verifyOtp({challengeId,isExistingUser,token,...})`。
- `packages/cloud` 的网关把 SDK 的 `sendOtp` / `verifyOtp` / `getSession` /
  `refreshSession` / `signOut` 映射为服务层会话；不含 QQ。
- 桌面端凭据用 Electron `safeStorage`（Windows DPAPI）加密后写
  `userData/cloud-auth.bin`；没有系统加密时直接不可用，不退回明文。
- 账号页有手机/邮箱页签、发码倒计时、错误提示与退出登录。

平台边界：

- **QQ 登录不可用**：WorkBuddy Cloud Auth 的 Provider 只有手机/邮箱 OTP、微信与
  WorkBuddy 账号；没有 QQ，不做假入口。
- **微信网页登录未接入**：`signInWithOAuth` 的 `redirectTo` 必须是已发布 HTTPS 域名，
  localhost/桌面 `app://` 不是有效回调域。发布后再加按钮与回调分发。
- **真实短信/邮件未实测**：没有用真实手机号触发发送；Provider 是否开启、额度是否充足
  需要在实际登录时验证，失败会如实显示云端错误。

## 4. Sync：云端没有表结构，仍不实现

`SyncGateway` 需要变更收件表、RLS 与游标函数；当前数据库 0 张表。在表结构、冲突策略、
匿名合并策略确定前写同步网关，只会得到一套无法验证的假实现。

## 5. LLM：已验证，适配器暂缓

`LlmPort.translate({ text, target })` 与 SDK 流式接口能对上；但当前没有在线翻译 UI
消费方，先写会是不可达代码。等在线功能接入时再注入。

## 6. 结论与下一步

- **Auth（手机/邮箱 OTP）已实现并有单测；未做真实短信验证，微信/QQ 见平台边界。**
- **Sync 未实现**：需要先在管理面建云表与 RLS。
- 没有使用 localStorage、假 session 或假同步作为替代。
- 下一步：用管理面建 `sync_changes` / `sync_cursors` 等表 → 实现 `SyncGateway` →
  接在线翻译 → 发布 HTTPS 后接微信登录并复测 Origin/OAuth。
