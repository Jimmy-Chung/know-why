import { Icon } from "./ui/Icon.js";
import { NOTES_ENABLED } from "../../shared/features.js";
import { Button, IconButton } from "./ui/Button.js";
import { Tooltip } from "./ui/Tooltip.js";
import { CopyButton } from "./ui/CopyButton.js";
import React, { useState, useRef, useEffect, useMemo, useLayoutEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { renderMarkdown, markdownToPlainText } from "../markdown.js";
import { MentionGraph } from "./MentionGraph.js";
import { useExitValue } from "../usePanelPresence.js";
import { mentionAtCaret, selectMentionBranch, stripMentionTrigger } from "../mention.js";
import type { Conversation, ProviderConfig, KnowledgeAssistantMessage, Card, Message, SSEEvent } from "../../shared/types.js";
import { api } from "../api.js";

interface AssistantPanelProps {
  closing?: boolean;
  conv: Conversation;
  provider: ProviderConfig | null;
  messages: KnowledgeAssistantMessage[];
  cards: Card[];
  allMessages: Record<string, Message[]>;
  currentThreadId: string | null;
  onSetCurrentThreadId: (id: string | null) => void;
  onSendAssistant: (question: string, threadId: string | null, quote?: string | null, scopeCardIds?: string[] | null) => Promise<{ userMsgId: string; runId: string }>;
  onGoToMessage: (cardId: string, messageId: string) => void;
  onNewNote: (content: string) => void;
  onClose: () => void;
}

// 线程标题：首条用户提问截断（前 16 字，过长加 …）
function threadTitle(msgs: KnowledgeAssistantMessage[]): string {
  const first = msgs.find((m) => m.role === "user");
  if (!first) return "问答";
  const t = first.content.trim().replace(/\s+/g, " ");
  return t.length > 16 ? t.slice(0, 16) + "…" : t || "问答";
}

export function AssistantPanel({ conv, provider, messages, cards, allMessages, currentThreadId, onSetCurrentThreadId, onSendAssistant, onGoToMessage, onNewNote, onClose, closing = false }: AssistantPanelProps) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState("正在查找相关对话……");
  const [sendError, setSendError] = useState("");
  const [sendingThread, setSendingThread] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [width, setWidth] = useState<number>(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem("kk-assistant-width") : null;
    const n = saved ? parseInt(saved, 10) : NaN;
    return Number.isFinite(n) && n >= 300 && n <= 720 ? n : 440;
  });
  const bodyRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  // 选中助手回答片段 → 引用到提问：选区定位 + 待发送引用
  const [selection, setSelection] = useState<{ messageId: string; text: string; rect: DOMRect } | null>(null);
  const visibleSelection = useExitValue(selection);
  const [pendingQuote, setPendingQuote] = useState<string | null>(null);
  // @ 作用域：用户可选若干卡片，本次提问的检索只在这些卡范围内进行
  const [scopeCardIds, setScopeCardIds] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [picker, setPicker] = useState<{ query: string; idx: number; start: number; end: number; draft?: string[] } | null>(null);

  const shownPicker = useExitValue(picker);

  // 拖拽左边缘调整宽度
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const w = window.innerWidth - e.clientX;
      setWidth(Math.min(720, Math.max(300, w)));
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.localStorage.setItem("kk-assistant-width", String(width));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [width]);

  // 乐观插入的用户提问：发送后立即在面板显示，run 完成后由 loadConversation 的真实数据覆盖
  const [optimistic, setOptimistic] = useState<KnowledgeAssistantMessage[]>([]);
  const connectionRef = useRef<{id:string; close:()=>void} | null>(null);
  const mountedRef = useRef(true);
  const blockedReconnect = useRef(new Set<string>());
  const [reconnect, setReconnect] = useState<{id:string; threadId:string|null}|null>(null);
  useEffect(()=>{
    mountedRef.current=true;
    return ()=>{mountedRef.current=false;connectionRef.current?.close();connectionRef.current=null;};
  },[]);
  const connectRun = useCallback((id:string,threadId:string|null)=>{
    if(connectionRef.current?.id===id)return;
    connectionRef.current?.close();
    blockedReconnect.current.delete(id);
    setReconnect(null);setSendError("");setRunId(id);setLoading(true);setSendingThread(threadId);
    setStatusText("正在查找相关对话……");
    const close=api.streamRun(id,event=>{
      if(!mountedRef.current)return;
      if(event.type==="assistant_message") {
        setOptimistic(prev=>[...prev.filter(m=>m.id!==event.message.id),event.message]);
        if(event.message.status==="streaming" && event.message.content)setStatusText("正在依据会话资料回答……");
      }
      else if(event.type==="assistant_delta") {
        setOptimistic(prev=>prev.map(m=>m.id===event.message_id?{...m,content:m.content+event.text}:m));
        setStatusText("正在依据会话资料回答……");
      }
      else if(event.type==="status" && event.detail)setStatusText(event.detail);
      if(event.type==="error") {
        setSendError(event.message);
        if(!event.run){blockedReconnect.current.add(id);setReconnect({id,threadId});}
      }
      if(event.type==="done" || event.type==="error") {
        setLoading(false);setRunId(null);
        connectionRef.current?.close();connectionRef.current=null;
        window.dispatchEvent(new CustomEvent("kk-reload-conversation",{detail:conv.id}));
      }
    });
    connectionRef.current={id,close};
  },[conv.id]);
  useEffect(()=>{
    if(connectionRef.current)return;
    const pending=[...messages].reverse().find(m=>m.thread_id===currentThreadId && m.run_id &&
      ["queued","running","searching","reading"].includes(m.run_status || "") && !blockedReconnect.current.has(m.run_id));
    if(pending?.run_id)connectRun(pending.run_id,pending.thread_id);
  },[messages,currentThreadId,connectRun]);


  useEffect(() => {
    const ids = new Set(messages.filter(m=>m.status!=="streaming").map(m=>m.id));
    setOptimistic(prev=>prev.filter(m=>!ids.has(m.id)));
  }, [messages]);

  // 按线程分组（thread_id 为 null 的旧消息归为一组，键用 "__legacy__"）
  const threads = useMemo(() => {
    const map = new Map<string, KnowledgeAssistantMessage[]>();
    // Live text may be ahead of the last DB flush; complete server messages win.
    const combined = new Map(messages.map(m=>[m.id,m]));
    for (const m of optimistic) {
      const saved = combined.get(m.id);
      if (!saved || saved.status === "streaming") combined.set(m.id,m);
    }
    for (const m of combined.values()) {
      const key = m.thread_id ?? "__legacy__";
      if (!map.has(key)) map.set(key,[]);
      map.get(key)!.push(m);
    }
    // 每组按 created_at 升序，整体按组内最新消息时间降序
    return [...map.entries()]
      .map(([key, msgs]) => ({ key, msgs: msgs.sort((a, b) => a.created_at.localeCompare(b.created_at)), title: key === "__legacy__" ? "历史问答" : threadTitle(msgs) }))
      .sort((a, b) => b.msgs[b.msgs.length - 1]!.created_at.localeCompare(a.msgs[a.msgs.length - 1]!.created_at));
  }, [messages, optimistic]);

  // 当前线程展示用键：currentThreadId 为 null 时映射到 __legacy__
  const currentKey = currentThreadId ?? "__legacy__";
  const currentMsgs = threads.find((t) => t.key === currentKey)?.msgs ?? [];

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [currentMsgs, loading]);

  const handleNewThread = () => {
    setShowHistory(false);
    onSetCurrentThreadId(crypto.randomUUID());
  };

  // @ picker 点击外部关闭（mousedown 在 textarea 与 picker 之外才关）
  useEffect(() => {
    if (!picker) return;
    const onDown = (e: Event) => {
      const t = e.target as HTMLElement;
      if (t.closest(".mention-picker") || t === textareaRef.current || (picker.draft && t.closest(".send-btn"))) return;
      setPicker(null);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("focusin", onDown);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("focusin", onDown);
    };
  }, [picker]);

  // 选区处理：在助手回答内选取文本 → 引用。仅 assistant 消息可引用
  const handleSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      setSelection(null);
      return;
    }
    const range = sel.getRangeAt(0);
    const container = bodyRef.current;
    if (!container) return;
    // 找到所属的 message 元素（.msg-answer 带 data-message-id）
    let node: Node | null = range.commonAncestorContainer;
    while (node && node !== container) {
      if (node.nodeType === 1 && (node as HTMLElement).dataset?.messageId) break;
      node = node.parentNode;
    }
    if (!node || node === container) {
      setSelection(null);
      return;
    }
    const el = node as HTMLElement;
    const messageId = el.dataset.messageId!;
    const text = sel.toString();
    if (!text.trim()) {
      setSelection(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    setSelection({ messageId, text, rect });
  }, []);

  // 引用：把选中文本放入待发送引用块
  const handleQuote = useCallback(() => {
    if (!selection) return;
    setPendingQuote(selection.text);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [selection]);

  const handleRemoveQuote = useCallback(() => setPendingQuote(null), []);

  const pickerCards = useMemo(() => {
    const query = shownPicker?.query.toLowerCase() ?? "";
    return cards.filter(card => (card.title || "主卡片").toLowerCase().includes(query));
  }, [shownPicker?.query, cards]);

  const applyScope = (ids: string[]) => {
    if (!picker || !ids.length) return;
    setScopeCardIds(ids);
    // Opening from the scope chip has no @ token to remove.
    const { text, caret } = picker.start === picker.end
      ? { text: input, caret: picker.start }
      : stripMentionTrigger(input, picker.start, picker.end);
    setInput(text);
    setPicker(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      ta?.focus();
      ta?.setSelectionRange(caret, caret);
    });
  };

  const selectNode = (id: string, shift: boolean) => {
    if (!picker) return;
    const editing = shift || picker.draft !== undefined;
    const ids = selectMentionBranch(cards, picker.draft ?? scopeCardIds, id, editing);
    if (editing) {
      // Reveal descendants even when the parent was found by typing a title.
      setPicker({ ...picker, query: "", idx: cards.findIndex(card => card.id === id), draft: ids });
    } else {
      applyScope(ids);
    }
  };

  const editScope = () => {
    const caret = textareaRef.current?.selectionStart ?? input.length;
    setPicker({ start: caret, end: caret, ...picker, query: "", idx: 0, draft: [...scopeCardIds] });
    textareaRef.current?.focus();
  };

  // 输入变化：检测光标前刚输入的 @（前一个字符为空格或行首，或为首个字符）
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setInput(v);
    const trigger = mentionAtCaret(v, e.target.selectionStart);
    setPicker(previous => trigger && { ...trigger, idx: 0, draft: previous?.draft });
  }, []);

  const handlePickerKey = (e: React.KeyboardEvent) => {
    if (!picker || e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setPicker((p) => p ? { ...p, idx: Math.max(0, Math.min(pickerCards.length - 1, p.idx + 1)) } : p); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setPicker((p) => p ? { ...p, idx: Math.max(0, p.idx - 1) } : p); }
    else if (e.key === "Enter") { e.preventDefault(); const c = pickerCards[picker.idx]; if (c) selectNode(c.id, e.shiftKey); }
    else if (e.key === "Escape") { e.preventDefault(); setPicker(null); }
    else if (e.key === "Tab" && !e.shiftKey && picker.draft) {
      e.preventDefault();
      document.querySelector<HTMLButtonElement>(".mention-picker .mention-done:enabled, .mention-picker .mention-cancel")?.focus();
    }
  };

  // Backspace 在输入框空且无 picker 时，移除范围标签
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (picker) { handlePickerKey(e); return; }
    if (e.key === "Backspace" && input === "" && scopeCardIds.length > 0) {
      e.preventDefault();
      setScopeCardIds([]);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = async () => {
    if (!input.trim() || loading || picker?.draft) return;
    const question = input.trim();
    const quote = pendingQuote;
    const scope = scopeCardIds.length ? [...scopeCardIds] : null;
    const threadId = currentThreadId;
    const questionCreatedAt = new Date().toISOString();
    setLoading(true);
    setInput("");
    setPendingQuote(null);
    setScopeCardIds([]);
    setPicker(null);
    setSendError("");
    setStatusText("正在查找相关对话……");
    setSendingThread(threadId);
    try {
      const r = await onSendAssistant(question, threadId, quote, scope);
      if(!mountedRef.current){window.dispatchEvent(new CustomEvent("kk-reload-conversation",{detail:conv.id}));return;}
      connectRun(r.runId,threadId);
      if (r.userMsgId) setOptimistic(prev => [...prev.filter(m=>m.id!==r.userMsgId),{
        id:r.userMsgId,conversation_id:conv.id,role:"user",content:question,evidence:[],
        run_id:r.runId,thread_id:threadId,created_at:questionCreatedAt,status:"complete",quote,
        scope_card_ids:scope,
      }]);
    } catch(error) {
      setLoading(false);
      setRunId(null);
      setInput(question);
      setPendingQuote(quote);
      setScopeCardIds(scope || []);
      setSendError(error instanceof Error?error.message:"提问失败，请重试。");
    }
  };

  const handleStop = async () => {
    if (runId) {
      try { await api.stopRun(runId); } catch { setSendError("停止请求未送达，请重试。"); }
    }
  };

  return (
    <aside className={`assistant-panel${closing ? " assistant-panel--closing" : ""}`} aria-hidden={closing || undefined} {...{ inert: closing ? "" : undefined }} aria-label="会话知识助手" style={{ "--assistant-width": `${width}px` } as React.CSSProperties}>
      <Tooltip content="拖动调整宽度" placement="right"><div className="assistant-resize-handle" onMouseDown={startResize} /></Tooltip>
      <div className="assistant-header">
        <div className="assistant-header-title">
          <h2><Icon name="assistant" />会话知识助手</h2>
          <p>回顾、串联你的探索</p>
        </div>
        <div className="assistant-header-actions">
          <IconButton onClick={handleNewThread} icon="newChat" label="新建问答" />
          <IconButton onClick={() => setShowHistory(v => !v)} icon="history" label="历史问答列表" aria-pressed={showHistory} />
          <IconButton onClick={onClose} icon="close" label="关闭助手" />
        </div>
      </div>
      {showHistory ? (
        // 历史列表展开时：取代主区，只列线程标题；点击即打开该问答到主区并收起列表
        threads.length > 0 ? (
          <div className="assistant-thread-list assistant-thread-list-full">
            <div className="assistant-thread-list-title">历史（仅本会话）</div>
            {threads.map((t) => (
              <button
                type="button"
                key={t.key}
                className={"assistant-thread-item" + (t.key === currentKey ? " active" : "")}
                onClick={() => { onSetCurrentThreadId(t.key === "__legacy__" ? null : t.key); setShowHistory(false); }}
              >
                <span className="dot">{t.key === currentKey ? "●" : "○"}</span>
                <span className="label">{t.title}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="assistant-thread-empty">暂无历史问答</div>
        )
      ) : (
        <>
          <div className="assistant-reading-area">
            <div className="assistant-body" ref={bodyRef} onMouseUp={handleSelection} onKeyUp={handleSelection}>
              {currentMsgs.length === 0 && <p className="assistant-empty">{currentThreadId ? "新建问答线程，输入你的问题。" : "试试问「我们刚才探索过哪些概念？」，或用 @ 选中卡片让助手比较差异。"}</p>}
              {currentMsgs.map((m) => (
                <AssistantMessageView key={m.id} message={m} cards={cards} allMessages={allMessages} onGoToMessage={onGoToMessage} onNewNote={onNewNote} />
              ))}
              {sendError && <div role="alert" className="status-row">{sendError}{reconnect && <button onClick={()=>connectRun(reconnect.id,reconnect.threadId)}>重新连接</button>}</div>}
              {loading && sendingThread === currentThreadId && <div className="status-row"><span>{statusText}</span><button className="stop" onClick={handleStop} title="中断生成">停止</button></div>}
            </div>
            {shownPicker && <MentionGraph cards={cards} selected={shownPicker.draft ?? scopeCardIds}
              editing={shownPicker.draft !== undefined} onEdit={editScope} onApply={() => applyScope(picker?.draft ?? [])}
              matches={pickerCards} activeIndex={shownPicker.idx} closing={!picker || closing}
              onHighlight={idx => setPicker(p => p && p.idx !== idx ? { ...p, idx } : p)}
              onClose={() => { setPicker(null); textareaRef.current?.focus(); }} onSelect={selectNode} />}
          </div>
          <div className="card-composer">
            {pendingQuote && (
              <div className="composer-quote" role="group" aria-label="已引用的原文，随问题一并发送">
                <p className="composer-quote-text" title={pendingQuote}>{pendingQuote}</p>
                <IconButton onClick={handleRemoveQuote} icon="close" label="移除引用" className="composer-quote-remove" />
              </div>
            )}
            {scopeCardIds.length > 0 && (
              <div className="scope-chips" role="group" aria-label="已限定检索范围的卡片">
                <span className="scope-chip">
                  <button type="button" className="scope-chip-label" onClick={editScope} title="编辑引用范围">
                    @{cards.find(card => card.id === scopeCardIds[0])?.title || "卡片"}{scopeCardIds.length > 1 && ` 等 ${scopeCardIds.length} 个节点`}
                  </button>
                  <button type="button" className="scope-chip-remove" aria-label="移除引用范围" onClick={() => setScopeCardIds([])}>×</button>
                </span>
              </div>
            )}
            <textarea
              ref={textareaRef}
              aria-label="向会话助手提问" aria-autocomplete="list"
              aria-controls={picker ? "mention-options" : undefined}
              aria-activedescendant={picker && pickerCards[picker.idx] ? `mention-${pickerCards[picker.idx]!.id}` : undefined}
              onSelect={event => {
                const ta = event.currentTarget;
                if (picker && (ta.selectionEnd !== picker.end || ta.selectionStart !== ta.selectionEnd)) setPicker(null);
              }}
              placeholder="询问当前会话的内容……（输入 @ 从节点图中选卡片）"
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
            />
            <div className="composer-bottom">
              <span>仅把该会话的内容作为知识库</span>
              <Tooltip content="提问"><Button variant="primary" className="send-btn" icon="arrowUp" aria-label="提问" onClick={handleSend} disabled={!input.trim() || loading || !!picker?.draft} /></Tooltip>
            </div>
          </div>
        </>
      )}
      {visibleSelection && createPortal(
        <div
          className="selection-bar" data-closing={!selection} {...{ inert: !selection ? "" : undefined }}
          style={{
            position: "fixed",
            top: Math.max(10, visibleSelection.rect.top - 45),
            left: Math.max(8, Math.min(visibleSelection.rect.left, window.innerWidth - 100)),
          }}
        >
          <IconButton onClick={handleQuote} icon="quote" label="引用到提问" />
        </div>,
        document.body,
      )}
    </aside>
  );
}

// 去掉助手回答正文末尾的「来源」清单与内部证据标记：
// 旧的 formatEvidence 拼接、LLM 自行罗列、上下文标签 [证据N] 都不该出现在正文里，
// 统一在渲染前剥离；引用角标 [1] 由 useLayoutEffect 转成可点击徽章。
function stripTrailingSources(content: string): string {
  return content
    .replace(/\n{2,}(?:#{1,6}\s*)?\*{0,2}来源\*{0,2}\s*[:：][\s\S]*$/i, "")
    .replace(/\n+$/, "")
    .replace(/[（(「『\[]?\s*证据\s*\d+\s*[）)」』\]]?/g, "");
}

// 证据按卡片去重，与后端「证据N」上下文序号一致
function dedupByCard<T extends { card_id: string }>(evidence: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const ev of evidence) {
    if (!seen.has(ev.card_id)) { seen.add(ev.card_id); out.push(ev); }
  }
  return out;
}

const AssistantMessageView = React.memo(function AssistantMessageView({ message, cards, allMessages, onGoToMessage, onNewNote }: { message: KnowledgeAssistantMessage; cards: Card[]; allMessages: Record<string, Message[]>; onGoToMessage: (cardId: string, messageId: string) => void; onNewNote: (content: string) => void }) {
  const contentRef = useRef<HTMLDivElement>(null);
  if (message.role === "user") {
    return (
      <div className="assistant-msg-user-wrap">
        <div className="assistant-msg-user">
          {message.quote && (
            <div className="msg-quote"><small>引用原文</small>{message.quote}</div>
          )}
          {message.scope_card_ids && message.scope_card_ids.length > 0 && (
            <SentScope ids={message.scope_card_ids} cards={cards} />
          )}
          {message.content}
        </div>
        <div className="assistant-message-actions assistant-message-actions--user">
          <CopyButton text={message.content} iconOnly />
        </div>
      </div>
    );
  }
  const evidenceList = dedupByCard(message.evidence);
  const source = stripTrailingSources(message.content || "");
  const html = renderMarkdown(source);
  const plainText = markdownToPlainText(source);
  // 把正文 [N] 转成可点击徽章：hover 弹卡片信息，点击前往该卡片
  return (
    <div className="assistant-answer-turn">
      <EvidenceBadge messageId={message.id} content={message.content || ""} evidence={evidenceList} cards={cards} allMessages={allMessages} onGoToMessage={onGoToMessage} html={html} contentRef={contentRef} />
      <div className="assistant-message-actions assistant-message-actions--answer">
        {NOTES_ENABLED && <IconButton icon="notePlus" label="存为笔记" onClick={() => onNewNote(source)} />}
        <CopyButton text={plainText} iconOnly />
      </div>
      {message.status === "stopped" && <small>已停止生成</small>}
      {message.status === "failed" && <small>回答未完成，可重新提问</small>}
    </div>
  );
});

function SentScope({ ids, cards }: { ids: string[]; cards: Card[] }) {
  const titles = new Map(cards.map(card => [card.id, card.title]));
  const chips = <div className="scope-chips scope-chips--readonly" aria-label="提问作用域">
    {ids.map(id => <span key={id} className="scope-chip">@{titles.get(id) || "卡片"}</span>)}
  </div>;
  if (ids.length <= 3) return chips;
  return <details className="scope-history"><summary>引用了 {ids.length} 个节点</summary>{chips}</details>;
}

// 证据徽章 + 浮窗：复用 .cite-badge/.cite-popover 样式，把 [N] 角标转成带卡片信息的可点击徽章
function EvidenceBadge({ messageId, content, evidence, cards, allMessages, onGoToMessage, html, contentRef }: {
  messageId: string;
  content: string;
  evidence: KnowledgeAssistantMessage["evidence"];
  cards: Card[];
  allMessages: Record<string, Message[]>;
  onGoToMessage: (cardId: string, messageId: string) => void;
  html: string;
  contentRef: React.RefObject<HTMLDivElement>;
}) {
  const [activeCite, setActiveCite] = useState<{ idx: number; rect: DOMRect } | null>(null);
  const visibleCite = useExitValue(activeCite);
  const hoverTimer = useRef<number | null>(null);
  const clearTimer = () => { if (hoverTimer.current) { window.clearTimeout(hoverTimer.current); hoverTimer.current = null; } };
  const scheduleClose = () => { clearTimer(); hoverTimer.current = window.setTimeout(() => setActiveCite(null), 220); };

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el || evidence.length === 0) return;
    // 遍历文本节点，跳过已在 <a>/代码/徽章内的节点
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest("a, code, pre, .cite-badge")) return NodeFilter.FILTER_REJECT;
        return /\[\d+\]/.test(node.textContent || "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const nodes: Text[] = [];
    let n = walker.nextNode() as Text | null;
    while (n) { nodes.push(n); n = walker.nextNode() as Text | null; }
    for (const node of nodes) {
      const text = node.textContent || "";
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const m of text.matchAll(/\[(\d+)\]/g)) {
        const idx = Number(m[1]);
        if (Number.isNaN(idx) || idx < 1 || idx > evidence.length) continue;
        const at = m.index!;
        if (at > last) frag.appendChild(document.createTextNode(text.slice(last, at)));
        const ev = evidence[idx - 1]!;
        const card = cards.find((c) => c.id === ev.card_id);
        const badge = document.createElement("span");
        badge.className = "cite-badge";
        badge.dataset.srcIdx = String(idx);
        badge.tabIndex = 0;
        badge.title = card?.title || "卡片";
        const label = document.createElement("span");
        label.className = "cite-badge-label";
        label.textContent = card?.title || "卡片";
        badge.appendChild(label);
        badge.addEventListener("mouseenter", () => {
          clearTimer();
          setActiveCite({ idx, rect: badge.getBoundingClientRect() });
        });
        badge.addEventListener("mouseleave", () => {
          scheduleClose();
        });
        badge.addEventListener("click", () => { clearTimer(); onGoToMessage(ev.card_id, ev.message_id); });
        frag.appendChild(badge);
        last = at + m[0].length;
      }
      if (last === 0) continue;
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode?.replaceChild(frag, node);
    }
  }, [content, evidence, cards, onGoToMessage]);

  const activeEv = visibleCite != null ? evidence[visibleCite.idx - 1] : null;
  const activeCard = activeEv ? cards.find((c) => c.id === activeEv.card_id) : null;
  const activeMsg = activeEv ? allMessages[activeEv.card_id]?.find((m) => m.id === activeEv.message_id) : undefined;

  return (
    <div className="assistant-msg-answer">
      <div className="msg-answer" ref={contentRef} data-message-id={messageId} dangerouslySetInnerHTML={{ __html: html }} />
      {activeEv && visibleCite && activeCard && (
        <EvidencePopover
          card={activeCard}
          msg={activeMsg}
          excerpts={activeEv.excerpts?.map(e=>e.text)}
          closing={!activeCite} rect={visibleCite.rect}
          onEnter={clearTimer}
          onLeave={scheduleClose}
          onClose={() => { clearTimer(); setActiveCite(null); }}
        />
      )}
    </div>
  );
}

// 证据浮窗仅预览来源；移出时收起，点击正文徽章仍可跳转卡片。
// 不用 portal：.assistant-panel 无 transform/filter 祖先，position:fixed 直接相对视口；
// 且 portal 挂在 document.body 时 React 合成事件（mouseenter/mouseleave/click）不触发
function EvidencePopover({ closing, card, msg, excerpts, rect, onEnter, onLeave, onClose }: {
  closing: boolean;
  card: Card;
  msg?: Message;
  excerpts?: string[];
  rect: DOMRect;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const W = Math.min(420, window.innerWidth * 0.92);
  // 边界处理：若下方空间不足则翻转到徽章上方；用 bottom 定位让浮窗底部紧贴徽章上方，避免估算高度产生间隙
  const estH = 240;
  const vh = window.innerHeight;
  const placeBelow = rect.bottom + estH < vh;
  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.max(8, Math.min(rect.left, window.innerWidth - W - 8)),
    zIndex: 1000,
  };
  if (placeBelow) {
    style.top = rect.bottom;
  } else {
    style.bottom = vh - rect.top + 4;
  }
  return (
    <div className="cite-popover" data-closing={closing} style={style} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className="cite-popover-head">
        <Icon name="cards" />
        <div className="cite-popover-title">{card.title || "主卡片"}</div>
      </div>
      <div className="cite-popover-host">{msg ? `${msg.role === "user" ? "用户提问" : "助手回答"}` : "卡片内容"}</div>
      {(excerpts?.length || msg?.plaintext) && <div className="cite-popover-snippet">{excerpts?.join("\n\n") || msg?.plaintext.slice(0, 240)}</div>}
    </div>
  );
}
