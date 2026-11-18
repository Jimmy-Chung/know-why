// 统一 markdown 渲染：marked + KaTeX 数学公式
// 支持：$$...$$、$...$、\[...\]、\(...\)，以及兜底「含 LaTeX 命令的 [...]」写法
import katex from "katex";
import "katex/dist/katex.min.css";
import { marked } from "marked";
import DOMPurify from "dompurify";

// 渲染结果会被 dangerouslySetInnerHTML 直接插入页面。模型回答与联网抓取的网页正文
// 都可能夹带原始 HTML，因此统一在这里做净化；Node 环境（测试）不渲染，直接跳过。
const isBrowser = typeof (globalThis as { window?: unknown }).window !== "undefined";
const purify = isBrowser ? DOMPurify : null;

export function sanitizeHtml(html: string): string {
  if (!purify || !purify.isSupported) return html;
  return purify.sanitize(html);
}

// 用占位符在 marked 处理前隔离数学块，渲染后再还原，避免 marked 干扰公式内容
const PLACEHOLDER = (i: number) => `@@KKMATH${i}@@`;

// 守卫字符：分隔 `**`/`__` 与紧随其后的引号，避免 CommonMark 把 `*`/`_` 判为
// 「后跟标点 → 非 left-flanking delimiter」导致行内加粗失效（如 `查看**"保底"实际回报**`）。
// 渲染后再统一移除，保证视觉零痕迹。
const ZWSP = "​";
// 引号类标点：ASCII 双/单引号 + 中文弯引号 + 书名号等
const QUOTE_CHARS = `"'“”‘’«»《》「」`;
const QUOTE_CLASS = `[${QUOTE_CHARS}]`;

function guardQuotes(s: string): string {
  let r =
    // 开启侧：`**` 或 `__` 后紧跟引号 → 插入 ZWSP，使 `*` 后不再是标点
    s.replace(new RegExp(`(\\*\\*|__)(?=${QUOTE_CLASS})`, "g"), `$1${ZWSP}`)
    ;
  // 闭合侧：`**`/`__` 前是标点、后紧跟文字（非空白/标点/行尾）时插入 ZWSP。
  // CommonMark 右偏 flanking 要求「前标点时，后须为空白或标点」，否则 `*` 无法闭合，
  // 如 `**重点（内容）**说明`（`）**说`）与 `**"Treasury Twist"…**好` 都会失效。
  // 显式指定后面须为文字，避免误动已能正常闭合的 `）** `/`）**，`/行尾`。
  r = r.replace(/(\p{P})(\*\*|__)(?=[^\s\p{P}])/gu, `$1${ZWSP}$2`);
  return r;
}

function unguard(s: string): string {
  return s.replace(/​/g, "");
}

// markdown → 纯文本：复制文本用。剥离常用标记（强调/链接/代码/标题/列表/引用），
// 保留换行与正文顺序；同时剔除守卫用 ZWSP。与 server/selection.markdownToPlaintext 保持同一套规则。
export function markdownToPlainText(md: string): string {
  let s = md.replace(/[​]/g, "");
  s = s.replace(/```[\s\S]*?\n```/g, (m) => m.replace(/```\w*\n?/g, "").replace(/```$/g, ""));
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t: string) => t);
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/_([^_]+)_/g, "$1");
  s = s.replace(/^#{1,6}\s+/gm, "");
  s = s.replace(/^>\s?/gm, "");
  s = s.replace(/^[-*+]\s+/gm, "");
  s = s.replace(/^\d+\.\s+/gm, "");
  s = s.replace(/^---+$/gm, "");
  return s.trim();
}

function renderMath(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: false });
  } catch {
    return tex;
  }
}

export function renderMarkdown(text: string): string {
  if (!text) return "";
  const math: string[] = [];
  let s = guardQuotes(text);

  // 1) display: $$...$$
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_m, t: string) => {
    math.push(renderMath(t.trim(), true));
    return PLACEHOLDER(math.length - 1);
  });

  // 2) display: \[...\]
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_m, t: string) => {
    math.push(renderMath(t.trim(), true));
    return PLACEHOLDER(math.length - 1);
  });

  // 3) inline: \(...\)
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_m, t: string) => {
    math.push(renderMath(t.trim(), false));
    return PLACEHOLDER(math.length - 1);
  });

  // 4) inline: $...$（排除货币：要求内容含字母/反斜杠/等号等数学特征）
  s = s.replace(/\$([^\n$]+?)\$/g, (_m, t: string) => {
    if (!/[a-zA-Z\\=+\-^_/]/.test(t)) return _m; // 非数学，原样保留
    math.push(renderMath(t.trim(), false));
    return PLACEHOLDER(math.length - 1);
  });

  // 5) 兜底：含 LaTeX 命令（\xxx）的单行 [...] 视为 display math
  //    仅当方括号内容含反斜杠命令时，避免误吞 [1] 这类引用
  s = s.replace(/\[([^\]\n]*\\[a-zA-Z]+[^\]\n]*)\]/g, (_m, t: string) => {
    math.push(renderMath(t.trim(), true));
    return PLACEHOLDER(math.length - 1);
  });

  let html = marked.parse(s, { async: false }) as string;

  // 净化放在还原 KaTeX 之前：公式 HTML 由本地 KaTeX 生成，不需要也不应被过滤。
  html = sanitizeHtml(html);

  // 还原数学块
  html = html.replace(/@@KKMATH(\d+)@@/g, (_m, i: string) => math[+i] ?? "");

  // 移除守卫 ZWSP
  html = unguard(html);

  return html;
}
