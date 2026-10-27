import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { ReactElement } from 'react';

/** 作答反馈入参。 */
export interface AnswerFeedbackProps {
  readonly isCorrect: boolean;
  /** 正确答案文本（按作答方向给出）。 */
  readonly correctAnswer: string;
  /** 累计答错次数（来自 `learning_state`）。 */
  readonly cumulativeWrongCount: number;
  /** 是否提示“这个单词已经错了 N 次”（答错且累计错次 >= 2）。 */
  readonly showCumulativeWrongPrompt: boolean;
}

/**
 * 作答反馈：绿色“答对了”/红色“答错了”。
 *
 * **颜色必须配文字**（不能只靠颜色区分结果——色弱用户与无颜色环境都无法识别），
 * `showCumulativeWrongPrompt` 时额外显示“累计答错 N 次”。
 *
 * 用 `role="status"` + `aria-live="polite"` 让读屏在作答后播报结果；`data-result`
 * 是给测试用的稳定钩子，避免测试去猜 MUI 生成的类名。
 */
export function AnswerFeedback({
  isCorrect,
  correctAnswer,
  cumulativeWrongCount,
  showCumulativeWrongPrompt,
}: AnswerFeedbackProps): ReactElement {
  return (
    <Box
      component="section"
      aria-label="作答反馈"
      role="status"
      aria-live="polite"
      data-result={isCorrect ? 'correct' : 'wrong'}
      sx={{ display: 'grid', gap: 0.5 }}
    >
      <Typography
        variant="h6"
        component="p"
        sx={{ color: isCorrect ? 'success.main' : 'error.main', fontWeight: 700 }}
      >
        {isCorrect ? '答对了' : '答错了'}
      </Typography>
      <Typography variant="body2">正确答案：{correctAnswer}</Typography>
      {showCumulativeWrongPrompt ? (
        <Typography variant="body2">累计答错 {cumulativeWrongCount} 次</Typography>
      ) : null}
    </Box>
  );
}
