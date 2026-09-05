// 选区锚点工具：将 markdown 渲染为规范纯文本，并提供选区匹配/还原。
// 锚点不依赖 DOM，保存规范文本区间 + 邻近文本校验，支持中文、跨行、重复词。

// 简化的 markdown → 纯文本：去标记、保留换行与文字顺序。
export function markdownToPlaintext(md: string): string {
  let s = md;
  // 代码块 → 保留内容
  s = s.replace(/```[\s\S]*?\n```/g, (m) => m.replace(/```\w*\n?/g, "").replace(/```$/g, ""));
  // 行内代码
  s = s.replace(/`([^`]+)`/g, "$1");
  // 图片/链接
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t: string, u: string) => (t ? t : u));
  // 强调
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/_([^_]+)_/g, "$1");
  // 标题
  s = s.replace(/^#{1,6}\s+/gm, "");
  // 引用
  s = s.replace(/^>\s?/gm, "");
  // 列表标记
  s = s.replace(/^[-*+]\s+/gm, "");
  s = s.replace(/^\d+\.\s+/gm, "");
  // 分隔线
  s = s.replace(/^---+$/gm, "");
  return s;
}

export interface AnchorInput {
  plaintext: string;
  selectedText: string;
  // 选区在 plaintext 中的近似起始偏移（由前端提供，基于其渲染纯文本）
  startOffset: number;
  endOffset: number;
}

// 用选文 + 上下文校验锚点；若前端偏移不准，按选文+邻近匹配修正。
export function resolveAnchor(plaintext: string, selectedText: string, startOffset?: number, endOffset?: number): {
  start: number;
  end: number;
  prefix: string;
  suffix: string;
} {
  const sel = selectedText;
  // 优先按偏移校验
  if (startOffset !== undefined && endOffset !== undefined) {
    const slice = plaintext.slice(startOffset, endOffset);
    if (normalize(slice) === normalize(sel)) {
      return around(plaintext, startOffset, endOffset);
    }
  }
  // 回退：在 plaintext 中查找选文（首个出现位置）
  const idx = indexOfNorm(plaintext, sel);
  if (idx >= 0) {
    const end = idx + sel.length;
    return around(plaintext, idx, end);
  }
  // 再回退：去除空白后匹配
  const compact = plaintext.replace(/\s+/g, "");
  const selCompact = sel.replace(/\s+/g, "");
  const idx2 = compact.indexOf(selCompact);
  if (idx2 >= 0) {
    // 重新映射回原文（近似）
    const start = mapCompactToOriginal(plaintext, idx2);
    const end = mapCompactToOriginal(plaintext, idx2 + selCompact.length);
    return around(plaintext, start, Math.max(end, start + sel.length));
  }
  // 找不到：仍记录选文，偏移用末尾
  const start = plaintext.length;
  return { start, end: start + sel.length, prefix: plaintext.slice(Math.max(0, start - 40)), suffix: "" };
}

function around(text: string, start: number, end: number) {
  return {
    start,
    end,
    prefix: text.slice(Math.max(0, start - 40), start),
    suffix: text.slice(end, end + 40),
  };
}

function normalize(s: string): string {
  return s.replace(/\s+/g, "");
}

function indexOfNorm(hay: string, needle: string): number {
  // 优先精确
  const i = hay.indexOf(needle);
  if (i >= 0) return i;
  // 去空白匹配
  return -1;
}

function mapCompactToOriginal(text: string, compactIdx: number): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (!/\s/.test(ch)) {
      if (count === compactIdx) return i;
      count++;
    }
  }
  return text.length;
}

// 还原锚点：在当前消息 plaintext 中定位选文区间，返回 {start,end} 或 null
export function locateAnchor(plaintext: string, anchor: { selected_text: string; start_offset: number; end_offset: number; prefix: string; suffix: string }): { start: number; end: number } | null {
  // 先按保存的偏移 + 前后缀校验
  if (anchor.start_offset < plaintext.length) {
    const slice = plaintext.slice(anchor.start_offset, anchor.end_offset);
    if (normalize(slice) === normalize(anchor.selected_text)) {
      return { start: anchor.start_offset, end: anchor.end_offset };
    }
  }
  // 按选文 + 前后缀定位
  const idx = plaintext.indexOf(anchor.selected_text);
  if (idx >= 0) {
    const before = plaintext.slice(Math.max(0, idx - 40), idx);
    if (anchor.prefix && before.endsWith(anchor.prefix.slice(-20))) {
      return { start: idx, end: idx + anchor.selected_text.length };
    }
    return { start: idx, end: idx + anchor.selected_text.length };
  }
  return null;
}
