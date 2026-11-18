import { Icon } from "./ui/Icon.js";
import { Button, IconButton } from "./ui/Button.js";
import { Tooltip } from "./ui/Tooltip.js";
import React, { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { renderMarkdown, markdownToPlainText } from "../markdown.js";
import { CopyButton } from "./ui/CopyButton.js";
import type { Card, Message, SelectionAnchor, TermLink, Conversation, ProviderConfig, Attachment, Source } from "../../shared/types.js";
import { api } from "../api.js";
import { findTermMatches, termKey } from "../../shared/term-key.js";
import type { SelectCard } from "../tree-reference.js";

interface CardPileProps {
  path: Card[]; // 祖先路径，最后一个是当前卡片
  cards: Card[];
  currentCard: Card;
  messages: Message[];
  allMessages: Record<string, Message[]>; // 所有卡片消息，供背景层渲染内容
  draft?: { text: string; pending_quote_anchor_id: string | null };
  anchors: SelectionAnchor[];
  termLinks: TermLink[];
  activeRuns: Set<string>;
  runStatuses: Record<string, string>;
  conv: Conversation;
  provider: ProviderConfig | null;
  composerControls?: React.ReactNode;
  settingsPending?: boolean;
  settingsNote?: string;
  onSendMessage: (cardId: string, content: string, quoteAnchorId?: string | null, attachments?: Attachment[]) => void;
  onCreateAnchor: (messageId: string, selectedText: string, start: number, end: number) => Promise<SelectionAnchor | null>;
  onExplore: (anchorId: string) => void;
  onExploreTerm: (src: { message_id: string; card_id: string; selected_text: string; start_offset: number; end_offset: number }) => void;
  onCleanStaleTermLinks: () => void;
  onStop: (runId: string) => void;
  onRetry: (runId: string, cardId: string) => void;
  onSaveDraft: (cardId: string, text: string, quoteAnchorId: string | null) => void;
  onSelectCard: SelectCard;
  pendingScroll?: { cardId: string; messageId: string } | null;
  onConsumedScroll?: () => void;
}
// 层叠卡片：前景水平，背景逐层逆时针旋转+模糊
// 切换卡片时：旧卡片向左旋转 + 虚化退场（card-exit），新卡片叠到上面（foreground pile-in）
export function CardPile(props: CardPileProps) {
  const { path, currentCard, messages, allMessages, draft, anchors, termLinks, conv, provider, onSendMessage, onCreateAnchor, onExplore, onExploreTerm, onCleanStaleTermLinks, onStop, onRetry, onSaveDraft, onSelectCard, runStatuses } = props;
  // 背景卡片 = 祖先路径中除当前卡片外的，最多绘制 4 层
  // 背景只保留卡片轮廓及轻量内容线条，不复制原文、不接收输入。
  const backCards = path.slice(0, -1).slice(-4);

  // 切换卡片时，把旧卡片短暂渲染为「退出层」做退场动画
  const [exiting, setExiting] = useState<{ card: Card; msgs: Message[] } | null>(null);
  const prevCardRef = useRef<Card>(currentCard);
  useEffect(() => {
    if (prevCardRef.current.id !== currentCard.id) {
      const oldCard = prevCardRef.current;
      setExiting({ card: oldCard, msgs: allMessages[oldCard.id] || [] });
      prevCardRef.current = currentCard;
      const t = setTimeout(() => setExiting(null), 560);
      return () => clearTimeout(t);
    }
    prevCardRef.current = currentCard;
  }, [currentCard.id, allMessages]);

  // 每张卡片各自的阅读位置：切走时记录，切回时恢复（刷新丢失可接受，同会话内保持）
  const cardScrolls = useRef<Map<string, number>>(new Map());
  const stickScroll = useCallback((cardId: string, top: number) => {
    cardScrolls.current.set(cardId, top);
  }, []);

  return (
    <div className="pile-stage">
      {backCards.map((c, i) => {
        const depth = backCards.length - i; // 1=最近一层，越大越远
        const rotation = -4.5 * depth;
        // 旋转会放大水平投影（宽×cosθ + 高×sinθ），用 scale 把投影收回容器内，
        // 防止背景卡片溢出遮挡左右面板
        const scale = 1 - depth * 0.04;
        const blur = Math.min(2, depth * 0.5);
        const opacity = Math.max(0.3, 1 - depth * 0.18);
        return (
          <div
            key={c.id}
            className="ghost-card"
            aria-hidden="true"
            style={{
              ["--rot" as string]: `${rotation}deg`,
              ["--scl" as string]: scale,
              ["--blur" as string]: `${blur}px`,
              ["--op" as string]: opacity,
              zIndex: i + 1,
            }}
          >
            <div className="card-top">
              <span>{c.title || "主卡片"}</span>
              <span>{c.parent_card_id ? "探索分支" : "主卡片"}</span>
            </div>
            <div className="ghost-content">{Array.from({ length: 7 }, (_, line) => <i key={line} />)}</div>
            <div className="card-composer" />
          </div>
        );
      })}
      {exiting && (
        <div className="card-exit" aria-hidden="true" style={{ zIndex: 9 }}>
          <div className="card-top">
            <span>{exiting.card.title || "主卡片"}</span>
            <span>{exiting.card.parent_card_id ? "探索分支" : "主卡片"}</span>
          </div>
          <div className="card-messages">
            {exiting.msgs.map((m) =>
              m.role === "user" ? (
                <div className="msg-user" key={m.id}>{m.content}</div>
              ) : (
                <div key={m.id}>
                  <div className="msg-answer-label"><span><Icon name="assistant" /></span> 回答</div>
                  <div className="msg-answer">{m.plaintext || m.content}</div>
                </div>
              ),
            )}
          </div>
        </div>
      )}
      <div key={currentCard.id} className="foreground-card" style={{ zIndex: 10 }}>
        <CardFace
          card={currentCard}
          messages={messages}
          draft={draft}
          anchors={anchors}
          termLinks={termLinks}
          conv={conv}
          provider={provider}
          composerControls={props.composerControls}
          settingsPending={props.settingsPending}
          settingsNote={props.settingsNote}
          onSendMessage={onSendMessage}
          onCreateAnchor={onCreateAnchor}
          onExplore={onExplore}
          onExploreTerm={onExploreTerm}
          onCleanStaleTermLinks={onCleanStaleTermLinks}
          onStop={onStop}
          onRetry={onRetry}
          onSaveDraft={onSaveDraft}
          onSelectCard={onSelectCard}
          runStatuses={runStatuses}
          activeRuns={props.activeRuns}
          savedScrollTop={cardScrolls.current.get(currentCard.id) ?? null}
          onStickScroll={stickScroll}
          pendingScroll={props.pendingScroll}
          onConsumedScroll={props.onConsumedScroll}
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
  termLinks: TermLink[];
  conv: Conversation;
  provider: ProviderConfig | null;
  composerControls?: React.ReactNode;
  settingsPending?: boolean;
  settingsNote?: string;
  activeRuns: Set<string>;
  runStatuses: Record<string, string>;
  onSendMessage: (cardId: string, content: string, quoteAnchorId?: string | null, attachments?: Attachment[]) => void;
  onCreateAnchor: (messageId: string, selectedText: string, start: number, end: number) => Promise<SelectionAnchor | null>;
  onExplore: (anchorId: string) => void;
  onExploreTerm: (src: { message_id: string; card_id: string; selected_text: string; start_offset: number; end_offset: number }) => void;
  onCleanStaleTermLinks: () => void;
  onStop: (runId: string) => void;
  onRetry: (runId: string, cardId: string) => void;
  onSaveDraft: (cardId: string, text: string, quoteAnchorId: string | null) => void;
  onSelectCard: SelectCard;
  // 切卡后恢复的原阅读位置（null 表示该卡无记录）
  savedScrollTop?: number | null;
  // 滚动时上报当前位置（供切卡时保存）
  onStickScroll?: (cardId: string, top: number) => void;
  // 助手引用跳转：切到目标卡后滚动并高亮到这条消息
  pendingScroll?: { cardId: string; messageId: string } | null;
  onConsumedScroll?: () => void;
}) {
  const { card, messages, draft, anchors, termLinks, conv, onSendMessage, onCreateAnchor, onExplore, onExploreTerm, onCleanStaleTermLinks, onStop, onRetry, onSaveDraft, activeRuns, onSelectCard, runStatuses } = props;
  const [input, setInput] = useState(draft?.text || "");
  const [pendingQuote, setPendingQuote] = useState<SelectionAnchor | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const messageContentRef = useRef<HTMLDivElement>(null);
  const followBottomRef = useRef(props.savedScrollTop == null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const updateScrollState = useCallback(() => {
    const el = messagesRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 32;
    followBottomRef.current = atBottom;
    setShowScrollBottom(!atBottom);
    props.onStickScroll?.(card.id, el.scrollTop);
  }, [card.id, props.onStickScroll]);
  const scrollToBottom = useCallback(() => {
    const el = messagesRef.current;
    if (!el) return;
    followBottomRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
    updateScrollState();
  }, [updateScrollState]);
  const [selection, setSelection] = useState<{ messageId: string; text: string; start: number; end: number; rect: DOMRect } | null>(null);

  // 同步草稿
  useEffect(() => {
    setInput(draft?.text || "");
    setAttachments([]);
    if (draft?.pending_quote_anchor_id) {
      // 从 anchors 找
      const a = anchors.find((x) => x.id === draft.pending_quote_anchor_id);
      if (a) setPendingQuote(a);
    } else {
      setPendingQuote(null);
    }
  }, [card.id]); // eslint-disable-line

  // 恢复原阅读位置（切卡后）：卡片以 key 重建，滚动归零，须补偿
  useLayoutEffect(() => {
    const el = messagesRef.current;
    if (el && props.savedScrollTop != null) el.scrollTop = props.savedScrollTop;
    if (props.savedScrollTop != null) updateScrollState();
  }, [card.id]); // eslint-disable-line

  // 滚动到指定消息并高亮：特性1（助手引用跳转）与特性2（轮次索引）共用。
  // highlight=true 时给目标加 .msg-flash 触发高亮动画。
  const scrollToMessage = useCallback((messageId: string, highlight: boolean) => {
    const el = messagesRef.current;
    if (!el) return;
    const target = el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (!target) return;
    followBottomRef.current = false;
    el.scrollTo({ top: target.offsetTop - 80, behavior: "instant" as ScrollBehavior });
    updateScrollState();
    if (highlight) {
      target.classList.remove("msg-flash");
      // 强制重排以重启动画
      void target.offsetWidth;
      target.classList.add("msg-flash");
    }
  }, [updateScrollState]);

  // 助手引用跳转：pendingScroll 命中当前卡时，滚动+高亮到目标消息并消费。
  useEffect(() => {
    const ps = props.pendingScroll;
    if (!ps || ps.cardId !== card.id) return;
    // 消息 DOM 可能要等一帧才挂载
    const raf = requestAnimationFrame(() => {
      scrollToMessage(ps.messageId, true);
      props.onConsumedScroll?.();
    });
    return () => cancelAnimationFrame(raf);
  }, [props.pendingScroll, card.id, scrollToMessage, props.onConsumedScroll]); // eslint-disable-line

  // Use the state BEFORE content grows; a large streamed chunk can exceed the bottom threshold.
  useLayoutEffect(() => {
    if (followBottomRef.current) scrollToBottom();
    else updateScrollState();
  }, [messages, scrollToBottom, updateScrollState]);
  useEffect(() => {
    const el = messagesRef.current, content = messageContentRef.current;
    if (!el || !content) return;
    const observer = new ResizeObserver(() => {
      if (followBottomRef.current) scrollToBottom();
      else updateScrollState();
    });
    observer.observe(el);
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollToBottom, updateScrollState]);

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

  const handlePickFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || !files.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        const att = await api.uploadAttachment(conv.id, f);
        setAttachments((prev) => [...prev, { id: att.id, name: att.name, mime: att.mime, size: att.size }]);
      }
    } catch (err) {
      console.error("附件上传失败", err);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [conv.id]);

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handleSend = useCallback(() => {
    if (props.settingsPending || (!input.trim() && !pendingQuote && attachments.length === 0)) return;
    scrollToBottom();
    onSendMessage(card.id, input, pendingQuote?.id || null, attachments);
    setInput("");
    setPendingQuote(null);
    setAttachments([]);
    onSaveDraft(card.id, "", null);
  }, [input, pendingQuote, attachments, card.id, onSendMessage, onSaveDraft, props.settingsPending, scrollToBottom]);

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
      <div className="card-messages-region">
      <RoundRail messages={messages} onJump={(id) => scrollToMessage(id, false)} />
      <div
        className="card-messages"
        ref={messagesRef}
        onMouseUp={handleSelection}
        onKeyUp={handleSelection}
        onScroll={updateScrollState}
      >
        <div className="card-message-content" ref={messageContentRef}>
        {messages.length === 0 && (
          <div className="welcome">
            <div className="welcome-symbol"><Icon name="leaf" /></div>
            <p>提出你的问题，开始这段探索。</p>
          </div>
        )}
        {messages.map((m) => (
          <MessageView
            key={m.id}
            message={m}
            anchors={anchors.filter((a) => a.source_message_id === m.id)}
            allAnchors={anchors}
            termLinks={termLinks}
            currentCardId={card.id}
            onExplore={onExplore}
            onExploreTerm={onExploreTerm}
            onCleanStaleTermLinks={onCleanStaleTermLinks}
            onRetry={onRetry}
            onStop={onStop}
            conv={conv}
            onSelectCard={onSelectCard}
            runStatus={m.run_id ? runStatuses[m.run_id] : undefined}
          />
        ))}
        </div>
      </div>
      {showScrollBottom && <IconButton className="card-scroll-bottom" icon="arrowDown" label="回到底部" onClick={scrollToBottom} />}
      </div>
      <div className="card-composer">
        {pendingQuote && (
          <div className="composer-quote" role="group" aria-label="已引用的原文，随问题一并发送">
            <p className="composer-quote-text" title={pendingQuote.selected_text}>{pendingQuote.selected_text}</p>
            <IconButton onClick={handleRemoveQuote} icon="close" label="移除引用" className="composer-quote-remove" />
          </div>
        )}
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((a) => (
              <div className="composer-attachment-chip" key={a.id} title={a.name}>
                <span className="chip-name"><Icon name="attachment" /> {a.name}</span>
                <IconButton onClick={() => handleRemoveAttachment(a.id)} icon="close" label="移除附件" />
              </div>
            ))}
          </div>
        )}
        <textarea
          placeholder="追问或探索……"
          title="Enter 发送 · Shift+Enter 换行"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={handleFileChange}
        />
        <div className="composer-bottom">
          <div className="composer-left">
            <Button variant="ghost" className="attach-btn" onClick={handlePickFile} disabled={uploading} icon="attachment" title="上传附件">{uploading ? "上传中…" : "附件"}</Button>
            {props.composerControls}
          </div>
          <Tooltip content="发送"><Button variant="primary" className="send-btn" icon="arrowUp" aria-label="发送" onClick={handleSend} disabled={props.settingsPending || (!input.trim() && !pendingQuote && attachments.length === 0)} /></Tooltip>
        </div>
        {props.settingsNote && <div className="composer-settings-note" role="status">{props.settingsNote}</div>}
      </div>
      {selection && createPortal(
        <div
          className="selection-bar"
          style={{
            position: "fixed",
            top: Math.max(10, selection.rect.top - 45),
            left: Math.max(8, Math.min(selection.rect.left, window.innerWidth - 100)),
          }}
        >
          <IconButton onClick={handleQuote} icon="quote" label="引用到当前卡片" />
          <IconButton variant="primary" onClick={handleExplore} icon="branch" label="创建探索分支" />
        </div>,
        document.body,
      )}
    </>
  );
}

// 单条消息渲染
// anchors：本消息为源回答的锚点（用于探索术语高亮）；allAnchors：会话内全量，
// 供用户消息回显引用块查找（引用锚点挂在被引用的源回答上，过滤后找不到）
function MessageView({ message, anchors, allAnchors, termLinks, currentCardId, onExplore, onExploreTerm, onCleanStaleTermLinks, onRetry, onStop, conv, onSelectCard, runStatus }: {
  message: Message;
  anchors: SelectionAnchor[];
  allAnchors: SelectionAnchor[];
  termLinks: TermLink[];
  currentCardId: string;
  onExplore: (id: string) => void;
  onExploreTerm: (src: { message_id: string; card_id: string; selected_text: string; start_offset: number; end_offset: number }) => void;
  onCleanStaleTermLinks: () => void;
  onRetry: (runId: string, cardId: string) => void;
  onStop: (runId: string) => void;
  conv: Conversation;
  onSelectCard: SelectCard;
  runStatus?: string;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const userContentRef = useRef<HTMLDivElement>(null);

  // Shift 按下态：用于悬停态切换标注样式与 Tooltip
  const [shiftDown, setShiftDown] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === "Shift") setShiftDown(true); };
    const up = (e: KeyboardEvent) => { if (e.key === "Shift") setShiftDown(false); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  // 防重复提交：Shift+点击创建探索进行中禁用对应 span
  const [pendingTerm, setPendingTerm] = useState<string | null>(null);

  // Shift 悬停 Tooltip：跟随标注 span 显示"基于当前卡片创建新的上下文"
  const [termTooltip, setTermTooltip] = useState<{ rect: DOMRect; key: string } | null>(null);
  const setTooltipFor = useCallback((key: string | null, rect?: DOMRect) => {
    setTermTooltip(rect ? { rect, key: key ?? "" } : null);
  }, []);

  // 全会话已探索术语（基于 termLinks，而非单消息 anchors），按长度降序以优先消解重叠。
  // 术语的目标卡片可能有多张（首次探索卡 + 后续 Shift+点击创建的卡，各有 branch anchor）。
  // 当前卡片若是该术语的任一探索卡，正文里这个词就不标注——命中了点击也只会跳回自身，无意义。
  const sortedLinks = useMemo(() => {
    const targetKeysOfCurrentCard = new Set(
      allAnchors
        .filter((a) => a.branch_card_id === currentCardId && a.selected_text)
        .map((a) => termKey(a.selected_text)),
    );
    return termLinks
      .filter((t) => !targetKeysOfCurrentCard.has(t.term_key))
      .sort((a, b) => b.term_text.length - a.term_text.length);
  }, [termLinks, allAnchors, currentCardId]);

  // 在给定 root 内标注所有 termLink 的所有出现位置。
  // 逐文本节点匹配 + Text.splitText 切分包裹，不跨节点，避免 surroundContents 异常。
  // 跳过已在 a/code/pre/.cite-badge/.explored-term 内的文本节点。
  const annotateTerms = useCallback((root: HTMLElement) => {
    if (sortedLinks.length === 0) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest("a, code, pre, .explored-term, .cite-badge")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes: Text[] = [];
    let n = walker.nextNode() as Text | null;
    while (n) { nodes.push(n); n = walker.nextNode() as Text | null; }
    // 记录已被包裹的 (node, 起止) 区间，避免较短术语在已包裹区重复标注
    for (const link of sortedLinks) {
      for (const node of nodes) {
        // 节点可能已被前一轮切分替换，若已脱离 DOM 则跳过
        if (!node.parentNode) continue;
        const text = node.textContent || "";
        if (!text) continue;
        for (const m of findTermMatches(text, link.term_text)) {
          // 检查该区间是否已被更长的术语包裹
          const already = node.parentElement?.closest(".explored-term");
          if (already) continue;
          try {
            const span = document.createElement("span");
            span.className = "explored-term";
            span.dataset.termKey = link.term_key;
            span.dataset.firstCardId = link.first_card_id;
            span.dataset.termText = link.term_text;
            span.dataset.messageId = message.id;
            span.dataset.start = String(m.start);
            span.dataset.end = String(m.end);
            // 请求进行中禁用该 span（防重复提交）
            if (pendingTerm === link.term_key) span.setAttribute("aria-disabled", "true");
            // Shift 悬停事件：显示/隐藏 Tooltip
            span.addEventListener("mouseenter", () => setTooltipFor(link.term_key, span.getBoundingClientRect()));
            span.addEventListener("mouseleave", () => setTooltipFor(null));
            const after = node.splitText(m.start);
            after.splitText(m.end - m.start);
            // splitText 后：node 保留 [0, m.start)，after 保留 [m.start, m.end)，之后是剩余文本
            node.parentNode?.insertBefore(span, after);
            span.appendChild(after);
            // span 已包裹 [m.start, m.end)；后续匹配应落在剩余文本上，但 findTermMatches 基于
            // 切分前的 text，这里 continue 以便对该 link 在剩余节点上继续匹配（after.nextSibling 为剩余）
            // 注意：after 现在在 span 内，剩余文本是 after 的兄弟；简化处理：直接 break 该节点的该 link
            break;
          } catch {
            // 跨节点/切分失败时跳过该出现位置，保证不崩
            continue;
          }
        }
      }
    }
  }, [sortedLinks, message.id, pendingTerm, setTooltipFor]);

  // assistant 正文渲染后标注术语（流式期间不处理）
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el || message.status === "streaming") return;
    annotateTerms(el);
  }, [message.content, message.status, annotateTerms]);

  // 用户消息正文也标注术语
  useLayoutEffect(() => {
    const el = userContentRef.current;
    if (!el) return;
    annotateTerms(el);
  }, [message.content, annotateTerms]);

  // 正文引用标注：把 [1] [2] 这类文本替换为带 favicon 的徽章，hover 弹出来源详情浮窗
  // streaming 期间不处理（content 持续变化）；sources 为空也不处理
  const sourceList = message.sources ?? [];
  const [activeCite, setActiveCite] = useState<{ idx: number; rect: DOMRect } | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const clearHoverTimer = () => { if (hoverTimer.current) { window.clearTimeout(hoverTimer.current); hoverTimer.current = null; } };
  const scheduleClose = () => { clearHoverTimer(); hoverTimer.current = window.setTimeout(() => setActiveCite(null), 220); };
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el || message.status === "streaming" || sourceList.length === 0) return;
    // 遍历文本节点，跳过已在 <a>/代码/已探索术语/徽章内的节点
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest("a, code, pre, .explored-term, .cite-badge")) return NodeFilter.FILTER_REJECT;
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
        if (Number.isNaN(idx) || idx < 1 || idx > sourceList.length) continue; // 超出来源范围的序号不动
        const at = m.index!;
        if (at > last) frag.appendChild(document.createTextNode(text.slice(last, at)));
        const src = sourceList[idx - 1]!;
        // 徽章即链接：点击直接打开来源原网页（新标签）
        const badge = document.createElement("a");
        badge.className = "cite-badge";
        badge.dataset.srcIdx = String(idx);
        badge.href = src.url;
        badge.target = "_blank";
        badge.rel = "noopener noreferrer";
        badge.tabIndex = 0;
        badge.title = `打开来源：${src.title || src.url}`;
        // 域名：去 www 前缀；favicon 走 Google favicon 服务，失败回退 🔗
        const host = (() => { try { return new URL(src.url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
        const img = document.createElement("img");
        img.alt = "";
        img.className = "cite-badge-icon";
        if (host) {
          img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
          img.onerror = () => { img.replaceWith(document.createTextNode("🔗")); };
        } else {
          img.replaceWith(document.createTextNode("🔗"));
        }
        badge.appendChild(img);
        const label = document.createElement("span");
        label.className = "cite-badge-label";
        label.textContent = host || src.url;
        badge.appendChild(label);
        // hover 弹浮窗：绑原生 mouseenter/mouseleave（徽章是动态 DOM，不依赖事件委托）
        badge.addEventListener("mouseenter", () => {
          clearHoverTimer();
          setActiveCite({ idx, rect: badge.getBoundingClientRect() });
        });
        badge.addEventListener("mouseleave", () => {
          scheduleClose();
        });
        // a 默认打开新标签页；阻止冒泡避免 React 委托的 handleTermClick 又弹出浮窗
        badge.addEventListener("click", (e) => {
          e.stopPropagation();
          setActiveCite(null);
        });
        frag.appendChild(badge);
        last = at + m[0].length;
      }
      if (last === 0) continue; // 没有有效引用，原样保留
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode?.replaceChild(frag, node);
    }
  }, [message.content, message.status, sourceList]);

  // 双语义点击：普通点击跳首次探索卡；Shift+点击从当前出处建独立新探索。
  // 拖选/复制时 Selection 非空，忽略 term click 避免误触。
  const handleTermClick = useCallback((e: React.MouseEvent) => {
    if (window.getSelection()?.toString()) return; // 拖选/复制不误触
    const target = (e.target as HTMLElement).closest(".explored-term") as HTMLElement | null;
    if (!target) return;
    e.stopPropagation();
    const firstCardId = target.dataset.firstCardId!;
    const termText = target.dataset.termText!;
    const messageId = target.dataset.messageId!;
    const start = Number(target.dataset.start);
    const end = Number(target.dataset.end);
    if (e.shiftKey) {
      // Shift+点击：从当前出处建独立新探索；请求进行中禁用该 span 防重复提交
      if (pendingTerm === target.dataset.termKey) return;
      setPendingTerm(target.dataset.termKey!);
      onExploreTerm({ message_id: messageId, card_id: currentCardId, selected_text: termText, start_offset: start, end_offset: end });
      // 完成后由 loadConversation 刷新 termLinks；这里乐观重置禁用态
      window.setTimeout(() => setPendingTerm(null), 1500);
    } else {
      // 普通点击：跳首次探索卡；first_card 已被删则提示并清理失效链接
      const exists = termLinks.find((t) => t.first_card_id === firstCardId);
      if (!exists) {
        onCleanStaleTermLinks();
        return;
      }
      if (firstCardId === currentCardId) return; // 已在首次卡内，不跳
      onSelectCard(firstCardId, { sourceCardId: currentCardId });
    }
  }, [onSelectCard, onExploreTerm, onCleanStaleTermLinks, currentCardId, termLinks, pendingTerm]);

  const activeSource = activeCite != null ? sourceList[activeCite.idx - 1] : null;

  if (message.role === "user") {
    return (
      <div className="msg-user-block">
        <div
          ref={userContentRef}
          className="msg-user msg-user-content"
          data-message-id={message.id}
          onClick={handleTermClick}
        >
          {message.quote_anchor_id && <QuoteBlock anchorId={message.quote_anchor_id} anchors={allAnchors} />}
          {message.content}
          {message.attachments && message.attachments.length > 0 && <AttachmentList attachments={message.attachments} />}
        </div>
        <div className="msg-actions">
          <CopyButton text={message.content} iconOnly />
        </div>
        {shiftDown && termTooltip && createPortal(
          <div
            className="term-tooltip"
            style={{
              position: "fixed",
              left: Math.max(8, Math.min(termTooltip.rect.left, window.innerWidth - 220)),
              top: termTooltip.rect.bottom + 4,
              zIndex: 1000,
            }}
          >
            Shift+点击：基于当前卡片创建新的上下文
          </div>,
          document.body,
        )}
      </div>
    );
  }
  // assistant
  const html = renderMarkdown(message.content || "");
  return (
    <div>
      <div className="msg-answer-label">
        <span><Icon name="assistant" /></span> 回答
      </div>
      <div
        ref={contentRef}
        className="msg-answer"
        data-message-id={message.id}
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={handleTermClick}
      />
      {message.status === "streaming" && (
        <div className="status-row">
          <span className="status-indicator">{runStatus || "生成中……"}</span>
          {message.run_id && (
            <button className="stop" onClick={() => message.run_id && onStop(message.run_id)} title="中断生成">
              停止
            </button>
          )}
        </div>
      )}
      {message.status === "failed" && (
        <div className="status-row">
          <span className="err">失败：{message.error || "未知错误"}</span>
          {message.run_id && <button className="retry" onClick={() => message.run_id && onRetry(message.run_id, message.card_id)}>重试</button>}
        </div>
      )}
      {message.status === "stopped" && <div className="status-row"><span>已停止</span></div>}
      {message.status === "complete" && (
        <div className="msg-actions" style={{ justifyContent: "flex-start", marginTop: 6 }}>
          <CopyButton text={message.content} iconOnly />
          <KnowledgeToggle message={message} />
        </div>
      )}
      {activeSource && activeCite && (
        <CitePopover source={activeSource} rect={activeCite.rect} onEnter={clearHoverTimer} onLeave={scheduleClose} onClose={() => { clearHoverTimer(); setActiveCite(null); }} />
      )}
      {shiftDown && termTooltip && createPortal(
        <div
          className="term-tooltip"
          style={{
            position: "fixed",
            left: Math.max(8, Math.min(termTooltip.rect.left, window.innerWidth - 220)),
            top: termTooltip.rect.bottom + 4,
            zIndex: 1000,
          }}
        >
          Shift+点击：基于当前卡片创建新的上下文
        </div>,
        document.body,
      )}
    </div>
  );
}

// 来源详情浮窗：hover 徽章后弹出，定位到徽章正下方；用 portal 渲染到 body，
// 避免卡片堆叠的 transform/filter 创建新 containing block 导致 fixed 定位错乱
function KnowledgeToggle({ message }: { message: Message }) {
  const [excluded, setExcluded] = useState(!!message.knowledge_excluded);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setExcluded(!!message.knowledge_excluded), [message.knowledge_excluded]);
  if (message.role !== "assistant") return null;
  return <>
    <IconButton disabled={pending} aria-pressed={excluded} aria-busy={pending}
      icon={excluded ? "knowledgeExcluded" : "knowledge"}
      label={pending ? "保存中…" : excluded ? "已排除助手知识 · 点击重新纳入" : "已纳入助手知识 · 点击排除"}
      onClick={async () => {
        setPending(true); setError("");
        try {
          const updated = await api.setKnowledgeExcluded(message.id, !excluded);
          setExcluded(!!updated.knowledge_excluded);
          window.dispatchEvent(new CustomEvent("kk-reload-conversation", { detail: message.conversation_id }));
        } catch (e) { setError(e instanceof Error ? e.message : "保存失败，请重试"); }
        finally { setPending(false); }
      }} />
    {error && <span role="alert" className="err">{error}</span>}
  </>;
}

function CitePopover({ source, rect, onEnter, onLeave, onClose }: { source: Source; rect: DOMRect; onEnter: () => void; onLeave: () => void; onClose: () => void }) {
  const popRef = useRef<HTMLDivElement>(null);
  // 浮窗通过 portal 挂在 document.body（#root 的祖先），React 合成 mouseenter/mouseleave/click
  // 在 portaled 元素上不触发——改用原生 addEventListener，与徽章一致
  useEffect(() => {
    const el = popRef.current;
    if (!el) return;
    el.addEventListener("mouseenter", onEnter);
    el.addEventListener("mouseleave", onLeave);
    return () => {
      el.removeEventListener("mouseenter", onEnter);
      el.removeEventListener("mouseleave", onLeave);
    };
  }, [onEnter, onLeave]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  let host = "";
  try { host = new URL(source.url).hostname.replace(/^www\./, ""); } catch { /* ignore */ }
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
  return createPortal(
    <div className="cite-popover" ref={popRef} style={style}>
      <div className="cite-popover-head">
        <img className="cite-popover-icon" alt="" src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host || source.url)}&sz=64`} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        <div className="cite-popover-title">{source.title || source.url}</div>
        </div>
      <div className="cite-popover-host">{host}</div>
      {source.snippet && <div className="cite-popover-snippet">{source.snippet}</div>}
    </div>,
    document.body,
  );
}


// 附件列表：展示文件名与下载链接
function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  return (
    <div className="msg-attachments">
      {attachments.map((a) => (
        <a className="msg-attachment" key={a.id} href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer" title={a.name}>
          <Icon name="attachment" />
          <span className="msg-attachment-name">{a.name}</span>
        </a>
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

// 卡片左侧轮次快速索引：每个圆点代表一轮问答（user 开启，到下一个 user 前）。
// hover 出简介浮窗，点击滚动到该轮首条消息。仅多于单轮（>=3 条消息）时渲染。
interface Round {
  id: string;
  userId?: string;
  answerId?: string;
  qPreview: string;
  aPreview: string;
}

const RoundRail = React.memo(function RoundRail({ messages, onJump }: { messages: Message[]; onJump: (messageId: string) => void }) {
  const [hover, setHover] = useState<{ idx: number; rect: DOMRect } | null>(null);
  const timer = useRef<number | null>(null);
  const clear = () => { if (timer.current) { window.clearTimeout(timer.current); timer.current = null; } };
  const scheduleClose = () => { clear(); timer.current = window.setTimeout(() => setHover(null), 200); };

  const rounds = useMemo<Round[]>(() => {
    const out: Round[] = [];
    let cur: Round | null = null;
    for (const m of messages) {
      if (m.role === "user") {
        cur = { id: m.id, userId: m.id, qPreview: preview(m.content, 40), aPreview: "" };
        out.push(cur);
      } else if (cur) {
        if (!cur.answerId) cur.answerId = m.id;
        if (!cur.aPreview) cur.aPreview = preview(m.content, 60);
      } else {
        // 末尾孤立的 assistant（无前置 user）独立成轮
        cur = { id: m.id, answerId: m.id, qPreview: "", aPreview: preview(m.content, 60) };
        out.push(cur);
      }
    }
    return out;
  }, [messages]);

  if (rounds.length < 2) return null;

  return (
    <div className="card-round-rail" aria-label="轮次快速索引">
      {rounds.map((r, i) => (
        <button
          key={r.id}
          type="button"
          className="card-round-dot"
          aria-label={`第 ${i + 1} 轮`}
          onMouseEnter={(e) => { clear(); setHover({ idx: i, rect: e.currentTarget.getBoundingClientRect() }); }}
          onMouseLeave={scheduleClose}
          onClick={() => onJump(r.userId || r.answerId || r.id)}
        />
      ))}
      {hover && createPortal(
        <div
          className="round-popover"
          style={{
            position: "fixed",
            top: Math.max(8, hover.rect.top),
            left: hover.rect.right + 8,
            zIndex: 1000,
          }}
          onMouseEnter={clear}
          onMouseLeave={scheduleClose}
        >
          {rounds[hover.idx]!.qPreview && <div className="round-popover-q">{rounds[hover.idx]!.qPreview}</div>}
          {rounds[hover.idx]!.aPreview && <div className="round-popover-a">{rounds[hover.idx]!.aPreview}</div>}
        </div>,
        document.body,
      )}
    </div>
  );
});

function preview(md: string, n: number): string {
  const t = markdownToPlainText(md).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}
