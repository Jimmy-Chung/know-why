// 块级所见即所得编辑器（Typora 式就地渲染）的 React 封装。
// 纯受控的 DOM 编辑区：挂载时按 markdown 建块，所有编辑交互由 wysiwyg 引擎处理；
// 任何内容变化都会同步调用 onChange(markdown)，供上层防抖保存/复制。
import React, { useCallback, useEffect, useRef } from "react";
import * as wys from "../wysiwyg.js";

export function WysiwygEditor({ initialMarkdown, focusAtStart, onChange }: {
  initialMarkdown: string;
  /** 挂载后是否把焦点放进首个块（新建笔记直接开写用） */
  focusAtStart?: boolean;
  onChange: (md: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 撤销/重做历史栈：以 markdown 快照为单位（跨系统 Cmd/Ctrl+Z，Shift 或 Ctrl+Y 重做）。
  // 每次提交前把当前状态压入撤销栈，重建 DOM 时直接回退到历史快照。
  const undoRef = useRef<string[]>([]);
  const redoRef = useRef<string[]>([]);
  const lastMdRef = useRef(initialMarkdown);
  const HISTORY_LIMIT = 100;

  // 统一提交入口：内容变化时压栈并上报。md 与上次相同时跳过（防抖/重复触发去重）。
  const commit = useCallback((md: string) => {
    const prev = lastMdRef.current;
    if (md === prev) return;
    const stack = undoRef.current;
    if (stack[stack.length - 1] !== prev) stack.push(prev);
    if (stack.length > HISTORY_LIMIT) stack.shift();
    redoRef.current = []; // 新的编辑清空重做栈
    lastMdRef.current = md;
    onChangeRef.current(md);
  }, []);

  // 用历史快照重建编辑区，并把焦点放到末尾块。
  const restore = useCallback((md: string) => {
    const root = rootRef.current;
    if (!root) return;
    wys.buildEditor(root, md);
    const block = wys.lastBlock(root) ?? wys.ensureBlock(root);
    wys.activateBlock(root, block, "end", true);
    lastMdRef.current = md;
    onChangeRef.current(md);
  }, []);

  const undo = useCallback(() => {
    const stack = undoRef.current;
    if (stack.length === 0) return;
    const prev = stack.pop()!;
    redoRef.current.push(lastMdRef.current);
    restore(prev);
  }, [restore]);

  const redo = useCallback(() => {
    const stack = redoRef.current;
    if (stack.length === 0) return;
    const next = stack.pop()!;
    undoRef.current.push(lastMdRef.current);
    restore(next);
  }, [restore]);

  // 一次性初始化：解析 markdown → 建块 → 激活首个块
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    wys.buildEditor(root, initialMarkdown);
    const first = wys.ensureBlock(root);
    wys.activateBlock(root, first, focusAtStart ? "end" : 0, focusAtStart);
    // 卸载时清空，避免复用实例残留
    return () => { root.innerHTML = ""; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const root = rootRef.current;
    if (!root) return;
    const target = e.target as HTMLElement;
    const block = target.closest<HTMLElement>(".wys-block");
    // 点击当前激活块的源码层 → 交给浏览器原生定位光标
    if (block && block.classList.contains("wys-active")) return;
    e.preventDefault();
    if (block && root.contains(block)) {
      wys.activateFromPoint(root, block, e.clientX, e.clientY);
    } else {
      const last = wys.lastBlock(root);
      if (last) wys.activateBlock(root, last, "end");
      else wys.activateBlock(root, wys.ensureBlock(root), "end");
    }
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    const active = root && wys.getActiveBlock(root);
    if (!root || !active) return;
    const composing = (e.nativeEvent as KeyboardEvent).isComposing || e.keyCode === 229;
    // 撤销/重做：Cmd+Z / Ctrl+Z（Mac），Ctrl+Z / Ctrl+Y（Windows/Linux）；Shift+Z 反向重做。
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
      return;
    }
    if (e.key === "Enter") {
      if (composing) return; // 中文输入法确认候选词
      e.preventDefault();
      wys.handleEnter(root, active);
      commit(wys.serializeEditor(root));
    } else if (e.key === "Backspace") {
      if (composing) return;
      if (wys.handleBackspace(root, active)) {
        e.preventDefault();
        commit(wys.serializeEditor(root));
      }
    } else if (e.key === "ArrowUp") {
      if (wys.handleArrow(root, active, -1)) e.preventDefault();
    } else if (e.key === "ArrowDown") {
      if (wys.handleArrow(root, active, 1)) e.preventDefault();
    } else if (e.key === "Tab" && active.hasAttribute("data-code")) {
      e.preventDefault();
      wys.insertTextAtCaret("  ");
    }
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    const root = rootRef.current;
    const active = root && wys.getActiveBlock(root);
    if (!root || !active) return;
    e.preventDefault();
    wys.insertTextAtCaret(text);
    commit(wys.serializeEditor(root));
  }, []);

  const handleInput = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    commit(wys.serializeEditor(root));
  }, [commit]);

  return (
    <div
      ref={rootRef}
      className="wys-editor"
      contentEditable={false}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      onInput={handleInput}
      onPaste={handlePaste}
      aria-label="笔记正文（Markdown 就地渲染）"
    />
  );
}