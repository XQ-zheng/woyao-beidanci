import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { Services } from '@woyao/services';

import { ServiceProvider, useServices } from './ServiceProvider';

/** 探针：读出 `useServices()` 的结果并渲染成文本。 */
function Probe(): ReactElement {
  const services = useServices();
  return <span>{services === null ? 'null' : 'present'}</span>;
}

describe('ServiceProvider', () => {
  it('Provider 内有值时 useServices 返回该值（非 null）', () => {
    const services = {} as unknown as Services;

    render(
      <ServiceProvider services={services}>
        <Probe />
      </ServiceProvider>,
    );

    expect(screen.getByText('present')).toBeInTheDocument();
  });

  it('Provider 内 services=null 是合法状态，useServices 返回 null', () => {
    render(
      <ServiceProvider services={null}>
        <Probe />
      </ServiceProvider>,
    );

    expect(screen.getByText('null')).toBeInTheDocument();
  });

  it('无 Provider 时 useServices 抛错（而不是静默返回 undefined）', () => {
    expect(() => render(<Probe />)).toThrow('useServices 必须在 ServiceProvider 内使用');
  });
});
