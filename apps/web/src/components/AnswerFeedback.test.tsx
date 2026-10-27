import { render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { appTheme } from '../theme';
import { AnswerFeedback } from './AnswerFeedback';

/** 用真实应用主题渲染：颜色断言必须落在**出厂theme**上，而不是 MUI 默认调色板。 */
function renderFeedback(node: ReactElement): void {
  render(<ThemeProvider theme={appTheme}>{node}</ThemeProvider>);
}

describe('AnswerFeedback：结果必须同时有颜色和文字', () => {
  it('答对显示绿色“答对了”', () => {
    renderFeedback(
      <AnswerFeedback
        isCorrect
        correctAnswer="放弃"
        cumulativeWrongCount={0}
        showCumulativeWrongPrompt={false}
      />,
    );

    const text = screen.getByText('答对了');
    expect(text).toBeInTheDocument();
    // 颜色来自 MUI 主题 success.main（#2e7d32），但文字本身必须能独立表达结果。
    expect(text).toHaveStyle({ color: 'rgb(46, 125, 50)' });
    expect(screen.getByRole('status')).toHaveAttribute('data-result', 'correct');
    expect(screen.getByText('正确答案：放弃')).toBeInTheDocument();
  });

  it('答错显示红色“答错了”', () => {
    renderFeedback(
      <AnswerFeedback
        isCorrect={false}
        correctAnswer="吸收"
        cumulativeWrongCount={1}
        showCumulativeWrongPrompt={false}
      />,
    );

    const text = screen.getByText('答错了');
    expect(text).toBeInTheDocument();
    expect(text).toHaveStyle({ color: 'rgb(198, 40, 40)' });
    expect(screen.getByRole('status')).toHaveAttribute('data-result', 'wrong');
    // 累计 1 次还不提示（阈值是 2）。
    expect(screen.queryByText(/累计答错/)).toBeNull();
  });

  it('累计错次达到阈值时额外给出文字提示', () => {
    renderFeedback(
      <AnswerFeedback
        isCorrect={false}
        correctAnswer="吸收"
        cumulativeWrongCount={2}
        showCumulativeWrongPrompt
      />,
    );

    expect(screen.getByText('累计答错 2 次')).toBeInTheDocument();
  });
});
