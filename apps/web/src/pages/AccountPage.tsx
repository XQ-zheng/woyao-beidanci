import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import type { AuthSession, OtpChallengeView, SyncReport } from '@woyao/services';

import { useServices } from '../services/ServiceProvider';
import { PageShell } from './PageShell';

/** 手机号（大陆 11 位）。 */
const PHONE_PATTERN = /^1\d{10}$/u;
/** 邮箱的宽松校验：真正的合法性由云端发码接口判定。 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
/** 发码后倒计时秒数。 */
const RESEND_SECONDS = 60;

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
      return '云同步尚未接入，本次没有执行任何同步。';
  }
}

/**
 * 账号页（`/account`）。
 *
 * 登录采用 WorkBuddy Cloud 真实支持的两段式 OTP：手机短信为主、邮箱验证码为辅。
 * 微信网页登录需要发布后的 HTTPS 域名，QQ 没有 Provider，两者都不做假入口。
 * token 不显示在界面上，桌面端由主进程用系统安全存储落盘。
 */
export default function AccountPage(): ReactElement {
  const services = useServices();
  const [session, setSession] = useState<AuthSession | null>(null);
  const [channel, setChannel] = useState<'phone' | 'email'>('phone');
  const [target, setTarget] = useState('');
  const [token, setToken] = useState('');
  const [challenge, setChallenge] = useState<OtpChallengeView | null>(null);
  const [sentTo, setSentTo] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  // 首屏恢复登录态；未配置云时如实显示错误，不伪造“已登录”。
  useEffect(() => {
    if (services === null) {
      return;
    }
    let active = true;
    void services.auth
      .getSession()
      .then((current) => {
        if (active) {
          setSession(current);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setAuthError(`读取登录状态失败：${describeError(cause)}`);
        }
      });
    return () => {
      active = false;
    };
  }, [services]);

  // 重新发码倒计时。
  useEffect(() => {
    if (countdown <= 0) {
      return;
    }
    const timer = window.setInterval(() => {
      setCountdown((value) => Math.max(0, value - 1));
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [countdown]);

  if (services === null) {
    return <PageShell title="账号" headingId="account-page-heading" />;
  }
  const activeServices = services;

  /** 校验当前输入；返回错误文案或 null。 */
  function validateTarget(): string | null {
    const value = target.trim();
    if (value.length === 0) {
      return channel === 'phone' ? '请先填写手机号。' : '请先填写邮箱。';
    }
    if (channel === 'phone' && !PHONE_PATTERN.test(value)) {
      return '请输入正确的 11 位手机号。';
    }
    if (channel === 'email' && !EMAIL_PATTERN.test(value)) {
      return '请输入正确的邮箱地址。';
    }
    return null;
  }

  async function sendCode(): Promise<void> {
    const invalid = validateTarget();
    if (invalid !== null) {
      setAuthError(invalid);
      return;
    }
    const value = target.trim();
    setSending(true);
    setAuthError(null);
    setNotice(null);
    try {
      const result = await activeServices.auth.requestOtp({ channel, target: value });
      setChallenge(result);
      setSentTo(value);
      setCountdown(RESEND_SECONDS);
      setNotice('验证码已发送，请查看手机短信或邮箱。');
    } catch (cause: unknown) {
      setChallenge(null);
      setAuthError(`发送验证码失败：${describeError(cause)}`);
    } finally {
      setSending(false);
    }
  }

  async function verifyCode(): Promise<void> {
    if (challenge === null || sentTo !== target.trim()) {
      setAuthError('请先为当前手机号/邮箱获取验证码。');
      return;
    }
    if (token.trim().length === 0) {
      setAuthError('请输入验证码。');
      return;
    }
    setVerifying(true);
    setAuthError(null);
    setNotice(null);
    try {
      const signedIn = await activeServices.auth.verifyOtp({
        channel,
        target: sentTo,
        challengeId: challenge.challengeId,
        isExistingUser: challenge.isExistingUser,
        token: token.trim(),
      });
      setSession(signedIn);
      setChallenge(null);
      setToken('');
      setCountdown(0);
      setNotice('登录成功。');
    } catch (cause: unknown) {
      setAuthError(`验证码校验失败：${describeError(cause)}`);
    } finally {
      setVerifying(false);
    }
  }

  async function signOut(): Promise<void> {
    if (session === null) {
      return;
    }
    setVerifying(true);
    setAuthError(null);
    try {
      await activeServices.auth.signOut(session);
      setSession(null);
      setNotice('已退出登录，本地学习数据不受影响。');
    } catch (cause: unknown) {
      setAuthError(`退出登录失败：${describeError(cause)}`);
    } finally {
      setVerifying(false);
    }
  }

  async function synchronize(): Promise<void> {
    setVerifying(true);
    setSyncError(null);
    setReport(null);
    try {
      const result = await activeServices.sync.synchronize();
      setReport(result);
    } catch (cause: unknown) {
      setSyncError(`同步失败：${describeError(cause)}`);
    } finally {
      setVerifying(false);
    }
  }

  return (
    <PageShell title="账号" headingId="account-page-heading">
      <Box sx={{ display: 'grid', gap: 3, maxWidth: 620 }}>
        <Alert severity="info">
          本地优先：不登录也能完整学习，所有记录先写到本机。匿名数据与账号数据默认**不自动合并**，
          合并策略在登录后由你选择。云服务已激活，登录凭据由桌面端系统安全存储加密保存。
        </Alert>

        {session !== null ? (
          <Box sx={{ display: 'grid', gap: 1.5 }}>
            <Typography variant="subtitle1" component="h3">
              已登录
            </Typography>
            <Alert severity="success">账号已登录。token 不会显示在界面上，也不会写进日志。</Alert>
            <Box>
              <Button variant="outlined" onClick={() => void signOut()} disabled={verifying} sx={{ minHeight: 44 }}>
                退出登录
              </Button>
            </Box>
            {notice !== null ? <Alert severity="info">{notice}</Alert> : null}
            {authError !== null ? <Alert severity="error">{authError}</Alert> : null}
          </Box>
        ) : (
          <Box sx={{ display: 'grid', gap: 1.5 }}>
            <Typography variant="subtitle1" component="h3">
              登录
            </Typography>
            <Tabs
              value={channel}
              onChange={(_, value: string) => {
                if (value !== 'phone' && value !== 'email') {
                  return;
                }
                setChannel(value);
                setChallenge(null);
                setSentTo('');
                setToken('');
                setCountdown(0);
                setAuthError(null);
                setNotice(null);
              }}
              aria-label="登录方式"
            >
              <Tab value="phone" label="手机验证码" />
              <Tab value="email" label="邮箱验证码（辅助）" />
            </Tabs>

            <TextField
              size="small"
              label={channel === 'phone' ? '手机号' : '邮箱'}
              type={channel === 'phone' ? 'tel' : 'email'}
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
                setChallenge(null);
                setSentTo('');
                setAuthError(null);
              }}
              autoComplete={channel === 'phone' ? 'tel' : 'email'}
              helperText={channel === 'phone' ? '大陆 11 位手机号' : '用于辅助登录，可选'}
              sx={{ maxWidth: 360 }}
            />

            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button
                variant="outlined"
                onClick={() => void sendCode()}
                disabled={sending || countdown > 0}
                sx={{ minHeight: 44 }}
              >
                {sending ? '正在发送…' : countdown > 0 ? `${countdown} 秒后重试` : '获取验证码'}
              </Button>
              <Typography variant="body2" color="text.secondary">
                验证码由 WorkBuddy Cloud 发送
              </Typography>
            </Box>

            <TextField
              size="small"
              label="验证码"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              slotProps={{ htmlInput: { inputMode: 'numeric', autoComplete: 'one-time-code' } }}
              sx={{ maxWidth: 200 }}
            />

            <Box>
              <Button variant="contained" onClick={() => void verifyCode()} disabled={verifying} sx={{ minHeight: 44 }}>
                {verifying ? '正在验证…' : '登录 / 注册'}
              </Button>
            </Box>

            {notice !== null ? <Alert severity="success">{notice}</Alert> : null}
            {authError !== null ? <Alert severity="error">{authError}</Alert> : null}

            <Typography variant="body2" color="text.secondary">
              微信登录需要应用发布到 HTTPS 域名后才能接入回调；QQ 登录在 WorkBuddy Cloud Auth 中没有
              Provider，因此不提供假入口。当前可用方式为手机短信验证码（主）与邮箱验证码（辅助）。
            </Typography>
          </Box>
        )}

        <Divider />

        <Box sx={{ display: 'grid', gap: 1.5 }}>
          <Typography variant="subtitle1" component="h3">
            云同步
          </Typography>
          <Box>
            <Button variant="outlined" onClick={() => void synchronize()} disabled={verifying} sx={{ minHeight: 44 }}>
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
            学习记录、词库、单词本、错词与设置在本地数据库中；退出登录不会删除本地学习数据。
          </Typography>
        </Box>
      </Box>
    </PageShell>
  );
}
