/**
 * 服务上下文：页面通过 `useServices()` 拿服务，绝不直接 import 具体服务实例。
 *
 * 为什么 `services` 允许为 `null`：Web 壳在浏览器里拿不到 SQLite（那是 Task 7
 * Electron 主进程的事），dev/预览阶段就是 `null`，页面据此显示“数据服务未接入”空态。
 * `useServices` 在**没有 Provider** 时抛错（而不是返回 undefined），把“忘了包 Provider”
 * 变成启动即炸的显式错误，而不是页面深处读不到服务才静默出错。
 */

/* eslint-disable react-refresh/only-export-components -- Provider 与 useServices 必须同文件
   共用同一个不导出的 Context；拆开反而破坏封装（brief §2 要求二者都在本文件）。 */

import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import type { Services } from '@woyao/services';

interface ServiceContextValue {
  readonly services: Services | null;
}

const ServiceContext = createContext<ServiceContextValue | undefined>(undefined);

/** Provider 入参。 */
export interface ServiceProviderProps {
  /** `null` 表示数据服务未接入（合法状态，页面显示空态）。 */
  readonly services: Services | null;
  readonly children: ReactNode;
}

/**
 * 提供服务上下文。
 *
 * @param props 服务与子节点。
 * @returns Provider。
 */
export function ServiceProvider({ services, children }: ServiceProviderProps): ReactElement {
  return <ServiceContext.Provider value={{ services }}>{children}</ServiceContext.Provider>;
}

/**
 * 读取服务；`null` 表示未接入。
 *
 * @returns 服务全家桶或 `null`。
 * @throws 在 `ServiceProvider` 之外调用时。
 */
export function useServices(): Services | null {
  const value = useContext(ServiceContext);
  if (value === undefined) {
    throw new Error('useServices 必须在 ServiceProvider 内使用');
  }
  return value.services;
}
