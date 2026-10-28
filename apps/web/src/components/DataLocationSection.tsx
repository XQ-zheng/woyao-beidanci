import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';

/** 把异常压成可展示的一句话。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** preload 桥（数据位置不属于 Services 接口，直接走白名单频道）。 */
interface Bridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
}

/** 迁移报告。 */
interface MigrationReport {
  readonly files: readonly string[];
  readonly bytes: number;
}

/** 确认步骤（三重确认的状态机）。 */
type ConfirmStep = 1 | 2 | 3;

/** 迁移结果换算成可读文本。 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/** 数据储存位置区块属性。 */
interface DataLocationSectionProps {
  /** 桥（桌面端存在；网页预览为 null 时显示「仅桌面端可用」）。 */
  readonly bridge: Bridge | null;
}

/**
 * 设置页「数据储存位置」区块。
 *
 * 显示当前数据目录；「更改位置」要走完**三重确认**才会真正迁移：
 * 1. 确认目标位置；2. 确认迁移风险（勿关机/勿关闭软件）；3. 最后确认。
 * 确认后主进程复制全部数据到新位置并写引导文件，提示重启生效。
 */
export default function DataLocationSection({ bridge }: DataLocationSectionProps): ReactElement {
  const [dataDir, setDataDir] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [confirmStep, setConfirmStep] = useState<ConfirmStep | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [migrationError, setMigrationError] = useState<string | null>(null);

  useEffect(() => {
    if (bridge === null) {
      return;
    }
    let active = true;
    void bridge
      .invoke('settings.getDataLocation')
      .then((result) => {
        const data = (result as { ok: boolean; data?: { dataDir: string }; error?: { message: string } }) ?? {
          ok: false,
        };
        if (!active) {
          return;
        }
        if (data.ok && data.data !== undefined) {
          setDataDir(data.data.dataDir);
        } else {
          setLoadError(data.error?.message ?? '读取数据位置失败');
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setLoadError(describeError(cause));
        }
      });
    return () => {
      active = false;
    };
  }, [bridge]);

  async function startChange(): Promise<void> {
    if (bridge === null) {
      return;
    }
    setPicking(true);
    setMigrationError(null);
    try {
      const result = (await bridge.invoke('settings.pickDataFolder')) as string | null;
      if (result !== null && result !== '') {
        setPendingPath(result);
        setConfirmStep(1);
      }
    } catch (cause: unknown) {
      setMigrationError(describeError(cause));
    } finally {
      setPicking(false);
    }
  }

  async function runMigration(): Promise<void> {
    if (bridge === null || pendingPath === null) {
      return;
    }
    setMigrating(true);
    setMigrationError(null);
    try {
      const result = (await bridge.invoke('settings.changeDataLocation', {
        newPath: pendingPath,
      })) as MigrationReport;
      setReport(result);
      setConfirmStep(null);
    } catch (cause: unknown) {
      setMigrationError(describeError(cause));
      setConfirmStep(null);
    } finally {
      setMigrating(false);
    }
  }

  function closeDialog(): void {
    setConfirmStep(null);
  }

  const busy = picking || migrating;

  return (
    <Box sx={{ display: 'grid', gap: 1 }}>
      <Typography variant="subtitle1" component="h3">
        文件储存位置
      </Typography>
      {bridge === null ? (
        <Typography variant="body2" color="text.secondary">
          数据储存位置仅在桌面端可修改。
        </Typography>
      ) : loadError !== null ? (
        <Alert severity="error">{loadError}</Alert>
      ) : (
        <>
          <TextField
            size="small"
            label="当前数据储存位置"
            value={dataDir ?? '读取中…'}
            slotProps={{ input: { readOnly: true } }}
            helperText="学习记录、词库、日志与登录凭据都保存在这里。"
          />
          <Box>
            <Button variant="outlined" onClick={() => void startChange()} disabled={busy}>
              {picking ? '正在选择…' : '更改位置…'}
            </Button>
          </Box>
          {report !== null ? (
            <Alert severity="success">
              迁移完成（{formatBytes(report.bytes)}，{report.files.length} 项）。**重启软件后新位置生效**；
              旧位置的数据会保留，确认新位置一切正常后可手动删除以释放空间。
            </Alert>
          ) : null}
          {migrationError !== null ? <Alert severity="error">{migrationError}</Alert> : null}
        </>
      )}

      <Dialog open={confirmStep !== null} onClose={migrating ? undefined : closeDialog} maxWidth="sm" fullWidth>
        {confirmStep === 1 ? (
          <>
            <DialogTitle>确认更改数据储存位置（第 1 / 3 步）</DialogTitle>
            <DialogContent>
              <DialogContentText component="div">
                <Typography variant="body1" gutterBottom>
                  确定要把数据储存位置更改为：
                </Typography>
                <Typography variant="body1" sx={{ fontWeight: 700, wordBreak: 'break-all' }}>
                  {pendingPath}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  当前位置：{dataDir ?? '未知'}
                </Typography>
              </DialogContentText>
            </DialogContent>
            <DialogActions>
              <Button onClick={closeDialog}>取消</Button>
              <Button variant="contained" onClick={() => setConfirmStep(2)}>
                下一步
              </Button>
            </DialogActions>
          </>
        ) : null}

        {confirmStep === 2 ? (
          <>
            <DialogTitle>确认数据迁移（第 2 / 3 步）</DialogTitle>
            <DialogContent>
              <DialogContentText component="div">
                <Typography variant="body1" gutterBottom>
                  更改后，**所有学习数据、词库、日志与登录凭据将自动迁移到新位置**。
                </Typography>
                <Typography variant="body2" color="warning.main" component="div">
                  <Box component="ul" sx={{ m: 0, pl: 3 }}>
                    <li>迁移过程中请**不要关闭软件、不要断电**，中断可能导致数据异常。</li>
                    <li>迁移完成后需要**重启软件**才能在新位置继续使用。</li>
                    <li>旧位置的数据会保留，作为安全备份。</li>
                  </Box>
                </Typography>
              </DialogContentText>
            </DialogContent>
            <DialogActions>
              <Button onClick={closeDialog}>取消</Button>
              <Button variant="contained" onClick={() => setConfirmStep(3)}>
                我已了解，下一步
              </Button>
            </DialogActions>
          </>
        ) : null}

        {confirmStep === 3 ? (
          <>
            <DialogTitle>最后确认（第 3 / 3 步）</DialogTitle>
            <DialogContent>
              <DialogContentText>
                <Typography variant="body1" gutterBottom>
                  这是最后一次确认。确定要开始把数据迁移到：
                </Typography>
                <Typography variant="body1" sx={{ fontWeight: 700, wordBreak: 'break-all' }}>
                  {pendingPath}
                </Typography>
              </DialogContentText>
            </DialogContent>
            <DialogActions>
              <Button onClick={closeDialog} disabled={migrating}>
                取消
              </Button>
              <Button variant="contained" color="warning" onClick={() => void runMigration()} disabled={migrating}>
                {migrating ? (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <CircularProgress size={16} color="inherit" />
                    正在迁移…
                  </Box>
                ) : (
                  '确定迁移'
                )}
              </Button>
            </DialogActions>
          </>
        ) : null}
      </Dialog>
    </Box>
  );
}
