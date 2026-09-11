// 块级所见即所得：纯 markdown 结构解析/序列化（无 DOM，可被服务端 tsconfig 下的单测引用）。
// 分块模型：> 编辑区 = 若干块，每块源码即单块 markdown 文本。
//   - 标题/列表/引用/分割线 单行成块；连续普通行并成一个多行段落块；围栏代码成单独块
//   - 序列化时相邻同类列表/引用行用单换行连接（CommonMark 会连成一个容器），其余块间用空行分隔

export interface BlockSpec {
  kind: "p" | "code" | "hr";
  lang: string;
  text: string;
}

export const RE_HR = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const RE_BLOCK_START = /^(#{1,6}\s|[-+*]\s|\d+[.)]\s|>\s?)/;
const RE_FENCE_OPEN = /^`{3,}(\S*)\s*$/;
const RE_FENCE_CLOSE = /^`{3,}\s*$/;

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

// 结构标记：返回当前块首行内的块级前缀（如 "## "、"- "、"1. "、"> "），无则 null
export function prefixOf(text: string): string | null {
  const line = firstLine(text);
  let m = /^(#{1,6})\s/.exec(line);
  if (m && m[1] !== undefined) return m[1] + " ";
  m = /^([-+*])\s/.exec(line);
  if (m && m[1] !== undefined) return m[1] + " ";
  m = /^(\d+([.)]))\s/.exec(line);
  if (m && m[1] !== undefined) return m[1] + " ";
  m = /^>\s?/.exec(line);
  if (m) return "> ";
  return null;
}

// 拆下一块要继承的前缀：有序列表自动递增序号，其余同类沿用
export function nextPrefixOf(text: string): string | null {
  const p = prefixOf(text);
  if (!p) return null;
  const line = firstLine(text);
  const m = /^(\d+)([.)])/.exec(line);
  if (m && m[1] !== undefined && m[2] !== undefined) return `${+m[1] + 1}${m[2]} `;
  return p;
}

// 块是否是「只有结构标记、没有正文」（如空列表项 "- " / 空引用 "> "）
export function hasOnlyMarker(text: string): boolean {
  const p = prefixOf(text);
  if (!p) return text.trim() === "";
  return text.replace(/\s+$/, "") === p.replace(/\s+$/, "");
}

export function stripMarker(text: string): string {
  const lines = text.split("\n");
  const first = lines[0] ?? "";
  const rest = lines.slice(1);
  const stripped = first.replace(/^(#{1,6}|[-+*]|\d+[.)]|>)\s?/, "");
  return [stripped, ...rest].join("\n");
}

export function parseToSpecs(md: string): BlockSpec[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const specs: BlockSpec[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") { i++; continue; }
    const fence = RE_FENCE_OPEN.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i]!;
        if (RE_FENCE_CLOSE.test(l)) { i++; break; }
        body.push(l);
        i++;
      }
      specs.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }
    if (RE_HR.test(line)) {
      specs.push({ kind: "hr", lang: "", text: line.trim() });
      i++;
      continue;
    }
    if (RE_BLOCK_START.test(line)) {
      // 标题/列表/引用：单行成块
      specs.push({ kind: "p", lang: "", text: line });
      i++;
      continue;
    }
    // 纯文本段落：连续普通行并成一块（软换行保留 \n），空行/结构行作为边界
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.trim() === "") break;
      if (RE_FENCE_OPEN.test(l) || RE_HR.test(l) || RE_BLOCK_START.test(l)) break;
      para.push(l);
      i++;
    }
    specs.push({ kind: "p", lang: "", text: para.join("\n") });
  }
  return specs;
}

function markerKindOf(text: string): "ul" | "ol" | "quote" | null {
  const line = firstLine(text);
  if (/^[-+*]\s/.test(line)) return "ul";
  if (/^\d+[.)]\s/.test(line)) return "ol";
  if (/^>\s?/.test(line)) return "quote";
  return null;
}

// 两在两正文块之间的分隔：相邻同类列表/引用行用单个换行即可（CommonMark 会连成一个容器），
// 其余块之间用空行分隔（否则两个普通段落会并成一段）。
function blockSeparator(prev: BlockSpec | null, cur: BlockSpec): string {
  if (!prev || prev.kind !== "p" || cur.kind !== "p") return "\n\n";
  const pk = markerKindOf(prev.text);
  const ck = markerKindOf(cur.text);
  if (pk && pk === ck) return "\n";
  return "\n\n";
}

export function specsToMarkdown(specs: BlockSpec[]): string {
  let out = "";
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i]!;
    let part: string;
    if (s.kind === "hr") part = "---";
    else if (s.kind === "code") part = "```" + s.lang + "\n" + s.text + "\n```";
    else part = s.text.trim();
    if (!part && s.kind === "p") continue;
    out += (i === 0 ? "" : blockSeparator(specs[i - 1] ?? null, s)) + part;
  }
  return out;
}