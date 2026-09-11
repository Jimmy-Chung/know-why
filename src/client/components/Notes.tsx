// 用户笔记卡片：笔记 Tab 的网格陈列 + 编辑器弹窗（就地渲染，Typora 式）。
import React, { useEffect, useState, useRef, useCallback } from "react";
import { Modal, Checkbox } from "@arco-design/web-react";
import { Button, IconButton } from "./ui/Button.js";
import { CopyButton } from "./ui/CopyButton.js";
import { WysiwygEditor } from "./WysiwygEditor.js";
import { markdownToPlainText } from "../markdown.js";
import type { NoteCard } from "../../shared/types.js";

// 新建（未落库）与编辑共用的会话态，与 App.editingNote 对齐。
// editorKey：弹窗打开时生成的稳定标识，落库拿到 id 后 key 不变，避免编辑中重挂载丢光标。
export type NoteEditorTarget = { id: string | null; title: string; content: string; editorKey: number };

function formatDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 删除笔记的二次确认（单删或批量删共用），沿用 Sidebar 删除会话的 Arco 确认框
function confirmDeleteNotes(kind: "单条" | "多条", count: number, noteTitle: string | null, onOk: () => void): void {
  Modal.confirm({
    title: "删除笔记",
    content:
      kind === "单条"
        ? `确定删除笔记「${noteTitle || "无标题"}」？（不可撤销）`
        : `确定删除选中的 ${count} 条笔记？（不可撤销）`,
    okText: "删除",
    cancelText: "取消",
    okButtonProps: { status: "danger" },
    onOk,
  });
}

// 笔记 Tab 主区：文本摘要卡片网格（支持批量勾选删除）
export function NoteListGrid({ notes, onNew, onOpen, onDelete, onDeleteMany }: {
  notes: NoteCard[];
  onNew: () => void;
  onOpen: (note: NoteCard) => void;
  onDelete: (id: string) => void;
  onDeleteMany: (ids: string[]) => void;
}) {
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const exitBatch = () => { setBatchMode(false); setSelectedIds(new Set()); };

  const askSingle = (n: NoteCard) => confirmDeleteNotes("单条", 1, n.title, () => onDelete(n.id));

  const askMany = (ids: string[]) => {
    confirmDeleteNotes("多条", ids.length, null, () => { onDeleteMany(ids); exitBatch(); });
  };

  const selectAll = () => {
    setSelectedIds((prev) => prev.size === notes.length ? new Set() : new Set(notes.map((n) => n.id)));
  };

  return (
    <div className="notes-view">
      <div className="notes-toolbar">
        <span className="notes-count">
          {batchMode ? `已选 ${selectedIds.size} 条` : `${notes.length} 条笔记`}
        </span>
        <div className="notes-toolbar-actions">
          {batchMode ? (
            <>
              <Button variant="ghost" onClick={selectAll}>{selectedIds.size === notes.length ? "取消全选" : "全选"}</Button>
              <Button
                variant="secondary"
                icon="trash"
                className="danger"
                disabled={selectedIds.size === 0}
                onClick={() => askMany([...selectedIds])}
              >
                删除所选
              </Button>
              <Button variant="ghost" onClick={exitBatch}>取消</Button>
            </>
          ) : (
            <>
              {notes.length > 0 && (
                <Button variant="ghost" icon="cards" onClick={() => setBatchMode(true)}>批量删除</Button>
              )}
              <Button variant="primary" icon="plus" onClick={onNew}>新建笔记</Button>
            </>
          )}
        </div>
      </div>
      {notes.length === 0 ? (
        <div className="note-empty">
          <p>暂无笔记</p>
          <span>在助手回答旁点「存为笔记」，或在右上角新建。</span>
        </div>
      ) : (
        <div className={`note-grid${batchMode ? " note-grid--select" : ""}`}>
          {notes.map((n) => (
            <div
              key={n.id}
              className={`note-thumb${batchMode && selectedIds.has(n.id) ? " selected" : ""}`}
              onClick={() => (batchMode ? toggleSelect(n.id) : onOpen(n))}
            >
              {batchMode && (
                <span className="note-thumb-check" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={selectedIds.has(n.id)}
                    onChange={() => toggleSelect(n.id)}
                    aria-label={`选择笔记「${n.title || "无标题"}」`}
                  />
                </span>
              )}
              <div className="note-thumb-title">{n.title || "无标题"}</div>
              <div className="note-thumb-summary">{markdownToPlainText(n.content_markdown).trim().slice(0, 120) || "（空笔记）"}</div>
              <div className="note-thumb-meta">更新于 {formatDate(n.updated_at)}</div>
              {!batchMode && (
                <IconButton className="note-thumb-delete" icon="trash" label="删除笔记"
                  onClick={(e) => { e.stopPropagation(); askSingle(n); }} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// 笔记编辑器弹窗：标题 input 始终可编辑；正文为就地渲染编辑器（Typora 式）；防抖自动保存。
// 注意：Props 依赖挂载时快照（useState 初值/initialMarkdown），调用方需按 note 切换 key 强制重挂载。
export function NoteEditorDialog({ note, onSave, onDelete, onClose }: {
  note: NoteEditorTarget;
  onSave: (edit: NoteEditorTarget) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  // 新建笔记直接开写正文；打开已有笔记聚焦标题，不打扰内容阅读
  const focusBody = note.id === null;
  const initialRef = useRef({ title: note.title, content: note.content });
  const noteIdRef = useRef(note.id);
  noteIdRef.current = note.id;

  // ESC 关闭
  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  }, [onClose]);
  useEffect(() => {
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleKey]);

  // 防抖自动保存 600ms：新建（id 为 null）预填内容也会自动落库；
  // 已有笔记仅在内容相对打开时确实变化后才写，避免查看即刷 updated_at
  useEffect(() => {
    const unchanged = note.id !== null && title === initialRef.current.title && content === initialRef.current.content;
    if (unchanged) return;
    const timer = window.setTimeout(() => {
      onSave({ id: noteIdRef.current, title, content, editorKey: note.editorKey });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [title, content, onSave]);

  // 关闭：空笔记（已落库后清空）自动清理，避免留下一张空壳
  const handleClose = () => {
    if (noteIdRef.current !== null && !title.trim() && !content.trim()) onDelete(noteIdRef.current);
    onClose();
  };

  return (
    <div className="card-preview-overlay note-editor-overlay" onClick={handleClose}>
      <div className="card-preview-dialog note-editor-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="card-preview-top">
          <input
            className="note-editor-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="笔记标题"
            aria-label="笔记标题"
            autoFocus={!focusBody}
          />
          <div className="card-preview-actions">
            <CopyButton text={content} className="note-copy-md" />
            {note.id !== null && (
              <IconButton icon="trash" label="删除笔记"
                onClick={() => confirmDeleteNotes("单条", 1, note.title, () => onDelete(note.id!))} />
            )}
            <IconButton icon="close" label="关闭" onClick={handleClose} />
          </div>
        </div>
        <div className="note-editor-body">
          <WysiwygEditor
            initialMarkdown={note.content}
            focusAtStart={focusBody}
            onChange={setContent}
          />
        </div>
      </div>
    </div>
  );
}