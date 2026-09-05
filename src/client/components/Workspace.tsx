import React, { useState, useRef, useCallback, useEffect } from "react";
import type {
  Conversation,
  ProviderConfig,
  Card,
  Message,
  SelectionAnchor,
  KnowledgeAssistantMessage,
  Run,
  WebMode,
  ThinkMode,
} from "../../shared/types.js";
import { CardPile } from "./CardPile.js";
import { TreePanel } from "./TreePanel.js";
import { AssistantPanel } from "./AssistantPanel.js";

interface WorkspaceProps {
  conv: Conversation;
  provider: ProviderConfig | null;
  providers: ProviderConfig[];
  cards: Card[];
  messages: Record<string, Message[]>;
  drafts: Record<string, { text: string; pending_quote_anchor_id: string | null }>;
  anchors: SelectionAnchor[];
  assistantMsgs: KnowledgeAssistantMessage[];
  currentCardId: string | null;
  assistantOpen: boolean;
  activeRuns: Set<string>;
  onSelectCard: (cardId: string | null) => void;
  onSendMessage: (cardId: string, content: string, quoteAnchorId?: string | null) => void;
  onCreateAnchor: (messageId: string, selectedText: string, start: number, end: number) => Promise<SelectionAnchor | null>;
  onExplore: (anchorId: string) => void;
  onStop: (runId: string) => void;
  onRetry: (runId: string, cardId: string) => void;
  onSaveDraft: (cardId: string, text: string, quoteAnchorId: string | null) => void;
  onUpdateSettings: (patch: { web_mode?: WebMode; think_mode?: ThinkMode; title?: string; model?: string }) => void;
  onToggleAssistant: () => void;
}

export function Workspace(props: WorkspaceProps) {
  const {
    conv,
    provider,
    cards,
    messages,
    drafts,
    anchors,
    currentCardId,
    activeRuns,
    onSelectCard,
    onSendMessage,
    onCreateAnchor,
    onExplore,
    onStop,
    onRetry,
    onSaveDraft,
    onUpdateSettings,
  } = props;

  const card = cards.find((c) => c.id === currentCardId) || cards[0] || null;
  const cardMessages = card ? messages[card.id] || [] : [];
  const cardDraft = card ? drafts[card.id] : undefined;
  const cardAnchors = card ? anchors.filter((a) => a.branch_card_id === card.id || a.card_id === card.id) : [];

  // 祖先路径（从根到当前卡片）
  const ancestorPath: Card[] = [];
  let cur = card;
  while (cur) {
    ancestorPath.unshift(cur);
    cur = cur.parent_card_id ? cards.find((c) => c.id === cur!.parent_card_id) || null : null;
  }

  // 模型选择：首条消息前可切，锁定后禁用
  const hasMessages = cards.some((c) => (messages[c.id] || []).length > 0);
  const locked = conv.locked || hasMessages;
  const availableModels = provider?.capabilities.models?.length ? provider.capabilities.models : [conv.model];

  const handleTitleBlur = useCallback(
    (title: string) => {
      if (title && title !== conv.title) onUpdateSettings({ title });
    },
    [conv, onUpdateSettings],
  );

  return (
    <div className="workspace">
      <div className="ws-main">
        <div className="header">
          <div className="title-group">
            <input
              className="title-input"
              defaultValue={conv.title}
              key={conv.id}
              onBlur={(e) => handleTitleBlur(e.target.value)}
              aria-label="会话名称"
            />
          </div>
          <button className="knowledge-btn" onClick={props.onToggleAssistant}>
            ✨ 会话知识助手
          </button>
        </div>
        <div className="toolbar">
          <div className="model-label">
            模型：
            <select
              className="model-picker"
              value={conv.model}
              disabled={locked}
              onChange={(e) => onUpdateSettings({ model: e.target.value })}
              title={locked ? "会话已锁定，首条消息后不可切换模型" : "选择模型"}
            >
              {availableModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            {locked && <span className="model-locked">已锁定</span>}
          </div>
          <div className="capabilities">
            <label className="cap-label">
              🌐
              <select
                value={conv.web_mode}
                disabled={locked && false}
                onChange={(e) => onUpdateSettings({ web_mode: e.target.value as WebMode })}
              >
                <option value="off">联网关闭</option>
                <option value="auto">自动联网</option>
                <option value="force">强制搜索</option>
              </select>
            </label>
            <label className="cap-label">
              💡
              <select
                value={conv.think_mode}
                disabled={!provider?.capabilities.thinking}
                onChange={(e) => onUpdateSettings({ think_mode: e.target.value as ThinkMode })}
                title={provider?.capabilities.thinking ? "思考设置" : "当前模型不支持思考参数"}
              >
                <option value="off">标准思考</option>
                <option value="standard">标准推理</option>
                <option value="deep">深度推理</option>
              </select>
            </label>
          </div>
        </div>
        <div className="content">
          <div className="main">
            <div className="path">
              {ancestorPath.map((c, i) => (
                <React.Fragment key={c.id}>
                  {i > 0 && <span>›</span>}
                  <button onClick={() => onSelectCard(c.id)}>{c.title || "主卡片"}</button>
                </React.Fragment>
              ))}
            </div>
            <div className="stack">
              {card ? (
                <CardPile
                  path={ancestorPath}
                  cards={cards}
                  currentCard={card}
                  messages={cardMessages}
                  draft={cardDraft}
                  anchors={anchors}
                  activeRuns={activeRuns}
                  onSendMessage={onSendMessage}
                  onCreateAnchor={onCreateAnchor}
                  onExplore={onExplore}
                  onStop={onStop}
                  onRetry={onRetry}
                  onSaveDraft={onSaveDraft}
                  conv={conv}
                  provider={provider}
                />
              ) : (
                <div className="welcome">
                  <div className="welcome-symbol">🌿</div>
                  <p>开始你的第一次探索。</p>
                </div>
              )}
            </div>
          </div>
          <TreePanel cards={cards} currentCardId={card?.id || null} onSelect={onSelectCard} />
        </div>
      </div>
      {props.assistantOpen && (
        <AssistantPanel
          conv={conv}
          provider={provider}
          messages={props.assistantMsgs}
          cards={cards}
          allMessages={messages}
          onSendAssistant={async (question) => {
            const r = await api.sendAssistant(conv.id, question);
            // 订阅 run 并在完成后刷新会话以加载助手回答
            api.streamRun(
              r.runId,
              (e) => {
                if (e.type === "done" || e.type === "error") {
                  loadConversationById(conv.id);
                }
              },
            );
          }}
          onSelectCard={onSelectCard}
        />
      )}
    </div>
  );
}

import { api } from "../api.js";
async function loadConversationById(id: string) {
  // 通过自定义事件触发 App 重新加载；这里用 window 事件简化
  window.dispatchEvent(new CustomEvent("kk-reload-conversation", { detail: id }));
}
