import { useEffect, useRef, useState } from 'react';
import type { Services } from '@woyao/services';

import { useServices } from '../services/ServiceProvider';

/** 一次异步取数的状态。 */
export interface ServiceDataState<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: string | null;
}

/** 取数结果 + 重新加载入口。 */
export interface ServiceDataResult<T> extends ServiceDataState<T> {
  /** 重新执行一次加载（保存后刷新用）。 */
  reload(): void;
}

/** 把异常压成可展示的一句话。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 页面级取数的统一实现：自动处理“服务未接入 / 加载中 / 失败 / 成功”四态。
 *
 * 为什么用 `key` 而不是依赖数组：7 个页面各自拼 `useEffect` 依赖时，最容易漏的是
 * “切换词库/日期后没有重新取数”。这里把查询条件显式收成一个字符串 key，
 * 条件一变就重取；`loader` 用 ref 保存，避免调用方每次渲染新建函数导致无限循环。
 *
 * @param key 查询条件（例如 `deck:${deckId}`）；变化即重新加载。
 * @param loader 取数函数，参数是已确认非空的服务。
 * @returns 数据、加载态、错误与 `reload`。
 */
export function useServiceData<T>(
  key: string,
  loader: (services: Services) => Promise<T>,
): ServiceDataResult<T> {
  const services = useServices();
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const [state, setState] = useState<ServiceDataState<T>>(() => ({
    data: null,
    loading: services !== null,
    error: null,
  }));
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (services === null) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    let active = true;
    setState((previous) => ({ data: previous.data, loading: true, error: null }));

    void loaderRef
      .current(services)
      .then((data) => {
        if (active) {
          setState({ data, loading: false, error: null });
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setState({ data: null, loading: false, error: describeError(cause) });
        }
      });

    return () => {
      active = false;
    };
  }, [services, key, nonce]);

  return {
    ...state,
    reload: (): void => setNonce((value) => value + 1),
  };
}
