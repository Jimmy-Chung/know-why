// @ 提及的文本处理：选中候选后要把触发用的 "@查询词" 从输入框里摘掉。
// 单独抽出来便于单测（浏览器交互本身没有 DOM 测试环境）。
export function stripMentionTrigger(input: string, start: number, end: number): { text: string; caret: number } {
  const s = Math.max(0, Math.min(start, input.length));
  // 至少吃掉 "@" 本身；end 由调用方按输入时的光标位置给出
  const e = Math.max(s + 1, Math.min(end, input.length));
  return { text: input.slice(0, s) + input.slice(e), caret: s };
}
