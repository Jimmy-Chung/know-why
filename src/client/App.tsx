import { IconButton } from "./components/ui/Button.js";
import type { ConversationSettingsPatch } from "../shared/types.js";
import React, { useEffect, useState, useCallback, useRef } from "react";
import type {
  ProviderConfig,
  Conversation,
  Card,
  Message,
  SelectionAnchor,
  TermLink,
  KnowledgeAssistantMessage,
  Run,
  Source,
  Attachment,
  NoteCard,
} from "../shared/types.js";
import { api } from "./api.js";
import { Sidebar } from "./components/Sidebar.js";
import { Workspace } from "./components/Workspace.js";
import type { NoteEditorTarget } from "./components/Notes.js";
import { SettingsModal } from "./components/SettingsModal.js";

import { usePanelPresence } from "./usePanelPresence.js";

export default function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.matchMedia("(max-width: 700px)").matches);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  const loadedConversationRef = useRef<string | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [drafts, setDrafts] = useState<Record<string, { text: string; pending_quote_anchor_id: string | null }>>({});
  const [anchors, setAnchors] = useState<SelectionAnchor[]>([]);
  const [termLinks, setTermLinks] = useState<TermLink[]>([]);
  const [assistantMsgs, setAssistantMsgs] = useState<KnowledgeAssistantMessage[]>([]);
  const [notes, setNotes] = useState<NoteCard[]>([]);
  // 笔记编辑器会话态：id 为 null 表示新建（尚未落库），title/content 为预填与编辑值；
  // editorKey 供弹窗作为稳定 key，落库拿到 id 后不重挂载、不丢光标
  const noteKeyRef = useRef(0);
  const nextNoteKey = useCallback(() => ++noteKeyRef.current, []);
  const [editingNote, setEditingNote] = useState<NoteEditorTarget | null>(null);
  const [activeTab, setActiveTab] = useState<"chat" | "notes">("chat");
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  const [currentCardId, setCurrentCardId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const settingsPresent = usePanelPresence(showSettings);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [previewCardId, setPreviewCardId] = useState<string | null>(null);
  // 助手引用跳转：切卡后滚动并高亮到该回答消息
  const [pendingScroll, setPendingScroll] = useState<{ cardId: string; messageId: string } | null>(null);
  const [activeRuns, setActiveRuns] = useState<Set<string>>(new Set());
  // run 中间态文本：runId → 状态描述（如"正在搜索…""思考中…"）
  const [runStatuses, setRunStatuses] = useState<Record<string, string>>({});

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
    if (currentIdRef.current !== id) return;
    setCards(d.cards);
    setMessages(d.messages);
    setDrafts(d.drafts);
    setAnchors(d.anchors);
    setTermLinks(d.termLinks);
    setAssistantMsgs(d.assistant);
    setNotes(d.notes);
    // Refreshing a completed run must not switch the user back to another assistant thread.
    if (loadedConversationRef.current !== id) {
      const latest = d.assistant[d.assistant.length - 1];
      setCurrentThreadId(latest?.thread_id ?? null);
      loadedConversationRef.current = id;
    }
    setCurrentCardId(d.view?.current_card_id || d.cards[0]?.id || null);
    // 同步会话标题到列表（如 LLM 自动生成的标题），避免 sidebar 显示旧标题
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title: d.conversation.title, updated_at: d.conversation.updated_at } : c)),
    );
  }, []);

  useEffect(() => {
    if (currentId) loadConversation(currentId);
  }, [currentId, loadConversation]);

  // 监听助手回答完成后的刷新请求
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent).detail as string;
      if (id && id === currentIdRef.current) loadConversation(id);
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
            // 停止/异常时后端可能 emit message: null，防御性检查避免访问 undefined.id 崩溃
            if (e.message) {
              updateCardMessages(cardId, (msgs) => msgs.map((m) => (m.id === e.message!.id ? e.message! : m)));
            }
            setActiveRuns((s) => {
              const n = new Set(s);
              n.delete(runId);
              return n;
            });
            setRunStatuses((s) => {
              if (!(runId in s)) return s;
              const n = { ...s };
              delete n[runId];
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
            setRunStatuses((s) => {
              if (!(runId in s)) return s;
              const n = { ...s };
              delete n[runId];
              return n;
            });
            setActiveRuns((s) => {
              const n = new Set(s);
              n.delete(runId);
              return n;
            });
          } else if (e.type === "sources") {
            // 来源暂存到 run，刷新会话获取
          } else if (e.type === "searching") {
            setRunStatuses((s) => ({ ...s, [runId]: `正在搜索（${e.service}）……` }));
          } else if (e.type === "reading") {
            setRunStatuses((s) => ({ ...s, [runId]: `正在阅读 ${new URL(e.url).hostname}……` }));
          } else if (e.type === "thinking") {
            setRunStatuses((s) => ({ ...s, [runId]: "思考中……" }));
          } else if (e.type === "status") {
            if (e.detail) setRunStatuses((s) => ({ ...s, [runId]: e.detail! }));
          } else if (e.type === "summary") {
            setRunStatuses((s) => ({ ...s, [runId]: e.detail }));
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
    // 新建会话是一次上下文切换：收起右侧助手，否则旧面板会盖在新会话上，
    // 看起来像「点了没反应」。
    setAssistantOpen(false);
    setActiveTab("chat");
    setEditingNote(null);
    setCurrentId(r.conversation.id);
  }, [providers, loadConversations]);

  const handleSelectConversation = useCallback((id: string) => {
    setCurrentId(id);
    setAssistantOpen(false);
    setActiveTab("chat");
    setEditingNote(null);
  }, []);

  // ---- 用户笔记卡片 ----
  const handleSaveNote = useCallback(async (edit: { id: string | null; title: string; content: string }) => {
    if (!currentId) return;
    const title = edit.title.trim();
    const content = edit.content;
    if (!title && !content.trim()) return; // 空笔记不落库
    if (edit.id === null) {
      const note = await api.createNote(currentId, { title, content_markdown: content });
      setNotes((prev) => [note, ...prev]);
      setEditingNote((prev) => (prev ? { ...prev, id: note.id, title, content } : prev));
    } else {
      const note = await api.updateNote(edit.id, { title, content_markdown: content });
      setNotes((prev) => prev.map((n) => (n.id === note.id ? note : n)));
    }
  }, [currentId]);

  const handleDeleteNote = useCallback(async (id: string) => {
    await api.deleteNote(id);
    setNotes((prev) => prev.filter((n) => n.id !== id));
    setEditingNote((prev) => (prev?.id === id ? null : prev));
  }, []);

  const handleDeleteNotes = useCallback(async (ids: string[]) => {
    if (!ids.length) return;
    await api.deleteNotes(ids);
    setNotes((prev) => prev.filter((n) => !ids.includes(n.id)));
    setEditingNote((prev) => (prev && prev.id && ids.includes(prev.id) ? null : prev));
  }, []);

  const handleNewNote = useCallback((content: string) => {
    setEditingNote({ id: null, title: "", content, editorKey: nextNoteKey() });
  }, [nextNoteKey]);

  const handleOpenNote = useCallback((note: NoteCard) => {
    setEditingNote({ id: note.id, title: note.title, content: note.content_markdown, editorKey: nextNoteKey() });
  }, [nextNoteKey]);

  const handleSendMessage = useCallback(
    async (cardId: string, content: string, quoteAnchorId?: string | null, attachments?: Attachment[]) => {
      if (!content.trim() && !(attachments && attachments.length)) return;
      const r = await api.sendMessage(cardId, { content, quote_anchor_id: quoteAnchorId, attachments });
      // 立即显示用户消息
      updateCardMessages(cardId, (msgs) => [...msgs, r.userMessage]);
      subscribeRun(r.run.id, cardId);
    },
    [subscribeRun, updateCardMessages],
  );

  const handleCreateAnchor = useCallback(async (messageId: string, selectedText: string, start: number, end: number): Promise<SelectionAnchor | null> => {
    if (!currentId) return null;
    try {
      const anchor = await api.createAnchor(currentId, { source_message_id: messageId, selected_text: selectedText, start_offset: start, end_offset: end });
      // 即时并入 anchors 状态：发送回显的引用块（QuoteBlock）依赖 anchors 查找，
      // 若等 loadConversation 全量同步，发送出去的消息会暂时缺一个引用展示
      setAnchors((prev) => (prev.some((x) => x.id === anchor.id) ? prev : [...prev, anchor]));
      return anchor;
    } catch {
      return null;
    }
  }, [currentId]);

  const handleExplore = useCallback(async (anchorId: string) => {
    if (!currentId) return;
    const r = await api.explore(currentId, anchorId);
    setCards((prev) => (prev.some((c) => c.id === r.card.id) ? prev : [...prev, r.card]));
    // 探索：新卡片直接覆盖到前景。先持久化当前视图为新卡片，再加载会话，
    // 避免 loadConversation 用旧 view state 把当前卡片重置回父卡片。
    await api.saveViewState(currentId, r.card.id, 0);
    await loadConversation(currentId);
    setCurrentCardId(r.card.id);
    if (r.run) subscribeRun(r.run.id, r.card.id);
  }, [currentId, loadConversation, subscribeRun]);

  // Shift+点击：从当前出处建独立新探索；首次 target 由服务端 term_link 保持稳定
  const handleExploreTerm = useCallback(
    async (src: { message_id: string; card_id: string; selected_text: string; start_offset: number; end_offset: number }) => {
      if (!currentId) return;
      try {
        const r = await api.exploreTerm(currentId, src);
        setCards((prev) => (prev.some((c) => c.id === r.card.id) ? prev : [...prev, r.card]));
        // 即时并入 termLink，标注能在 loadConversation 完成前就渲染
        setTermLinks((prev) => (prev.some((t) => t.id === r.termLink.id) ? prev.map((t) => (t.id === r.termLink.id ? r.termLink : t)) : [...prev, r.termLink]));
        // 新卡片直接覆盖到前景；先持久化视图再加载会话，避免被旧 view state 重置回父卡片
        await api.saveViewState(currentId, r.card.id, 0);
        await loadConversation(currentId);
        setCurrentCardId(r.card.id);
        if (r.run) subscribeRun(r.run.id, r.card.id);
      } catch (e) {
        console.error("explore-term 失败", e);
      }
    },
    [currentId, loadConversation, subscribeRun],
  );

  // 失效处理：首次探索卡被删时清理失效的 term_link，并同步状态
  const handleCleanStaleTermLinks = useCallback(async () => {
    if (!currentId) return;
    try {
      const r = await api.deleteStaleTermLinks(currentId);
      if (r.deleted > 0) setTermLinks((prev) => prev.filter((t) => cards.some((c) => c.id === t.first_card_id)));
    } catch {
      /* ignore */
    }
  }, [currentId, cards]);

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

  const handleUpdateConvSettings = useCallback(async (patch: ConversationSettingsPatch) => {
    if (!currentId) return;
    const updated = await api.updateConversation(currentId, patch);
    setConversations((prev) => prev.map((c) => (c.id === currentId ? updated : c)));
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

  // 助手引用角标点击：切到目标卡（若非当前卡），并登记待滚动到的那条消息
  const handleGoToMessage = useCallback((cardId: string, messageId: string) => {
    setPreviewCardId(null);
    setActiveTab("chat");
    if (currentCardId !== cardId) setCurrentCardId(cardId);
    setPendingScroll({ cardId, messageId });
  }, [currentCardId]);

  return (
    <div className={`app${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <IconButton className="navigation-toggle" icon="panel" label={sidebarCollapsed ? "展开会话导航" : "收起会话导航"} aria-expanded={!sidebarCollapsed} aria-controls="session-navigation" onClick={() => setSidebarCollapsed(v => !v)} />
      <div className="navigation-backdrop" onClick={() => setSidebarCollapsed(true)} />

      <Sidebar
        collapsed={sidebarCollapsed}
        conversations={conversations}
        currentId={currentId}
        providers={providers}
        onNew={() => { handleNewConversation(); if (window.matchMedia("(max-width: 700px)").matches) setSidebarCollapsed(true); }}
        onSelect={(id) => { handleSelectConversation(id); if (window.matchMedia("(max-width: 700px)").matches) setSidebarCollapsed(true); }}
        onDelete={handleDeleteConversation}
        onOpenSettings={() => setShowSettings(true)}
        onRenamed={loadConversations}
      />
      {currentConv ? (
        <Workspace
          key={currentConv.id}
          conv={currentConv}
          provider={currentProvider}
          providers={providers}
          cards={cards}
          messages={messages}
          drafts={drafts}
          anchors={anchors}
          termLinks={termLinks}
          assistantMsgs={assistantMsgs}
          notes={notes}
          activeTab={activeTab}
          onSetTab={setActiveTab}
          editingNote={editingNote}
          onNewNote={handleNewNote}
          onOpenNote={handleOpenNote}
          onSaveNote={handleSaveNote}
          onDeleteNote={handleDeleteNote}
          onDeleteNotes={handleDeleteNotes}
          onCloseNoteEditor={() => setEditingNote(null)}
          currentCardId={currentCardId}
          currentThreadId={currentThreadId}
          assistantOpen={assistantOpen}
          onSetCurrentThreadId={setCurrentThreadId}
          activeRuns={activeRuns}
          runStatuses={runStatuses}
          onSelectCard={handleSaveViewState}
          onSendMessage={handleSendMessage}
          onCreateAnchor={handleCreateAnchor}
          onExplore={handleExplore}
          onExploreTerm={handleExploreTerm}
          onCleanStaleTermLinks={handleCleanStaleTermLinks}
          onStop={handleStop}
          onRetry={handleRetry}
          onSaveDraft={handleSaveDraft}
          onUpdateSettings={handleUpdateConvSettings}
          onToggleAssistant={() => setAssistantOpen((v) => !v)}
          previewCardId={previewCardId}
          onPreviewCard={setPreviewCardId}
          pendingScroll={pendingScroll}
          onGoToMessage={handleGoToMessage}
          onConsumedScroll={() => setPendingScroll(null)}
        />
      ) : (
        <div className="workspace">
          <div className="empty-state">
            <p>选择或新建一个会话开始探索。</p>
            <button onClick={handleNewConversation}>新建会话</button>
          </div>
        </div>
      )}
      {settingsPresent && (
        <SettingsModal
          closing={!showSettings}
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
