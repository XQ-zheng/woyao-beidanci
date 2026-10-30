import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
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
/** 「下次自动登录」偏好的本地存储键（`'0'` 表示关闭，缺省视为开启）。 */
const AUTO_LOGIN_STORAGE_KEY = 'woyao.autoLogin';
/** 点击按钮表达的用户意图：登录已有账号，还是注册新账号。 */
type AuthIntent = 'signIn' | 'signUp';

/** 手机国际区号选项（常见国家/地区；默认中国大陆 +86）。 */
const DIALING_CODES: ReadonlyArray<{ readonly code: string; readonly label: string }> = [
  { code: '+86', label: '中国大陆' },
  { code: '+852', label: '中国香港' },
  { code: '+853', label: '中国澳门' },
  { code: '+886', label: '中国台湾' },
  { code: '+1', label: '美国 / 加拿大' },
  { code: '+44', label: '英国' },
  { code: '+61', label: '澳大利亚' },
  { code: '+65', label: '新加坡' },
  { code: '+81', label: '日本' },
  { code: '+82', label: '韩国' },
  { code: '+60', label: '马来西亚' },
  { code: '+66', label: '泰国' },
  { code: '+33', label: '法国' },
  { code: '+49', label: '德国' },
];

/** 区号默认值（中国大陆）。 */
const DEFAULT_DIALING_CODE = '+86';

/** 把异常压成可展示的一句话。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 归一化用户输入：全角数字/字母转半角，去掉所有空白。
 *
 * 中文输入法下「１２３４５６」这类全角数字很常见，直接提交只会换回一句
 * 「验证码不匹配」，用户完全看不出是自己输错了字符宽度。
 *
 * @param value 原始输入。
 * @returns 半角、无空白的字符串。
 */
function normalizeInput(value: string): string {
  return value
    .replace(/[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/gu, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0xfee0),
    )
    .replace(/\s+/gu, '');
}

/**
 * 按渠道归一化验证码：手机只保留数字，邮箱只去空白。
 *
 * @param value 原始输入。
 * @param channel 渠道。
 * @returns 可提交的验证码。
 */
function normalizeCode(value: string, channel: 'phone' | 'email'): string {
  const ascii = normalizeInput(value);
  return channel === 'phone' ? ascii.replace(/\D+/gu, '') : ascii;
}

/**
 * 脱敏展示手机号/邮箱，避免把完整号码铺在提示语里。
 *
 * @param target 手机号或邮箱。
 * @param channel 渠道。
 * @returns 脱敏后的文本。
 */
function maskTarget(target: string, channel: 'phone' | 'email'): string {
  if (channel === 'phone') {
    // 手机号带区号（如 `+86 13790758356`），只对末尾号码脱敏，保留区号前缀。
    const digits = target.replace(/\D+/gu, '');
    if (digits.length >= 11) {
      const local = digits.slice(-11);
      return `${target.slice(0, target.length - local.length)}${local.slice(0, 3)}****${local.slice(-4)}`;
    }
    return target;
  }
  const at = target.indexOf('@');
  if (channel === 'email' && at > 1) {
    return `${target.slice(0, 2)}***${target.slice(at)}`;
  }
  return target;
}

/**
 * 读取「下次自动登录」偏好。读不到时按开启处理（用户没设过就当想省事）。
 *
 * @returns 是否自动登录。
 */
function readAutoLoginPreference(): boolean {
  try {
    return window.localStorage.getItem(AUTO_LOGIN_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

/**
 * 写入「下次自动登录」偏好；隐私模式下写失败就静默忽略（不影响本次登录）。
 *
 * @param value 是否自动登录。
 */
function writeAutoLoginPreference(value: boolean): void {
  try {
    window.localStorage.setItem(AUTO_LOGIN_STORAGE_KEY, value ? '1' : '0');
  } catch {
    // 存储不可用时只影响“下次”，本次登录仍然有效。
  }
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
 * 「登录」与「注册」是两个独立按钮，但共用同一次发码——上游按 `isExistingUser`
 * 判断走登录还是注册，点错按钮时直接指路改点另一个，别把验证码白白消耗掉。
 * token 不显示在界面上，桌面端由主进程用系统安全存储落盘。
 */
export default function AccountPage(): ReactElement {
  const services = useServices();
  const [session, setSession] = useState<AuthSession | null>(null);
  const [channel, setChannel] = useState<'phone' | 'email'>('phone');
  const [dialingCode, setDialingCode] = useState<string>(DEFAULT_DIALING_CODE);
  const [target, setTarget] = useState('');
  const [token, setToken] = useState('');
  const [challenge, setChallenge] = useState<OtpChallengeView | null>(null);
  const [sentTo, setSentTo] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authHint, setAuthHint] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [autoLogin, setAutoLogin] = useState<boolean>(readAutoLoginPreference);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  // 首屏恢复登录态；未配置云时如实显示错误，不伪造“已登录”。
  // 用户关掉「下次自动登录」时，下一次打开就静默退出上次的会话。
  useEffect(() => {
    if (services === null) {
      return;
    }
    let active = true;
    void services.auth
      .getSession()
      .then(async (current) => {
        if (!active) {
          return;
        }
        if (current !== null && !readAutoLoginPreference()) {
          await services.auth.signOut(current).catch(() => undefined);
          if (active) {
            setSession(null);
            setNotice('已按「下次自动登录」的关闭设置退出上次登录，请重新登录。');
          }
          return;
        }
        setSession(current);
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
    const value = normalizeInput(target);
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
    const value = normalizeInput(target);
    // 手机号拼上区号（服务端要求 E.164 国际格式：`+86 13790758356`）。
    const fullTarget = channel === 'phone' ? `${dialingCode} ${value}` : value;
    setSending(true);
    setAuthError(null);
    setAuthHint(null);
    setNotice(null);
    try {
      const result = await activeServices.auth.requestOtp({ channel, target: fullTarget });
      setChallenge(result);
      setSentTo(fullTarget);
      setCountdown(RESEND_SECONDS);
      setNotice(`验证码已发送至 ${maskTarget(fullTarget, channel)}，只有最新一条有效。`);
    } catch (cause: unknown) {
      setChallenge(null);
      setAuthError(`发送验证码失败：${describeError(cause)}`);
    } finally {
      setSending(false);
    }
  }

  /**
   * 验码并完成登录或注册。
   *
   * @param intent 用户点的是「登录」还是「注册」。
   */
  async function verifyCode(intent: AuthIntent): Promise<void> {
    const value = normalizeInput(target);
    const fullTarget = channel === 'phone' ? `${dialingCode} ${value}` : value;
    if (challenge === null || sentTo !== fullTarget) {
      setAuthError('请先为当前手机号/邮箱获取验证码。');
      return;
    }
    const code = normalizeCode(token, channel);
    if (code.length === 0) {
      setAuthError('请输入验证码。');
      return;
    }
    // 「是否已注册」由发码接口给出；点错按钮时先指路，别让服务端把验证码消耗掉。
    if (intent === 'signIn' && !challenge.isExistingUser) {
      setAuthError('该手机号还没有注册，请点「注册」完成首次注册。');
      return;
    }
    if (intent === 'signUp' && challenge.isExistingUser) {
      setAuthError('此账号已经成功注册，请点击登录。');
      return;
    }
    setVerifying(true);
    setAuthError(null);
    setAuthHint(null);
    setNotice(null);
    try {
      const signedIn = await activeServices.auth.verifyOtp({
        channel,
        target: sentTo,
        challengeId: challenge.challengeId,
        isExistingUser: challenge.isExistingUser,
        token: code,
      });
      setSession(signedIn);
      setChallenge(null);
      setToken('');
      setCountdown(0);
      setNotice(intent === 'signUp' ? '注册成功，已自动登录。下次打开直接点「登录」即可。' : '登录成功。');
    } catch (cause: unknown) {
      setAuthError(`验证码校验失败：${describeError(cause)}`);
      // 失败后这次 challenge 基本作废（码错/过期/已被用掉），立刻清掉并放开重发，
      // 否则用户只能对着 60 秒倒计时干等。
      setChallenge(null);
      setSentTo('');
      setCountdown(0);
      setAuthHint('已重置验证码状态：请重新点「获取验证码」，并只填最新一条短信里的数字。');
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
              登录 / 注册
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
                setAuthHint(null);
                setNotice(null);
              }}
              aria-label="登录方式"
            >
              <Tab value="phone" label="手机验证码" />
              <Tab value="email" label="邮箱验证码" />
            </Tabs>

            {channel === 'phone' ? (
              <TextField
                size="small"
                label="手机号"
                type="tel"
                value={target}
                onChange={(event) => {
                  setTarget(event.target.value);
                  setChallenge(null);
                  setSentTo('');
                  setAuthError(null);
                  setAuthHint(null);
                }}
                autoComplete="tel"
                helperText="大陆 11 位手机号"
                sx={{ maxWidth: 360 }}
                slotProps={{
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">
                        <Select
                          value={dialingCode}
                          onChange={(event) => {
                            setDialingCode(event.target.value);
                            setChallenge(null);
                            setSentTo('');
                            setAuthError(null);
                            setAuthHint(null);
                          }}
                          variant="standard"
                          disableUnderline
                          aria-label="国际区号"
                          sx={{
                            minWidth: 88,
                            '& .MuiSelect-select': { py: 0.5, pr: 2 },
                          }}
                          MenuProps={{
                            anchorOrigin: { vertical: 'bottom', horizontal: 'left' },
                            transformOrigin: { vertical: 'top', horizontal: 'left' },
                          }}
                        >
                          {DIALING_CODES.map((option) => (
                            <MenuItem key={option.code} value={option.code}>
                              {option.code} {option.label}
                            </MenuItem>
                          ))}
                        </Select>
                      </InputAdornment>
                    ),
                  },
                }}
              />
            ) : (
              <TextField
                size="small"
                label="邮箱"
                type="email"
                value={target}
                onChange={(event) => {
                  setTarget(event.target.value);
                  setChallenge(null);
                  setSentTo('');
                  setAuthError(null);
                  setAuthHint(null);
                }}
                autoComplete="email"
                helperText="与手机号同等的主要登录方式"
                sx={{ maxWidth: 360 }}
              />
            )}

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
              helperText="新用户点「注册」，老用户点「登录」；同一次发码两个按钮通用"
              sx={{ maxWidth: 360 }}
            />

            <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button
                variant="contained"
                onClick={() => void verifyCode('signIn')}
                disabled={verifying}
                sx={{ minHeight: 44, minWidth: 120 }}
              >
                {verifying ? '正在验证…' : '登录'}
              </Button>
              <Button
                variant="outlined"
                onClick={() => void verifyCode('signUp')}
                disabled={verifying}
                sx={{ minHeight: 44, minWidth: 120 }}
              >
                注册
              </Button>
            </Box>

            <FormControlLabel
              control={
                <Checkbox
                  checked={autoLogin}
                  onChange={(event) => {
                    const next = event.target.checked;
                    setAutoLogin(next);
                    writeAutoLoginPreference(next);
                  }}
                />
              }
              label="下次自动登录（本机保留加密凭据；取消勾选则下次打开需重新登录）"
              sx={{ alignItems: 'flex-start', '& .MuiFormControlLabel-label': { pt: 1, fontSize: 14 } }}
            />

            {notice !== null ? <Alert severity="success">{notice}</Alert> : null}
            {authError !== null ? <Alert severity="error">{authError}</Alert> : null}
            {authHint !== null ? <Alert severity="warning">{authHint}</Alert> : null}

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
