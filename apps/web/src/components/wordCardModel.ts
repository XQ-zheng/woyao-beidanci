import type { CardView } from '@woyao/services';

/**
 * 本题是否真的是“选择题”。
 *
 * `CardView.options` 允许少于 4 个（候选词不足时**绝不编造干扰项**），只剩 1 个选项时
 * 没有选择的意义，UI 退化为“直接显示答案 + 自报认识与否”。这条判定必须与
 * `StudyPage` 计算 `isCorrect` 的口径一致，所以单独放在这里、由词卡与页面共用。
 *
 * @param card 卡片视图。
 * @returns 是否需要渲染可点选的选项。
 */
export function isChoiceCard(card: CardView): boolean {
  return card.style === 'CHOICE' && card.options.length > 1;
}
