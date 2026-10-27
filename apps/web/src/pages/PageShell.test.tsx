import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ServiceProvider } from '../services/ServiceProvider';
import { PageShell } from './PageShell';

describe('PageShell：空态规则', () => {
  it('services 为 null 时只显示“数据服务未接入”，不渲染正文', () => {
    render(
      <ServiceProvider services={null}>
        <PageShell title="演示页" headingId="demo-heading">
          <p>真实内容</p>
        </PageShell>
      </ServiceProvider>,
    );

    expect(screen.getByText('数据服务未接入')).toBeInTheDocument();
    expect(screen.queryByText('真实内容')).toBeNull();
  });

  it('未传正文时保留 6A 的占位文案', () => {
    render(
      <ServiceProvider services={{} as never}>
        <PageShell title="演示页" headingId="demo-heading" />
      </ServiceProvider>,
    );

    expect(screen.getByText('内容在 6B/6C 接入。')).toBeInTheDocument();
  });
});
