import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { ReactElement } from 'react';
import { useState } from 'react';
import type { SyncReport } from '@woyao/services';

import { useServices } from '../services/ServiceProvider';
import { PageShell } from './PageShell';

/** 把异常压成可展示的一句话。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 同步状态的中文说明。 */
function syncStatusText(report: SyncReport): string {
  switch (report.status) {
    case 'OK':
      return '同步完成。';
    case 'PARTIAL':
      return '同步部分完成，有失败项。';
    case 'NOT_CONFIGURED':
      return '云服务未配置，本次没有执行任何同步。';
  }
}

/**
 * 账号页（`/account`）。
 *
 * 本轮云服务**尚未激活**：`auth.signIn` 会抛 `NotConfiguredError`，
 * `sync.synchronize()` 返回 `status: 'NOT_CONFIGURED'`。页面如实展示这两种事实，
 * 不显示假的“已登录 / 已同步”状态。
 */
export default function AccountPage(): ReactElement {
  const services = useServices();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  if (services === null) {
    return <PageShell title="账号" headingId="account-page-heading" />;
  }
  const activeServices = services;

  async function signIn(): Promise<void> {
    if (email.trim().length === 0) {
      setAuthError('请先填写邮箱。');
      return;
    }
    setBusy(true);
    setAuthError(null);
    try {
      await activeServices.auth.signIn({ provider: 'email', credential: email.trim() });
      // 走到这里说明云端真的可用；凭据存储是 Task 7/10 的事，本页不落地 token。
      setAuthError('登录已受理。凭据将交由桌面端安全存储（Task 7/10）。');
    } catch (cause: unknown) {
      setAuthError(`登录失败：${describeError(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  async function synchronize(): Promise<void> {
    setBusy(true);
    setSyncError(null);
    setReport(null);
    try {
      const result = await activeServices.sync.synchronize();
      setReport(result);
    } catch (cause: unknown) {
      setSyncError(`同步失败：${describeError(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell title="账号" headingId="account-page-heading">
      <Box sx={{ display: 'grid', gap: 3, maxWidth: 620 }}>
        <Alert severity="info">
          本地优先：不登录也能完整学习，所有记录先写到本机。匿名数据与账号数据默认**不自动合并**，
          合并策略在登录后由你选择。云服务（登录/同步/AI 翻译）预计在 Task 10 激活。
        </Alert>

        <Box sx={{ display: 'grid', gap: 1.5 }}>
          <Typography variant="subtitle1" component="h3">
            登录
          </Typography>
          <TextField
            size="small"
            label="邮箱"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            sx={{ maxWidth: 320 }}
          />
          <Box>
            <Button variant="contained" onClick={() => void signIn()} disabled={busy} sx={{ minHeight: 44 }}>
              登录
            </Button>
          </Box>
          {authError !== null ? (
            <Alert severity={authError.startsWith('登录失败') ? 'error' : 'info'}>{authError}</Alert>
          ) : null}
          <Typography variant="body2" color="text.secondary">
            未配置云服务时，登录会明确失败，而不是显示一个假的登录状态。
          </Typography>
        </Box>

        <Divider />

        <Box sx={{ display: 'grid', gap: 1.5 }}>
          <Typography variant="subtitle1" component="h3">
            云同步
          </Typography>
          <Box>
            <Button variant="outlined" onClick={() => void synchronize()} disabled={busy} sx={{ minHeight: 44 }}>
              立即同步
            </Button>
          </Box>
          {syncError !== null ? <Alert severity="error">{syncError}</Alert> : null}
          {report !== null ? (
            <Alert severity={report.status === 'OK' ? 'success' : report.status === 'PARTIAL' ? 'warning' : 'info'}>
              <Typography variant="body2">{syncStatusText(report)}</Typography>
              <Typography variant="body2">
                推送 {report.pushed} · 重复 {report.duplicates} · 拉取 {report.pulled} · 应用 {report.applied} ·
                冲突 {report.conflicts} · 错误 {report.errors}
              </Typography>
              {report.errorMessages.length > 0 ? (
                <Typography variant="body2" color="text.secondary">
                  {report.errorMessages.join('；')}
                </Typography>
              ) : null}
            </Alert>
          ) : null}
        </Box>

        <Divider />

        <Box sx={{ display: 'grid', gap: 1 }}>
          <Typography variant="subtitle1" component="h3">
            本地数据
          </Typography>
          <Typography variant="body2">
            学习记录、词库、单词本、错词与设置在本地数据库中；卸载应用前请先导出备份（导出能力在 Task 8 接入）。
          </Typography>
        </Box>
      </Box>
    </PageShell>
  );
}
