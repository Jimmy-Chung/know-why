// 块级所见即所得（Typora 式就地渲染）编辑引擎
//
// 设计：编辑区 = 若干「块」。每块两层：
//   - .wys-src    可编辑源码层，始终存放真正落库的单块 markdown 源码（光标永远落在源码层，
//                 中文输入法 composition 天然不受干扰）
//   - .wys-render 渲染层，由 renderMarkdown 就地生成；块不聚焦时可见
// 焦点块显示源码（所见即所编），非焦点块显示渲染（所见即所得）。
// 输入结构标记（#、-、>、数字.、```、---）后回车「提交」：块随源码就地转换结构；
// 再点击渲染块又会切回源码层继续编辑。行内语法保持源码字面，序列化无损。
// 纯解析/序列化逻辑在 wysiwyg-core.ts（无 DOM，便于单测）。
import { renderMarkdown } from "./markdown.js";
import {
  type BlockSpec,
  parseToSpecs,
  prefixOf,
  nextPrefixOf,
  hasOnlyMarker,
  stripMarker,
  RE_HR,
  specsToMarkdown,
} from "./wysiwyg-core.js";

export { parseToSpecs, specsToMarkdown, prefixOf, nextPrefixOf, hasOnlyMarker };

const SEL_BLOCK = ":scope > .wys-block";
const SEL_SRC = ":scope > .wys-src";
const SEL_RENDER = ":scope > .wys-render";

// ---- DOM 构建与渲染 ----

function makeBlock(spec: BlockSpec): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "wys-block";
  el.setAttribute("data-block", "");
  if (spec.kind === "hr") el.setAttribute("data-hr", "");
  if (spec.kind === "code") {
    el.setAttribute("data-code", "");
    el.setAttribute("data-lang", spec.lang ?? "");
  }
  const src = document.createElement("div");
  src.className = "wys-src";
  src.setAttribute("contenteditable", "true");
  src.setAttribute("spellcheck", "false");
  src.textContent = spec.text;
  const render = document.createElement("div");
  render.className = "wys-render";
  render.setAttribute("contenteditable", "false");
  el.append(src, render);
  return el;
}

export function renderBlock(block: HTMLElement): void {
  const src = block.querySelector(SEL_SRC) as HTMLElement | null;
  const render = block.querySelector(SEL_RENDER) as HTMLElement | null;
  if (!src || !render) return;
  const text = src.textContent ?? "";
  let html: string;
  if (block.hasAttribute("data-hr")) {
    html = '<div class="wys-hr"></div>';
  } else if (block.hasAttribute("data-code")) {
    const lang = block.getAttribute("data-lang") ?? "";
    html = renderMarkdown("```" + lang + "\n" + text + "\n```");
  } else {
    html = text.trim() === "" ? "" : renderMarkdown(text);
  }
  render.innerHTML = html;
}

export function renderAll(root: HTMLElement): void {
  for (const b of root.querySelectorAll<HTMLElement>(SEL_BLOCK)) renderBlock(b);
}

export function lastBlock(root: HTMLElement): HTMLElement | null {
  const bs = [...root.querySelectorAll<HTMLElement>(SEL_BLOCK)];
  return bs.length ? bs[bs.length - 1]! : null;
}

function prevBlock(block: HTMLElement): HTMLElement | null {
  let el = block.previousElementSibling as HTMLElement | null;
  while (el && !el.classList.contains("wys-block")) el = el.previousElementSibling as HTMLElement | null;
  return el;
}

function nextBlock(block: HTMLElement): HTMLElement | null {
  let el = block.nextElementSibling as HTMLElement | null;
  while (el && !el.classList.contains("wys-block")) el = el.nextElementSibling as HTMLElement | null;
  return el;
}

export function ensureBlock(root: HTMLElement): HTMLElement {
  let b = root.querySelector<HTMLElement>(SEL_BLOCK);
  if (!b) {
    b = makeBlock({ kind: "p", lang: "", text: "" });
    root.appendChild(b);
  }
  return b;
}

export function buildEditor(root: HTMLElement, md: string): void {
  root.innerHTML = "";
  for (const s of parseToSpecs(md)) root.appendChild(makeBlock(s));
  ensureBlock(root);
  renderAll(root);
}

// ---- 光标与焦点 ----

export function getActiveBlock(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>(":scope > .wys-block.wys-active");
}

export function getCaretOffset(container: Node): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return (container.textContent ?? "").length;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.startContainer)) return (container.textContent ?? "").length;
  const pre = document.createRange();
  pre.selectNodeContents(container);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

function setText(block: HTMLElement, text: string): void {
  const src = block.querySelector(SEL_SRC) as HTMLElement | null;
  if (src) src.textContent = text;
}

function srcText(block: HTMLElement): string {
  return (block.querySelector(SEL_SRC) as HTMLElement | null)?.textContent ?? "";
}

function setCaretIn(block: HTMLElement, offset: number, focus = true): void {
  const src = block.querySelector(SEL_SRC) as HTMLElement | null;
  if (!src) return;
  const text = src.textContent ?? "";
  src.textContent = text; // 归一为单一文本节点，便于定位
  const node = src.firstChild as Text | null;
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  if (node) range.setStart(node, Math.max(0, Math.min(offset, node.length)));
  else range.setStart(src, 0);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  if (focus) src.focus();
}

// caret: 数字 → 指定偏移；"end" → 末尾
export function activateBlock(root: HTMLElement, block: HTMLElement, caret: number | "end", focus = true): void {
  for (const b of root.querySelectorAll<HTMLElement>(SEL_BLOCK)) {
    const isActive = b === block;
    b.classList.toggle("wys-active", isActive);
    b.classList.toggle("wys-inactive", !isActive);
    (b.querySelector(SEL_SRC) as HTMLElement | null)?.setAttribute("contenteditable", isActive ? "true" : "false");
  }
  renderAll(root);
  if (focus) {
    const off = caret === "end" ? srcText(block).length : caret;
    setCaretIn(block, off);
  }
}

export function insertTextAtCaret(text: string): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function insertBlockAfter(root: HTMLElement, ref: HTMLElement | null, spec: BlockSpec): HTMLElement {
  const el = makeBlock(spec);
  if (ref && ref.parentElement === root) ref.after(el);
  else root.appendChild(el);
  return el;
}

function removeBlock(block: HTMLElement): void {
  block.remove();
}

// ---- 结构编辑交互 ----

// 回车：拆分/继承结构标记/提交渲染。调用方需自行 e.preventDefault + 触发保存。
export function handleEnter(root: HTMLElement, block: HTMLElement): void {
  // 代码块：块内换行
  if (block.hasAttribute("data-code")) {
    insertTextAtCaret("\n");
    return;
  }
  const text = srcText(block);
  // 段落行恰为分割线 → 转为 hr
  if (RE_HR.test(text.trim()) && !block.hasAttribute("data-hr")) {
    block.setAttribute("data-hr", "");
    setText(block, "");
    const nb = insertBlockAfter(root, block, { kind: "p", lang: "", text: "" });
    renderAll(root);
    activateBlock(root, nb, 0);
    return;
  }
  const off = getCaretOffset(block.querySelector(SEL_SRC) as HTMLElement);
  const left = text.slice(0, off);
  const right = text.slice(off);
  const marker = prefixOf(text);

  if (!marker) {
    // 纯段落：直接拆为相邻两段
    setText(block, left);
    const nb = insertBlockAfter(root, block, { kind: "p", lang: "", text: right });
    renderAll(root);
    activateBlock(root, nb, 0);
    return;
  }

  const leftBody = left.startsWith(marker) ? left.slice(marker.length) : left;
  const isHeader = /^#/.test(marker);

  if (isHeader) {
    // 标题：回车后下行是普通段落，不继承标题标记
    setText(block, left);
    const nb = insertBlockAfter(root, block, { kind: "p", lang: "", text: right });
    renderAll(root);
    activateBlock(root, nb, 0);
    return;
  }

  // 列表/引用
  const isEmptyItem = leftBody.replace(/\s+$/, "") === "" && right.trim() === "";
  if (isEmptyItem) {
    // 空列表项/空引用再回车 → 退出结构，回普通段落
    setText(block, "");
    const nb = insertBlockAfter(root, block, { kind: "p", lang: "", text: "" });
    renderAll(root);
    activateBlock(root, nb, 0);
    return;
  }
  setText(block, left);
  const nextMark = nextPrefixOf(text) ?? "";
  const nb = insertBlockAfter(root, block, { kind: "p", lang: "", text: nextMark + right });
  renderAll(root);
  activateBlock(root, nb, nextMark.length);
}

// 退格。返回 true 表示已处理结构行为（调用方需 preventDefault + 触发保存）。
export function handleBackspace(root: HTMLElement, block: HTMLElement): boolean {
  const src = block.querySelector(SEL_SRC) as HTMLElement;
  const off = getCaretOffset(src);
  if (off > 0) return false; // 普通删字，交给浏览器

  if (block.hasAttribute("data-hr")) {
    const prev = prevBlock(block);
    const next = nextBlock(block);
    removeBlock(block);
    renderAll(root);
    if (prev) activateBlock(root, prev, "end");
    else if (next) activateBlock(root, next, 0);
    else ensureBlock(root);
    return true;
  }

  if (block.hasAttribute("data-code")) {
    const prev = prevBlock(block);
    if (prev) {
      activateBlock(root, prev, "end");
      return true;
    }
    return false;
  }

  const text = srcText(block);
  const marker = prefixOf(text);
  const prev = prevBlock(block);

  // 空块（含空列表项）删除或退出结构
  if (text.trim() === "") {
    if (marker) {
      // 空列表项/空引用 → 退成空段落
      setText(block, "");
      renderAll(root);
      setCaretIn(block, 0);
      return true;
    }
    if (prev) {
      removeBlock(block);
      renderAll(root);
      activateBlock(root, prev, "end");
    }
    return true;
  }

  if (!prev) {
    // 首块：去掉结构标记降为纯段落
    if (marker && !hasOnlyMarker(text)) {
      setText(block, stripMarker(text));
      renderAll(root);
      setCaretIn(block, 0);
      return true;
    }
    return false;
  }

  // 有前一兄弟块
  if (prev.hasAttribute("data-hr")) {
    removeBlock(prev);
    renderAll(root);
    setCaretIn(block, 0);
    return true;
  }
  // 合并进前一兄弟（当前块有标记 → 去标记拼接，无空挡）
  const prevSrc = prev.querySelector(SEL_SRC) as HTMLElement | null;
  if (!prevSrc) return false;
  const prevText = prevSrc.textContent ?? "";
  const curText = marker ? stripMarker(text) : text;
  const gap = marker ? "" : " ";
  setText(prev, prevText + gap + curText);
  removeBlock(block);
  renderAll(root);
  activateBlock(root, prev, "end");
  return true;
}

// 上下箭头跨越块边界。返回 true 表示已处理（调用方需 preventDefault）。
export function handleArrow(root: HTMLElement, block: HTMLElement, dir: -1 | 1): boolean {
  const src = block.querySelector(SEL_SRC) as HTMLElement;
  const text = srcText(block);
  const off = getCaretOffset(src);
  if (dir === -1) {
    const atTopEdge = off === 0 || text[off - 1] === "\n";
    if (!atTopEdge) return false;
    const prev = prevBlock(block);
    if (prev) {
      activateBlock(root, prev, "end");
      return true;
    }
    return false;
  }
  const atBottomEdge = off === text.length || text[off] === "\n";
  if (!atBottomEdge) return false;
  const next = nextBlock(block);
  if (next) {
    activateBlock(root, next, 0);
    return true;
  }
  return false;
}

// 鼠标点击渲染层/gap：把该块切到源码层，按点击点近似放置光标
export function activateFromPoint(root: HTMLElement, block: HTMLElement, clientX: number, clientY: number): void {
  const render = block.querySelector(SEL_RENDER) as HTMLElement | null;
  let clickOff = -1;
  if (render && document.caretRangeFromPoint) {
    const rng = document.caretRangeFromPoint(clientX, clientY);
    if (rng && render.contains(rng.startContainer)) {
      const pre = render.ownerDocument.createRange();
      pre.selectNodeContents(render);
      pre.setEnd(rng.startContainer, rng.startOffset);
      clickOff = pre.toString().length;
    }
  }
  const text = srcText(block);
  const hasInlineSyntax = /[*_~`$\\[\]]/.test(text);
  let offset: number;
  if (clickOff < 0 || hasInlineSyntax) {
    offset = text.length;
  } else {
    const markLen = prefixOf(text)?.length ?? 0;
    offset = Math.min(clickOff + markLen, Math.max(0, text.length));
  }
  activateBlock(root, block, offset);
}

// 把整个编辑区序列化回 markdown（保存用）
export function serializeEditor(root: HTMLElement): string {
  const parts: string[] = [];
  for (const b of root.querySelectorAll<HTMLElement>(SEL_BLOCK)) {
    const text = srcText(b);
    if (b.hasAttribute("data-hr")) parts.push("---");
    else if (b.hasAttribute("data-code")) {
      const lang = b.getAttribute("data-lang") ?? "";
      parts.push("```" + lang + "\n" + text + "\n```");
    } else if (text.trim()) parts.push(text.trim());
  }
  return parts.join("\n\n");
}