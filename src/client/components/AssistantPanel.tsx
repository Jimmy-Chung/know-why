import React, { useState, useRef, useEffect } from "react";
import { marked } from "marked";
import type { Conversation, ProviderConfig, KnowledgeAssistantMessage, Card, Message } from "../../shared/types.js";
import { api } from "../api.js";

interface AssistantPanelProps {
  conv: Conversation;
  provider: ProviderConfig | null;
  messages: KnowledgeAssistantMessage[];
  cards: Card[];
  allMessages: Record<string, Message[]>;
  onSendAssistant: (question: string) => Promise<any>;
  onSelectCard: (cardId: string | null) => void;
}

export function AssistantPanel({ conv, provider, messages, cards, allMessages, onSendAssistant, onSelectCard }: AssistantPanelProps) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, loading]);

  const handleSend = async () => {
    if (!input.trim() || loading) return;
    setLoading(true);
    setInput("");
    await onSendAssistant(input);
    setLoading(false);
  };

  return (
    <aside className="assistant-panel" aria-label="会话知识助手">
      <div className="assistant-header">
        <div>
          <h2>✨ 会话知识助手</h2>
          <p>基于当前会话所有分支的已有内容回答</p>
        </div>
      </div>
      <div className="assistant-scope">
        检索范围：当前会话「{conv.title}」· 全部分支 · 不联网
      </div>
      <div className="assistant-body" ref={bodyRef}>
        {messages.length === 0 && <p style={{ color: "var(--muted)", fontSize: 12 }}>问问我刚才探索过哪些概念？或是比较两个分支的内容。</p>}
        {messages.map((m) => (
          <AssistantMessageView key={m.id} message={m} cards={cards} allMessages={allMessages} onSelectCard={onSelectCard} />
        ))}
        {loading && <div className="status-row"><span>检索会话内容并整理回答……</span></div>}
      </div>
      <div className="card-composer">
        <textarea
          placeholder="询问当前会话的内容……"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSend();
          }}
        />
        <div className="composer-bottom">
          <span>不使用模型外部知识</span>
          <button className="send-btn" onClick={handleSend} disabled={!input.trim() || loading}>
            提问
          </button>
        </div>
      </div>
    </aside>
  );
}

function AssistantMessageView({ message, cards, allMessages, onSelectCard }: { message: KnowledgeAssistantMessage; cards: Card[]; allMessages: Record<string, Message[]>; onSelectCard: (id: string | null) => void }) {
  if (message.role === "user") {
    return <div className="assistant-msg-user">{message.content}</div>;
  }
  const html = marked.parse(message.content || "", { async: false }) as string;
  return (
    <div className="assistant-msg-answer">
      <div className="msg-answer" dangerouslySetInnerHTML={{ __html: html }} />
      {message.evidence.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <small>来源：</small>
          {message.evidence.map((ev, i) => {
            const card = cards.find((c) => c.id === ev.card_id);
            const msg = allMessages[ev.card_id]?.find((m) => m.id === ev.message_id);
            return (
              <div
                key={i}
                className="assistant-citation"
                onClick={() => {
                  onSelectCard(ev.card_id);
                }}
              >
                <span>
                  [{i + 1}] {card?.title || "卡片"}
                  {msg ? ` · ${msg.role === "user" ? "提问" : "回答"}` : ""}
                </span>
                <span>→</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
