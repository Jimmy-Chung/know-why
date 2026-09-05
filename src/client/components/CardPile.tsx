import React, { useState, useRef, useCallback, useEffect } from "react";
import { marked } from "marked";
import type { Card, Message, SelectionAnchor, Conversation, ProviderConfig } from "../../shared/types.js";

interface CardPileProps {
  path: Card[]; // 祖先路径，最后一个是当前卡片
  cards: Card[];
  currentCard: Card;
  messages: Message[];
  draft?: { text: string; pending_quote_anchor_id: string | null };
  anchors: SelectionAnchor[];
  activeRuns: Set<string>;
  conv: Conversation;
  provider: ProviderConfig | null;
  onSendMessage: (cardId: string, content: string, quoteAnchorId?: string | null) => void;
  onCreateAnchor: (messageId: string, selectedText: string, start: number, end: number) => Promise<SelectionAnchor | null>;
  onExplore: (anchorId: string) => void;
  onStop: (runId: string) => void;
  onRetry: (runId: string, cardId: string) => void;
  onSaveDraft: (cardId: string, text: string, quoteAnchorId: string | null) => void;
}

// 层叠卡片：前景水平，背景逐层逆时针旋转+模糊
export function CardPile(props: CardPileProps) {
  const { path, currentCard, messages, draft, anchors, conv, provider, onSendMessage, onCreateAnchor, onExplore, onStop, onRetry, onSaveDraft } = props;
  // 背景卡片 = 祖先路径中除当前卡片外的，最多绘制 4 层
  const backCards = path.slice(0, -1).slice(-4);

  return (
    <div className="pile-stage">
      {backCards.map((c, i) => {
        const depth = backCards.length - i; // 1=最远，越大越近
        const rotation = -4.5 * depth;
        const blur = depth * 2.5;
        const opacity = 1 - depth * 0.18;
        return (
          <div
            key={c.id}
            className="ghost-card"
            style={{
              transform: `rotate(${rotation}deg)`,
              filter: `blur(${blur}px)`,
              opacity: Math.max(0.3, opacity),
              zIndex: i + 1,
            }}
          >
            <div className="card-top">
              <span>{c.title || "主卡片"}</span>
              <span>背景层级 {depth}</span>
            </div>
            <div className="card-messages" />
            <div className="card-composer" />
          </div>
        );
      })}
      <div className="foreground-card" style={{ zIndex: 10 }}>
        <CardFace
          card={currentCard}
          messages={messages}
          draft={draft}
          anchors={anchors}
          conv={conv}
          provider={provider}
          onSendMessage={onSendMessage}
          onCreateAnchor={onCreateAnchor}
          onExplore={onExplore}
          onStop={onStop}
          onRetry={onRetry}
          onSaveDraft={onSaveDraft}
          activeRuns={props.activeRuns}
        />
      </div>
    </div>
  );
}

// 单张卡片正面
function CardFace(props: {
  card: Card;
  messages: Message[];
  draft?: { text: string; pending_quote_anchor_id: string | null };
  anchors: SelectionAnchor[];
  conv: Conversation;
  provider: ProviderConfig | null;
  activeRuns: Set<string>;
  onSendMessage: (cardId: string, content: string, quoteAnchorId?: string | null) => void;
  onCreateAnchor: (messageId: string, selectedText: string, start: number, end: number) => Promise<SelectionAnchor | null>;
  onExplore: (anchorId: string) => void;
  onStop: (runId: string) => void;
  onRetry: (runId: string, cardId: string) => void;
  onSaveDraft: (cardId: string, text: string, quoteAnchorId: string | null) => void;
}) {
  const { card, messages, draft, anchors, conv, provider, onSendMessage, onCreateAnchor, onExplore, onStop, onRetry, onSaveDraft, activeRuns } = props;
  const [input, setInput] = useState(draft?.text || "");
  const [pendingQuote, setPendingQuote] = useState<SelectionAnchor | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{ messageId: string; text: string; start: number; end: number; rect: DOMRect } | null>(null);

  // 同步草稿
  useEffect(() => {
    setInput(draft?.text || "");
    if (draft?.pending_quote_anchor_id) {
      // 从 anchors 找
      const a = anchors.find((x) => x.id === draft.pending_quote_anchor_id);
      if (a) setPendingQuote(a);
    } else {
      setPendingQuote(null);
    }
  }, [card.id]); // eslint-disable-line

  // 自动滚动到底部（新消息）
  useEffect(() => {
    if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [messages]);

  // 选区处理：在 AI 回答内选取文本
  const handleSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      setSelection(null);
      return;
    }
    const range = sel.getRangeAt(0);
    const container = messagesRef.current;
    if (!container) return;
    // 找到所属的 message 元素
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
    const msg = messages.find((m) => m.id === messageId);
    if (!msg || msg.role !== "assistant") {
      setSelection(null);
      return;
    }
    const text = sel.toString();
    if (!text.trim()) {
      setSelection(null);
      return;
    }
    // 近似偏移（基于 message 内纯文本）
    const rect = range.getBoundingClientRect();
    setSelection({ messageId, text, start: 0, end: text.length, rect });
  }, [messages]);

  const handleQuote = useCallback(async () => {
    if (!selection) return;
    const anchor = await onCreateAnchor(selection.messageId, selection.text, selection.start, selection.end);
    if (anchor) {
      setPendingQuote(anchor);
      onSaveDraft(card.id, input, anchor.id);
    }
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [selection, onCreateAnchor, onSaveDraft, card.id, input]);

  const handleExplore = useCallback(async () => {
    if (!selection) return;
    const anchor = await onCreateAnchor(selection.messageId, selection.text, selection.start, selection.end);
    if (anchor) {
      onExplore(anchor.id);
    }
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [selection, onCreateAnchor, onExplore]);

  const handleSend = useCallback(() => {
    if (!input.trim() && !pendingQuote) return;
    onSendMessage(card.id, input, pendingQuote?.id || null);
    setInput("");
    setPendingQuote(null);
    onSaveDraft(card.id, "", null);
  }, [input, pendingQuote, card.id, onSendMessage, onSaveDraft]);

  const handleRemoveQuote = useCallback(() => {
    setPendingQuote(null);
    onSaveDraft(card.id, input, null);
  }, [input, onSaveDraft, card.id]);

  // 草稿自动保存（防抖）
  useEffect(() => {
    const t = setTimeout(() => {
      if (input !== (draft?.text || "") || pendingQuote?.id !== draft?.pending_quote_anchor_id) {
        onSaveDraft(card.id, input, pendingQuote?.id || null);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [input, pendingQuote, card.id, draft, onSaveDraft]);

  return (
    <>
      <div className="card-top">
        <span>{card.title || "主卡片"}</span>
        <span>{card.parent_card_id ? "探索分支" : "主卡片"}</span>
      </div>
      <div
        className="card-messages"
        ref={messagesRef}
        onMouseUp={handleSelection}
        onKeyUp={handleSelection}
      >
        {messages.length === 0 && (
          <div className="welcome">
            <div className="welcome-symbol">🌿</div>
            <p>提出你的问题，开始这段探索。</p>
            {provider && (
              <div className="suggestions">
                <button onClick={() => setInput("帮我梳理这个概念的整体脉络")}>梳理脉络</button>
                <button onClick={() => setInput("这背后的关键原理是什么？")}>追问原理</button>
              </div>
            )}
          </div>
        )}
        {messages.map((m) => (
          <MessageView
            key={m.id}
            message={m}
            anchors={anchors.filter((a) => a.source_message_id === m.id)}
            onExplore={onExplore}
            onRetry={onRetry}
            conv={conv}
          />
        ))}
      </div>
      <div className="card-composer">
        {pendingQuote && (
          <div className="composer-quote">
            <span>引用：{pendingQuote.selected_text}</span>
            <button onClick={handleRemoveQuote}>移除</button>
          </div>
        )}
        <textarea
          placeholder="追问或探索……"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSend();
          }}
        />
        <div className="composer-bottom">
          <span>⌘/Ctrl+Enter 发送</span>
          <button className="send-btn" onClick={handleSend} disabled={!input.trim() && !pendingQuote}>
            发送
          </button>
        </div>
      </div>
      {selection && (
        <div
          className="selection-bar"
          style={{
            position: "fixed",
            top: Math.max(10, selection.rect.top - 45),
            left: Math.min(selection.rect.left, window.innerWidth - 200),
          }}
        >
          <button onClick={handleQuote}>❝ 引用</button>
          <button className="explore-btn" onClick={handleExplore}>⎇ 探索</button>
        </div>
      )}
    </>
  );
}

// 单条消息渲染
function MessageView({ message, anchors, onExplore, onRetry, conv }: { message: Message; anchors: SelectionAnchor[]; onExplore: (id: string) => void; onRetry: (runId: string, cardId: string) => void; conv: Conversation }) {
  if (message.role === "user") {
    return (
      <div className="msg-user">
        {message.quote_anchor_id && <QuoteBlock anchorId={message.quote_anchor_id} anchors={anchors} />}
        {message.content}
      </div>
    );
  }
  // assistant
  const html = marked.parse(message.content || "", { async: false }) as string;
  return (
    <div>
      <div className="msg-answer-label">
        <span>✦</span> 回答
      </div>
      <div
        className="msg-answer"
        data-message-id={message.id}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {message.status === "streaming" && <div className="status-row"><span>生成中……</span></div>}
      {message.status === "failed" && (
        <div className="status-row">
          <span className="err">失败：{message.error || "未知错误"}</span>
          {message.run_id && <button className="retry" onClick={() => message.run_id && onRetry(message.run_id, message.card_id)}>重试</button>}
        </div>
      )}
      {message.status === "stopped" && <div className="status-row"><span>已停止</span></div>}
      {anchors.map((a) => (
        a.branch_card_id ? (
          <div key={a.id} className="status-row">
            <span>已创建探索分支：{a.selected_text.slice(0, 20)}</span>
            <button className="retry" onClick={() => onExplore(a.id)}>前往</button>
          </div>
        ) : null
      ))}
    </div>
  );
}

function QuoteBlock({ anchorId, anchors }: { anchorId: string; anchors: SelectionAnchor[] }) {
  const a = anchors.find((x) => x.id === anchorId);
  if (!a) return null;
  return (
    <div className="msg-quote">
      <small>引用原文</small>
      {a.selected_text}
    </div>
  );
}
