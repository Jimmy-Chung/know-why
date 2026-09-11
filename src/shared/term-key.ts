// 术语关联：规范匹配键与纯文本匹配，前后端共用。
// termKey 用于 term_link.term_key 存储与前端渲染匹配，保证三者一致。
// findTermMatches 供服务端回填/检索与前端标注共用同一套匹配语义。

// 规范匹配键：统一 NFC + 去首尾空白 + 小写。
// 不折叠内部空白（保留句中空格），与文档"中文允许在句子中出现、英文完整词匹配"一致。
export function termKey(text: string): string {
  return text.normalize("NFC").trim().toLowerCase();
}

// 是否属于 CJK 范围：中文匹配不做词边界校验（允许句中出现）。
const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/;

// 判断术语是否需要英文单词边界：仅当含 ASCII 字母时才要求边界（避免
// "cat" 匹配 "category"、"app" 匹配 "apple" 等子串误判）。
function needsWordBoundary(term: string): boolean {
  return /[a-z0-9]/i.test(term) && !CJK_RE.test(term);
}

// 是否已含 CJK：混合词（如 "GPT模型"）按整体做边界处理有难度，这里当含 CJK
// 时不做词边界，避免漏标。纯英文/数字才做词边界。
export interface TermMatch {
  start: number; // 在纯文本中的起始偏移（UTF-16 码元）
  end: number;   // 结束偏移（不含）
}

// 在纯文本中找出 term 的所有匹配位置。
// matches 返回按 start 升序；调用方可据此贪心消解重叠。
export function findTermMatches(text: string, term: string): TermMatch[] {
  const key = termKey(term);
  if (!key) return [];
  const textLower = text.normalize("NFC").toLowerCase();
  const boundary = needsWordBoundary(key);
  const out: TermMatch[] = [];
  let searchFrom = 0;
  for (;;) {
    const idx = textLower.indexOf(key, searchFrom);
    if (idx < 0) break;
    if (boundary) {
      const before = (idx > 0 ? textLower[idx - 1] : "") ?? "";
      const after = textLower[idx + key.length] ?? "";
      const bOk = before === "" || !/[a-z0-9]/i.test(before);
      const aOk = after === "" || !/[a-z0-9]/i.test(after);
      if (bOk && aOk) out.push({ start: idx, end: idx + key.length });
      // 无论边界是否通过，都从 idx+1 继续，避免漏掉相邻/重叠出现
      searchFrom = idx + 1;
    } else {
      out.push({ start: idx, end: idx + key.length });
      searchFrom = idx + key.length;
    }
  }
  return out;
}
