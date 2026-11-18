import { Icon } from "./ui/Icon.js";
import { Button, IconButton } from "./ui/Button.js";
import { normalizeThinkMode, reasoningOptions, UNKNOWN_REASONING, THINK_LABELS, type ModelCatalog } from "../../shared/reasoning.js";
import type { ConversationSettingsPatch, ThinkMode, WebMode } from "../../shared/types.js";
import React, { useState, useRef, useCallback, useEffect } from "react";
import { renderMarkdown } from "../markdown.js";
import type {
  Conversation,
  ProviderConfig,
  Card,
  Message,
  SelectionAnchor,
  TermLink,
  KnowledgeAssistantMessage,
  Run,
  Attachment,
  NoteCard,
  SearchConfig,
} from "../../shared/types.js";
import { CardPile } from "./CardPile.js";
import { TreePanel } from "./TreePanel.js";
import { isCrossBranchReference, REFERENCE_TRACE_MS, type SelectCard, type TreeReference } from "../tree-reference.js";
import { AssistantPanel } from "./AssistantPanel.js";
import { usePanelPresence } from "../usePanelPresence.js";
import { NoteListGrid, NoteEditorDialog, type NoteEditorTarget } from "./Notes.js";

interface WorkspaceProps {
  conv: Conversation;
  provider: ProviderConfig | null;
  providers: ProviderConfig[];
  cards: Card[];
  messages: Record<string, Message[]>;
  drafts: Record<string, { text: string; pending_quote_anchor_id: string | null }>;
  anchors: SelectionAnchor[];
  termLinks: TermLink[];
  assistantMsgs: KnowledgeAssistantMessage[];
  notes: NoteCard[];
  activeTab: "chat" | "notes";
  onSetTab: (tab: "chat" | "notes") => void;
  editingNote: NoteEditorTarget | null;
  onNewNote: (content: string) => void;
  onOpenNote: (note: NoteCard) => void;
  onSaveNote: (edit: NoteEditorTarget) => void;
  onDeleteNote: (id: string) => void;
  onDeleteNotes: (ids: string[]) => void;
  onCloseNoteEditor: () => void;
  currentCardId: string | null;
  currentThreadId: string | null;
  assistantOpen: boolean;
  activeRuns: Set<string>;
  runStatuses: Record<string, string>;
  onSelectCard: (cardId: string | null) => void;
  onSendMessage: (cardId: string, content: string, quoteAnchorId?: string | null, attachments?: Attachment[]) => void;
  onCreateAnchor: (messageId: string, selectedText: string, start: number, end: number) => Promise<SelectionAnchor | null>;
  onExplore: (anchorId: string) => void;
  onExploreTerm: (src: { message_id: string; card_id: string; selected_text: string; start_offset: number; end_offset: number }) => void;
  onCleanStaleTermLinks: () => void;
  onStop: (runId: string) => void;
  onRetry: (runId: string, cardId: string) => void;
  onSaveDraft: (cardId: string, text: string, quoteAnchorId: string | null) => void;
  onUpdateSettings: (patch: ConversationSettingsPatch) => Promise<void>;
  onToggleAssistant: () => void;
  onSetCurrentThreadId: (id: string | null) => void;
  previewCardId: string | null;
  onPreviewCard: (id: string | null) => void;
  pendingScroll: { cardId: string; messageId: string } | null;
  onGoToMessage: (cardId: string, messageId: string) => void;
  onConsumedScroll: () => void;
}

export function Workspace(props: WorkspaceProps) {
  const assistantPresent = usePanelPresence(props.assistantOpen);
  const {
    conv,
    provider,
    cards,
    messages,
    drafts,
    anchors,
    termLinks,
    currentCardId,
    activeRuns,
    runStatuses,
    onSelectCard: selectCard,
    onSendMessage,
    onCreateAnchor,
    onExplore,
    onExploreTerm,
    onCleanStaleTermLinks,
    onStop,
    onRetry,
    onSaveDraft,
  } = props;
  const [reference, setReference] = useState<TreeReference | null>(null);
  const referenceSequence = useRef(0);
  const onSelectCard: SelectCard = useCallback((targetId, origin) => {
    setReference(targetId && origin && isCrossBranchReference(cards, origin.sourceCardId, targetId)
      ? { id: ++referenceSequence.current, sourceCardId: origin.sourceCardId, targetCardId: targetId }
      : null);
    selectCard(targetId);
  }, [cards, selectCard]);
  useEffect(() => {
    if (!reference) return;
    const timer = window.setTimeout(() => setReference(null), REFERENCE_TRACE_MS + 50);
    return () => window.clearTimeout(timer);
  }, [reference]);
  const [savingSettings, setSavingSettings] = useState(false);
  const savingRef = useRef(false);
  const [settingsError, setSettingsError] = useState("");
  const onUpdateSettings = useCallback(async (patch: ConversationSettingsPatch) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSavingSettings(true);
    setSettingsError("");
    try { await props.onUpdateSettings(patch); }
    catch (error) { setSettingsError(`设置未保存：${(error as Error).message}`); }
    finally { savingRef.current = false; setSavingSettings(false); }
  }, [props.onUpdateSettings]);

  const card = cards.find((c) => c.id === currentCardId) || cards[0] || null;
  const cardMessages = card ? messages[card.id] || [] : [];
  const cardDraft = card ? drafts[card.id] : undefined;

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
  const [catalogState, setCatalogState] = useState<{ key: string; data: ModelCatalog } | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  useEffect(() => {
    const handleRefresh = (event: Event) => {
      if ((event as CustomEvent<string>).detail === provider?.id) setRefreshVersion(v => v + 1);
    };
    window.addEventListener("kk-model-capabilities-refreshed", handleRefresh);
    return () => window.removeEventListener("kk-model-capabilities-refreshed", handleRefresh);
  }, [provider?.id]);
  const capabilityKey = `${provider?.id}:${provider?.config_version}:${provider?.api_base}:${conv.model}:${refreshVersion}`;
  const catalog = catalogState?.key === capabilityKey ? catalogState.data : null;
  const loadingCapabilities = !!provider && !catalog;
  useEffect(() => {
    if (!provider) return;
    const controller = new AbortController();
    api.getProviderModels(provider.id, conv.model, false, controller.signal)
      .then(data => { if (!controller.signal.aborted) setCatalogState({ key: capabilityKey, data }); })
      .catch(() => { if (!controller.signal.aborted) setCatalogState({ key: capabilityKey, data: {
        models: [conv.model], model: conv.model, reasoning: UNKNOWN_REASONING,
        contextWindow: provider?.capabilities?.context_window ?? 32000,
        inputModalities: ["text"], webSearch: false, forceSearch: false,
        warning: "读取模型能力失败，可在 Provider 设置中刷新重试。",
      } }); });
    return () => controller.abort();
  }, [capabilityKey]);
  // 独立搜索（Tavily）是全局开关：没有原生搜索的模型也有机会联网
  const [searchConfig, setSearchConfig] = useState<SearchConfig | null>(null);
  useEffect(() => {
    let alive = true;
    api.getSearch().then(cfg => { if (alive) setSearchConfig(cfg); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const availableModels = [...new Set([conv.model, ...(catalog?.models ?? provider?.capabilities.models ?? [])].filter(Boolean))];
  const reasoning = catalog?.reasoning ?? UNKNOWN_REASONING;
  const thinkMode = normalizeThinkMode(conv.think_mode);
  const options = reasoningOptions(reasoning);
  const invalidThinkMode = !loadingCapabilities && !options.includes(thinkMode);
  const settingsPending = savingSettings || (loadingCapabilities && thinkMode !== "default") || invalidThinkMode;
  // 联网可用性 = 模型原生搜索 或 已配置的独立搜索；强制联网还要接口支持 tool_choice 强约束
  const nativeWeb = catalog?.webSearch ?? false;
  const nativeForce = nativeWeb && !!catalog?.forceSearch;
  const tavilyReady = !!searchConfig?.enabled && !!searchConfig?.has_secret;
  const webAvailable = nativeWeb || tavilyReady;
  const forceAvailable = nativeForce || tavilyReady;
  const webTitle = !webAvailable
    ? "当前模型不支持原生联网，且未配置独立搜索（Tavily）"
    : nativeWeb
      ? `模型原生联网${nativeForce ? "，支持强制搜索" : "；无法强制，强制联网需依赖独立搜索（Tavily）"}`
      : "通过独立搜索（Tavily）联网，非模型原生能力";
  const controls = <>
    <label className="composer-setting" title={webTitle}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/></svg>
      <select aria-label="联网模式" value={webAvailable ? conv.web_mode : "off"} disabled={savingSettings || !webAvailable} onChange={e => onUpdateSettings({ web_mode: e.target.value as WebMode })}>
        {webAvailable ? (
          <>
            <option value="auto">{nativeWeb ? "自动联网" : "自动联网（Tavily）"}</option>
            <option value="force" disabled={!forceAvailable}>
              {!forceAvailable ? "强制联网（不支持）" : nativeWeb && catalog?.forceSearch ? "强制联网" : "强制联网（Tavily）"}
            </option>
            <option value="off">不联网</option>
          </>
        ) : (
          <option value="off">联网不可用</option>
        )}
      </select>
    </label>
    <label className="composer-setting" title={catalog?.warning || `${reasoning.mandatory ? "该模型始终开启推理。" : ""}${reasoning.detail}`}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6m-5 3h4M8 15c-5-4-2-12 4-12s9 8 4 12c-1 1-1 2-1 3H9c0-1 0-2-1-3Z"/></svg>
      <span>思考</span>
      <select aria-label="推理强度" value={thinkMode} disabled={savingSettings || loadingCapabilities || (options.length === 1 && !invalidThinkMode)} onChange={e => onUpdateSettings({ think_mode: e.target.value as ThinkMode })}>
        {(loadingCapabilities || invalidThinkMode) && thinkMode !== 'default' && <option value={thinkMode} disabled>{THINK_LABELS[thinkMode]}（待确认）</option>}
        {options.map(value => <option key={value} value={value}>{loadingCapabilities ? '读取中…' : THINK_LABELS[value]}</option>)}
      </select>
    </label>
  </>;
  const settingNote = settingsError || (invalidThinkMode ? '该模型不再支持原推理设置，请选择“模型默认”或其他可用档位后发送。' : catalog?.warning || (reasoning.source === 'unknown' && !loadingCapabilities ? reasoning.detail : ''));


  const handleTitleBlur = useCallback(
    (title: string) => {
      const t = title.trim();
      // 仅当用户实际改了标题且非空时才提交，避免失焦误触发覆盖已生成的标题
      if (t && t !== conv.title) onUpdateSettings({ title: t });
    },
    [conv, onUpdateSettings],
  );

  return (
    <div className={`workspace${assistantPresent ? " workspace--assistant" : ""}`}>
      <div className="ws-main">
        <div className="header">
          <div className="title-group">
            <input
              className="title-input"
              defaultValue={conv.title}
              key={`${conv.id}:${conv.title}`}
              onBlur={(e) => handleTitleBlur(e.target.value)}
              aria-label="会话名称"
            />
            <div className="toolbar">
              {locked ? (
                <div className="model-readonly" title="会话模型已锁定，首条消息后不可切换">
                  <span>{provider?.name || "模型服务"}</span><span className="model-separator">/</span>
                  <strong>{conv.model}</strong><Icon name="lock" />
                </div>
              ) : <div className="model-label">
            <select className="model-picker provider-picker" aria-label="会话 Provider" value={conv.provider_id} disabled={locked || savingSettings}
              title={locked ? "首条消息后不可切换 Provider" : "选择 Provider"}
              onChange={e => onUpdateSettings({ provider_id: e.target.value })}>
              {props.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            模型：
            <select
              className="model-picker"
              aria-label="会话模型"
              value={conv.model}
              disabled={locked || savingSettings}
              onChange={(e) => onUpdateSettings({ model: e.target.value })}
              title={locked ? "会话已锁定，首条消息后不可切换模型" : "选择模型"}
            >
              {(locked ? [conv.model] : availableModels).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
              </div>}
            </div>
          </div>
          {!props.assistantOpen && (
            <Button className="knowledge-btn" onClick={props.onToggleAssistant} icon="assistant" aria-label="会话知识助手">助手</Button>
          )}
        </div>
        <div className="ws-tabs" role="tablist" aria-label="会话内容 Tab">
          <button role="tab" aria-selected={props.activeTab === "chat"} className={props.activeTab === "chat" ? "ws-tab selected" : "ws-tab"} onClick={() => props.onSetTab("chat")}>对话卡片</button>
          <button role="tab" aria-selected={props.activeTab === "notes"} className={props.activeTab === "notes" ? "ws-tab selected" : "ws-tab"} onClick={() => props.onSetTab("notes")}>用户笔记</button>
        </div>
        <div className={`content${props.activeTab === "notes" ? " content--notes" : ""}`}>
          <div className="chat-pane" hidden={props.activeTab === "notes"}>
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
                    allMessages={messages}
                    draft={cardDraft}
                    anchors={anchors}
                    termLinks={termLinks}
                    activeRuns={activeRuns}
                    runStatuses={runStatuses}
                    onSendMessage={onSendMessage}
                    onCreateAnchor={onCreateAnchor}
                    onExplore={onExplore}
                    onExploreTerm={onExploreTerm}
                    onCleanStaleTermLinks={onCleanStaleTermLinks}
                    onStop={onStop}
                    onRetry={onRetry}
                    onSaveDraft={onSaveDraft}
                    onSelectCard={onSelectCard}
                    conv={conv}
                    provider={provider}
                    composerControls={controls}
                    settingsPending={settingsPending}
                    settingsNote={settingNote}
                    pendingScroll={props.pendingScroll}
                    onConsumedScroll={props.onConsumedScroll}
                  />
                ) : (
                  <div className="welcome">
                    <div className="welcome-symbol"><Icon name="leaf" /></div>
                    <p>开始你的第一次探索。</p>
                  </div>
                )}
              </div>
            </div>
            <TreePanel key={conv.id} cards={cards} currentCardId={card?.id || null} onSelect={onSelectCard} collapsed={assistantPresent} reference={reference} />
          </div>
          <div className="notes-pane" hidden={props.activeTab !== "notes"}>
            <NoteListGrid
              notes={props.notes}
              onNew={() => props.onNewNote("")}
              onOpen={props.onOpenNote}
              onDelete={props.onDeleteNote}
              onDeleteMany={props.onDeleteNotes}
            />
          </div>
        </div>
      </div>
      {props.assistantOpen && <div className="assistant-backdrop" onClick={props.onToggleAssistant} />}
      {assistantPresent && (
        <AssistantPanel
          closing={!props.assistantOpen}
          key={conv.id}
          conv={conv}
          provider={provider}
          messages={props.assistantMsgs}
          cards={cards}
          allMessages={messages}
          currentThreadId={props.currentThreadId}
          onSetCurrentThreadId={props.onSetCurrentThreadId}
          onClose={() => { props.onToggleAssistant(); loadConversationById(conv.id); }}
          onSendAssistant={(question, threadId, quote, scopeCardIds) => api.sendAssistant(conv.id, question, threadId, quote, scopeCardIds)}
          // 存为笔记：中间区域切到「用户笔记」tab，创建新笔记并打开编辑器弹窗
          onNewNote={(content) => { props.onSetTab("notes"); props.onNewNote(content); }}
          // 徽章点击：切到目标卡并滚动/高亮到证据指向的那条回答
          onGoToMessage={(cardId, messageId) => { props.onGoToMessage(cardId, messageId); }}
        />
      )}
      {props.previewCardId && (
        <CardPreviewDialog
          cardId={props.previewCardId}
          cards={cards}
          messages={messages}
          onClose={() => props.onPreviewCard(null)}
          onGoToCard={(id) => { props.onPreviewCard(null); props.onSetTab("chat"); onSelectCard(id); }}
        />
      )}
      {props.editingNote && (
        <NoteEditorDialog
          key={props.editingNote.editorKey}
          note={props.editingNote}
          onSave={props.onSaveNote}
          onDelete={props.onDeleteNote}
          onClose={props.onCloseNoteEditor}
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

// 卡片预览弹窗：从助手来源点击卡片时弹出，避免在卡片集群内直接打开造成遮挡
function CardPreviewDialog({ cardId, cards, messages, onClose, onGoToCard }: {
  cardId: string;
  cards: Card[];
  messages: Record<string, Message[]>;
  onClose: () => void;
  onGoToCard: (id: string) => void;
}) {
  const card = cards.find((c) => c.id === cardId);
  if (!card) return null;
  const msgs = messages[cardId] || [];
  return (
    <div className="card-preview-overlay" onClick={onClose}>
      <div className="card-preview-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="card-preview-top">
          <span>{card.title || "主卡片"}</span>
          <div className="card-preview-actions">
            <button className="card-preview-go" onClick={() => onGoToCard(card.id)} title="前往卡片所在集群">
              前往卡片 ↗
            </button>
            <IconButton onClick={onClose} icon="close" label="关闭预览" />
          </div>
        </div>
        <div className="card-preview-messages">
          {msgs.length === 0 && <div style={{ color: "var(--muted)", fontSize: 12, padding: 16 }}>此卡片暂无消息</div>}
          {msgs.map((m) =>
            m.role === "user" ? (
              <div className="msg-user-block" key={m.id}>
                <div className="msg-user">{m.content}</div>
              </div>
            ) : (
              <div key={m.id}>
                <div className="msg-answer-label"><span>✦</span> 回答</div>
                <div className="msg-answer" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content || "") }} />
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
