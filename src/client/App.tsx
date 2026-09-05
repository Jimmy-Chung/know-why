import React, { useEffect, useState, useCallback, useRef } from "react";
import type {
  ProviderConfig,
  Conversation,
  Card,
  Message,
  SelectionAnchor,
  KnowledgeAssistantMessage,
  Run,
  Source,
  WebMode,
  ThinkMode,
} from "../shared/types.js";
import { api } from "./api.js";
import { Sidebar } from "./components/Sidebar.js";
import { Workspace } from "./components/Workspace.js";
import { SettingsModal } from "./components/SettingsModal.js";

export default function App() {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [drafts, setDrafts] = useState<Record<string, { text: string; pending_quote_anchor_id: string | null }>>({});
  const [anchors, setAnchors] = useState<SelectionAnchor[]>([]);
  const [assistantMsgs, setAssistantMsgs] = useState<KnowledgeAssistantMessage[]>([]);
  const [currentCardId, setCurrentCardId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [activeRuns, setActiveRuns] = useState<Set<string>>(new Set());

  // 加载 providers
  const loadProviders = useCallback(async () => {
    setProviders(await api.listProviders());
  }, []);

  // 加载会话列表
  const loadConversations = useCallback(async () => {
    setConversations(await api.listConversations());
  }, []);

  useEffect(() => {
    (async () => {
      await loadProviders();
      await loadConversations();
    })();
  }, [loadProviders, loadConversations]);

  // 加载当前会话详情
  const loadConversation = useCallback(async (id: string) => {
    const d = await api.getConversation(id);
    setCards(d.cards);
    setMessages(d.messages);
    setDrafts(d.drafts);
    setAnchors(d.anchors);
    setAssistantMsgs(d.assistant);
    setCurrentCardId(d.view?.current_card_id || d.cards[0]?.id || null);
  }, []);

  useEffect(() => {
    if (currentId) loadConversation(currentId);
  }, [currentId, loadConversation]);

  // 监听助手回答完成后的刷新请求
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent).detail as string;
      if (id) loadConversation(id);
    };
    window.addEventListener("kk-reload-conversation", handler);
    return () => window.removeEventListener("kk-reload-conversation", handler);
  }, [loadConversation]);

  const currentConv = conversations.find((c) => c.id === currentId) || null;
  const currentProvider = providers.find((p) => p.id === currentConv?.provider_id) || null;

  // 更新某卡片消息（流式增量用）
  const updateCardMessages = useCallback((cardId: string, fn: (msgs: Message[]) => Message[]) => {
    setMessages((prev) => ({ ...prev, [cardId]: fn(prev[cardId] || []) }));
  }, []);

  // 订阅 run SSE
  const subscribeRun = useCallback(
    (runId: string, cardId: string) => {
      setActiveRuns((s) => new Set(s).add(runId));
      return api.streamRun(
        runId,
        (e) => {
          if (e.type === "message") {
            updateCardMessages(cardId, (msgs) => [...msgs, e.message]);
          } else if (e.type === "delta") {
            updateCardMessages(cardId, (msgs) =>
              msgs.map((m) => (m.id === e.message_id ? { ...m, content: m.content + e.text } : m)),
            );
          } else if (e.type === "done") {
            updateCardMessages(cardId, (msgs) => msgs.map((m) => (m.id === e.message.id ? e.message : m)));
            setActiveRuns((s) => {
              const n = new Set(s);
              n.delete(runId);
              return n;
            });
            // 刷新会话以同步锁定等状态
            if (currentId) loadConversation(currentId);
          } else if (e.type === "error") {
            if (e.run?.message_id) {
              updateCardMessages(cardId, (msgs) =>
                msgs.map((m) => (m.id === e.run!.message_id ? { ...m, status: "failed", error: e.message } : m)),
              );
            }
            setActiveRuns((s) => {
              const n = new Set(s);
              n.delete(runId);
              return n;
            });
          } else if (e.type === "sources") {
            // 来源暂存到 run，刷新会话获取
          }
        },
        () => {
          if (currentId) loadConversation(currentId);
        },
      );
    },
    [updateCardMessages, currentId, loadConversation],
  );

  const handleNewConversation = useCallback(async () => {
    if (!providers.length) {
      setShowSettings(true);
      return;
    }
    const r = await api.createConversation();
    await loadConversations();
    setCurrentId(r.conversation.id);
  }, [providers, loadConversations]);

  const handleSelectConversation = useCallback((id: string) => {
    setCurrentId(id);
    setAssistantOpen(false);
  }, []);

  const handleSendMessage = useCallback(
    async (cardId: string, content: string, quoteAnchorId?: string | null) => {
      if (!content.trim()) return;
      const r = await api.sendMessage(cardId, { content, quote_anchor_id: quoteAnchorId });
      // 立即显示用户消息
      updateCardMessages(cardId, (msgs) => [...msgs, r.userMessage]);
      subscribeRun(r.run.id, cardId);
    },
    [subscribeRun, updateCardMessages],
  );

  const handleCreateAnchor = useCallback(async (messageId: string, selectedText: string, start: number, end: number): Promise<SelectionAnchor | null> => {
    if (!currentId) return null;
    try {
      return await api.createAnchor(currentId, { source_message_id: messageId, selected_text: selectedText, start_offset: start, end_offset: end });
    } catch {
      return null;
    }
  }, [currentId]);

  const handleExplore = useCallback(async (anchorId: string) => {
    if (!currentId) return;
    const r = await api.explore(currentId, anchorId);
    setCards((prev) => (prev.some((c) => c.id === r.card.id) ? prev : [...prev, r.card]));
    setCurrentCardId(r.card.id);
    await loadConversation(currentId);
    subscribeRun(r.run.id, r.card.id);
  }, [currentId, loadConversation, subscribeRun]);

  const handleStop = useCallback(async (runId: string) => {
    await api.stopRun(runId);
  }, []);

  const handleRetry = useCallback(async (runId: string, cardId: string) => {
    const r = await api.retryRun(runId);
    if (r.run) subscribeRun(r.run.id, cardId);
  }, [subscribeRun]);

  const handleSaveDraft = useCallback(async (cardId: string, text: string, quoteAnchorId: string | null) => {
    api.saveDraft(cardId, text, quoteAnchorId).catch(() => {});
  }, []);

  const handleUpdateConvSettings = useCallback(async (patch: { web_mode?: WebMode; think_mode?: ThinkMode; title?: string; model?: string }) => {
    if (!currentId) return;
    await api.updateConversation(currentId, patch);
    setConversations((prev) => prev.map((c) => (c.id === currentId ? { ...c, ...patch } : c)));
  }, [currentId]);

  const handleDeleteConversation = useCallback(async (id: string) => {
    await api.deleteConversation(id);
    await loadConversations();
    if (currentId === id) setCurrentId(null);
  }, [loadConversations, currentId]);

  const handleSaveViewState = useCallback((cardId: string | null) => {
    if (!currentId) return;
    setCurrentCardId(cardId);
    api.saveViewState(currentId, cardId, 0).catch(() => {});
  }, [currentId]);

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        currentId={currentId}
        providers={providers}
        onNew={handleNewConversation}
        onSelect={handleSelectConversation}
        onDelete={handleDeleteConversation}
        onOpenSettings={() => setShowSettings(true)}
        onRenamed={loadConversations}
      />
      {currentConv ? (
        <Workspace
          conv={currentConv}
          provider={currentProvider}
          providers={providers}
          cards={cards}
          messages={messages}
          drafts={drafts}
          anchors={anchors}
          assistantMsgs={assistantMsgs}
          currentCardId={currentCardId}
          assistantOpen={assistantOpen}
          activeRuns={activeRuns}
          onSelectCard={handleSaveViewState}
          onSendMessage={handleSendMessage}
          onCreateAnchor={handleCreateAnchor}
          onExplore={handleExplore}
          onStop={handleStop}
          onRetry={handleRetry}
          onSaveDraft={handleSaveDraft}
          onUpdateSettings={handleUpdateConvSettings}
          onToggleAssistant={() => setAssistantOpen((v) => !v)}
        />
      ) : (
        <div className="workspace">
          <div className="empty-state">
            <p>选择或新建一个会话开始探索。</p>
            <button onClick={handleNewConversation}>新建会话</button>
          </div>
        </div>
      )}
      {showSettings && (
        <SettingsModal
          providers={providers}
          onClose={() => setShowSettings(false)}
          onSaved={async () => {
            await loadProviders();
            await loadConversations();
          }}
        />
      )}
    </div>
  );
}
