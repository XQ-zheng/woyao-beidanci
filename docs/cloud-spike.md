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
| Node 运行时 Origin | 上述 SDK 调用来自 Node（无浏览器 Origin） | 通过；**浏览器/Electron 的精确 Origin 仍需在发布域上验证** |

可复现命令：`npm run cloud:check`（需要 `.env.local`，只输出模型数量与回复文本，不输出任何密钥）。

## 3. 与现有服务契约的差异（未实现网关的原因）

### Auth：单步 `signIn` 与云端两步 OTP 对不上

`packages/services` 的 `AuthGateway.signIn({ provider, credential })` 假设一次调用就能换回
`AuthSession`；WorkBuddy Cloud 的邮箱/手机登录是：

```
sendOtp / signInWithOtp → 返回 verificationId + isExistingUser
verifyOtp({ verificationId, token, ... }) → 才建立 session
```

把验证码塞进 `credential`、或让服务层保存 `verificationId` 都会破坏“服务层无状态”的约定。
正确做法是把账号页改成两段式（获取验证码 → 提交验证码），并让 `AuthService` 暴露
`requestOtp` / `verifyOtp`，这是一次**契约变更**，不能在网关里悄悄糊过去。

### Sync：云端没有表结构，无法实现 push/pull

`SyncGateway` 需要 `entity_changes` 之类的收件表、RLS 与游标函数；当前数据库 0 张表。
在表结构、冲突策略、匿名合并策略确定前写同步网关，只会得到一套无法验证的假实现。

### LLM：可以直接实现，但暂无 UI 消费方

`LlmPort.translate({ text, target })` 与 SDK 的流式接口能对上（收集 chunk 后返回整段）。
不过 `OnlineService` 目前只在“在线翻译”路径调用它，而该路径还没有真实词典/在线能力与 UI
入口；先做适配器会是一段不可达代码。等账号/在线功能接入时再注入。

## 4. 结论

- **LLM 已验证可用**，可在后续实现 `LlmPort` 适配器；本次未写，避免死代码。
- **Auth 与 Sync 暂不实现**：前者需要修改服务契约与账号 UI，后者需要先设计云端表与 RLS。
- 没有使用 localStorage、假 session 或假同步作为替代。

## 5. 下一步（按顺序）

1. 产品确认登录方式（手机验证码 / 邮箱验证码 / WorkBuddy 账号登录）→ 改账号页为两段式。
2. 用管理面建 `sync_changes` / `sync_cursors` 等表与 RLS，再实现 `SyncGateway`。
3. 实现 `LlmPort` 并在在线翻译入口注入。
4. 发布到 HTTPS 域名后复测浏览器 Origin 与 OAuth 回跳（localhost 不是有效回调域）。
