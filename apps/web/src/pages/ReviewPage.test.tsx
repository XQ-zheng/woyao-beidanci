import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { ServiceProvider } from '../services/ServiceProvider';
import { createFakeServices, makeSummary } from '../test/fakeServices';
import ReviewPage from './ReviewPage';

/** 渲染完成页（可带汇总）。 */
function renderReview(options: { services?: ReturnType<typeof createFakeServices> | null; summary?: ReturnType<typeof makeSummary> } = {}): void {
  const { services = createFakeServices(), summary } = options;
  render(
    <ServiceProvider services={services}>
      <MemoryRouter initialEntries={[{ pathname: '/review', state: summary === undefined ? null : { summary } }]}>
        <ReviewPage />
      </MemoryRouter>
    </ServiceProvider>,
  );
}

describe('ReviewPage', () => {
  it('services 为 null 时显示空态，而不是“没有学习记录”', () => {
    renderReview({ services: null });

    expect(screen.getByText('数据服务未接入')).toBeInTheDocument();
    expect(screen.queryByText('没有可展示的学习记录，请返回今日学习。')).toBeNull();
  });

  it('没有汇总时提示返回今日学习', () => {
    renderReview();

    expect(screen.getByText('没有可展示的学习记录，请返回今日学习。')).toBeInTheDocument();
  });

  it('有汇总时展示真实数字', () => {
    renderReview({ summary: makeSummary({ newCount: 3, reviewCount: 5, totalAnswers: 8, correctCount: 6, activeDurationMs: 65000 }) });

    expect(screen.getByTestId('summary-new-count')).toHaveTextContent('新词数3');
    expect(screen.getByTestId('summary-review-count')).toHaveTextContent('复习数5');
    expect(screen.getByTestId('summary-duration')).toHaveTextContent('1 分 5 秒');
    expect(screen.getByTestId('summary-correct')).toHaveTextContent('6 / 8');
  });
});
