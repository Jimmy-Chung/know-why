import type { ModelCatalog } from "../shared/reasoning.js";
import type { ProviderCapabilities } from "../shared/types.js";
// 前端 API 客户端：封装与本地服务的交互，含 SSE 订阅。
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
  SSEEvent,
  Attachment,
  NoteCard,
} from "../shared/types.js";

const BASE = "/api";

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(t || `${res.status}`);
  }
  return res.json();
}

export const api = {
  // Provider
  listProviders: () => fetch(`${BASE}/providers`).then(j<ProviderConfig[]>),
  createProvider: (body: any) =>
    fetch(`${BASE}/providers`, { method: "POST", headers: ct(), body: JSON.stringify(body) }).then(j<ProviderConfig>),
  updateProvider: (id: string, body: any) =>
    fetch(`${BASE}/providers/${id}`, { method: "PATCH", headers: ct(), body: JSON.stringify(body) }).then(j<ProviderConfig>),
  setProviderSecret: (id: string, key: string) =>
    fetch(`${BASE}/providers/${id}/secret`, { method: "PUT", headers: ct(), body: JSON.stringify({ key }) }).then(j<any>),
  deleteProvider: (id: string) =>
    fetch(`${BASE}/providers/${id}`, { method: "DELETE" }).then(j<any>),
  setDefaultProvider: (id: string) =>
    fetch(`${BASE}/providers/${id}/default`, { method: "POST" }).then(j<any>),
  testProvider: (id: string) =>
    fetch(`${BASE}/providers/${id}/test`, { method: "POST" }).then(j<{ ok: boolean; detail: string }>),
  // 保存前的连接验证：不落库，返回能力探测结果
  verifyProvider: (body: { type: string; api_base?: string; api_key?: string; model: string; provider_id?: string }) =>
    fetch(`${BASE}/providers/verify`, { method: "POST", headers: ct(), body: JSON.stringify(body) }).then(
      j<{
        ok: boolean;
        detail: string;
        errorKind?: string;
        capabilities?: ProviderCapabilities;
        resolvedModel?: string;
        availableModels?: string[];
        catalog?: ModelCatalog;
      }>,
    ),

  getProviderModels: (id: string, model: string, refresh = false, signal?: AbortSignal) =>
    fetch(`${BASE}/providers/${id}/models?model=${encodeURIComponent(model)}${refresh ? "&refresh=1" : ""}`, { signal }).then(j<ModelCatalog>),

  // Search

  // Conversations
  listConversations: () => fetch(`${BASE}/conversations`).then(j<Conversation[]>),
  listDeleted: () => fetch(`${BASE}/conversations/deleted`).then(j<Conversation[]>),
  createConversation: () =>
    fetch(`${BASE}/conversations`, { method: "POST" }).then(j<{ conversation: Conversation; mainCard: Card }>),
  getConversation: (id: string) =>
    fetch(`${BASE}/conversations/${id}`).then(
      j<{
        conversation: Conversation;
        cards: Card[];
        messages: Record<string, Message[]>;
        drafts: Record<string, { text: string; pending_quote_anchor_id: string | null }>;
        anchors: SelectionAnchor[];
        assistant: KnowledgeAssistantMessage[];
        notes: NoteCard[];
        view: { current_card_id: string | null; scroll_position: number } | null;
        termLinks: TermLink[];
        provider: ProviderConfig;
      }>,
    ),
  updateConversation: (id: string, body: any) =>
    fetch(`${BASE}/conversations/${id}`, { method: "PATCH", headers: ct(), body: JSON.stringify(body) }).then(j<Conversation>),
  deleteConversation: (id: string) => fetch(`${BASE}/conversations/${id}`, { method: "DELETE" }).then(j<any>),
  restoreConversation: (id: string) =>
    fetch(`${BASE}/conversations/${id}/restore`, { method: "POST" }).then(j<any>),
  purgeConversation: (id: string) =>
    fetch(`${BASE}/conversations/${id}/purge`, { method: "DELETE" }).then(j<any>),

  // Anchors & explore
  createAnchor: (convId: string, body: any) =>
    fetch(`${BASE}/conversations/${convId}/anchors`, { method: "POST", headers: ct(), body: JSON.stringify(body) }).then(j<SelectionAnchor>),
  explore: (convId: string, anchorId: string) =>
    fetch(`${BASE}/conversations/${convId}/explore`, { method: "POST", headers: ct(), body: JSON.stringify({ anchor_id: anchorId }) }).then(j<{ card: Card; run?: Run; existing: boolean }>),
  // Shift+点击：从当前出处建独立新探索；首次 target 由服务端 term_link 保持稳定
  exploreTerm: (convId: string, body: { message_id: string; card_id: string; selected_text: string; start_offset: number; end_offset: number }) =>
    fetch(`${BASE}/conversations/${convId}/explore-term`, { method: "POST", headers: ct(), body: JSON.stringify(body) }).then(j<{ card: Card; run?: Run; existing: boolean; termLink: TermLink }>),
  // 清理失效的 term_link（first_card 已被删除的记录），返回清理数
  deleteStaleTermLinks: (convId: string) =>
    fetch(`${BASE}/conversations/${convId}/term-links/clean-stale`, { method: "POST" }).then(j<{ ok: boolean; deleted: number }>),

  // Messages
  setKnowledgeExcluded: (messageId: string, excluded: boolean) =>
    fetch(`${BASE}/messages/${messageId}/knowledge`, { method: "PATCH", headers: ct(), body: JSON.stringify({ excluded }) }).then(j<Message>),
  sendMessage: (cardId: string, body: { content: string; quote_anchor_id?: string | null; attachments?: Attachment[] }) =>
    fetch(`${BASE}/cards/${cardId}/messages`, { method: "POST", headers: ct(), body: JSON.stringify(body) }).then(j<{ userMessage: Message; run: Run }>),

  // Run SSE
  streamRun: (runId: string, onEvent: (e: SSEEvent) => void, onDone?: () => void): (() => void) => {
    const ctrl = new AbortController();
    let terminal = false;
    // 开发模式：Vite proxy 会缓冲 SSE 流，改为直连后端 5179；生产模式由后端同源托管，走相对路径。
    // 用构建期常量判断，避免部署端口恰好是 5180 时被误判成开发模式。
    const isDev = import.meta.env.DEV;
    const sseUrl = isDev ? `http://127.0.0.1:5179${BASE}/runs/${runId}/stream` : `${BASE}/runs/${runId}/stream`;
    fetch(sseUrl, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) throw new Error(`连接失败（${res.status}）`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() || "";
          for (const block of blocks) {
            const lines = block.split("\n");
            let type = "";
            let data = "";
            for (const line of lines) {
              if (line.startsWith("event:")) type = line.slice(6).trim();
              else if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (!type || !data) continue;
            try {
              const e = JSON.parse(data) as SSEEvent;
              onEvent(e);
              if (e.type === "done" || e.type === "error") { terminal = true; onDone?.(); }
            } catch {
              /* ignore */
            }
          }
        }
      })
      .then(() => {
        if (!terminal && !ctrl.signal.aborted) throw new Error("连接已中断，请重新打开助手查看已保存的回答。");
      })
      .catch((error) => {
        if (!ctrl.signal.aborted && !terminal) {
          terminal = true;
          onEvent({type:"error",run_id:runId,message:error instanceof Error ? error.message : "连接失败"});
          onDone?.();
        }
      });
    return () => ctrl.abort();
  },
  stopRun: (runId: string) => fetch(`${BASE}/runs/${runId}/stop`, { method: "POST" }).then(j<any>),
  retryRun: (runId: string) => fetch(`${BASE}/runs/${runId}/retry`, { method: "POST" }).then(j<{ run: Run | null }>),

  // Draft & view
  saveDraft: (cardId: string, text: string, quoteAnchorId: string | null) =>
    fetch(`${BASE}/cards/${cardId}/draft`, { method: "PUT", headers: ct(), body: JSON.stringify({ text, pending_quote_anchor_id: quoteAnchorId }) }).then(j<any>),
  saveViewState: (convId: string, cardId: string | null, scroll: number) =>
    fetch(`${BASE}/conversations/${convId}/viewstate`, { method: "PUT", headers: ct(), body: JSON.stringify({ current_card_id: cardId, scroll_position: scroll }) }).then(j<any>),

  // Assistant
  sendAssistant: (convId: string, question: string, threadId?: string | null, quote?: string | null, scopeCardIds?: string[] | null) =>
    fetch(`${BASE}/conversations/${convId}/assistant`, { method: "POST", headers: ct(), body: JSON.stringify({ question, thread_id: threadId ?? null, quote: quote ?? null, scope_card_ids: scopeCardIds && scopeCardIds.length ? scopeCardIds : null, idempotency_key: crypto.randomUUID() }) }).then(j<{ userMsgId: string; runId: string }>),

  // Notes
  listNotes: (convId: string) => fetch(`${BASE}/conversations/${convId}/notes`).then(j<NoteCard[]>),
  createNote: (convId: string, body: { title: string; content_markdown: string }) =>
    fetch(`${BASE}/conversations/${convId}/notes`, { method: "POST", headers: ct(), body: JSON.stringify(body) }).then(j<NoteCard>),
  updateNote: (noteId: string, body: { title?: string; content_markdown?: string }) =>
    fetch(`${BASE}/notes/${noteId}`, { method: "PUT", headers: ct(), body: JSON.stringify(body) }).then(j<NoteCard>),
  deleteNote: (noteId: string) =>
    fetch(`${BASE}/notes/${noteId}`, { method: "DELETE" }).then(j<any>),
  deleteNotes: (ids: string[]) =>
    fetch(`${BASE}/notes/batch-delete`, { method: "POST", headers: ct(), body: JSON.stringify({ ids }) }).then(j<{ ok: boolean; deleted: number }>),

  // Backup
};

function ct() {
  return { "Content-Type": "application/json" };
}
