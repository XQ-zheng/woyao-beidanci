/**
 * preload：渲染进程与主进程之间唯一的桥。
 *
 * 只暴露一个 `invoke(channel, payload)`，且频道名必须命中白名单；不暴露 `ipcRenderer`
 * 本体、不暴露 `require`/`process`、不提供任意频道透传——否则渲染进程一旦被 XSS，
 * 攻击面就等于整个主进程。
 */
import { contextBridge, ipcRenderer } from 'electron';

import { IPC_CHANNELS, isIpcChannel } from '../shared/channels';

/** 暴露给渲染进程的 API。 */
const api = {
  /** 允许调用的频道清单（只读，便于渲染进程自检）。 */
  channels: [...IPC_CHANNELS],
  /**
   * 调用主进程方法。
   *
   * @param channel 白名单内的频道。
   * @param payload 入参（主进程会用 zod 再校验一次）。
   * @returns `{ ok: true, data }` 或 `{ ok: false, error }`。
   */
  invoke: async (channel: string, payload?: unknown): Promise<unknown> => {
    if (!isIpcChannel(channel)) {
      return { ok: false, error: { code: 'UNKNOWN_CHANNEL', message: `未知的 IPC 频道：${channel}` } };
    }
    return ipcRenderer.invoke(channel, payload);
  },
} as const;

contextBridge.exposeInMainWorld('woyao', api);
