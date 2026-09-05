// 前端 API 客户端：封装与本地服务的交互，含 SSE 订阅。
import type {
  ProviderConfig,
  SearchConfig,
  Conversation,
  Card,
  Message,
  SelectionAnchor,
  KnowledgeAssistantMessage,
  Run,
  Source,
  SSEEvent,
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

  // Search
  getSearch: () => fetch(`${BASE}/search`).then(j<SearchConfig | null>),
  setSearch: (body: any) =>
    fetch(`${BASE}/search`, { method: "PUT", headers: ct(), body: JSON.stringify(body) }).then(j<SearchConfig>),
  setSearchSecret: (key: string) =>
    fetch(`${BASE}/search/secret`, { method: "PUT", headers: ct(), body: JSON.stringify({ key }) }).then(j<any>),
  testSearch: () => fetch(`${BASE}/search/test`, { method: "POST" }).then(j<{ ok: boolean; detail: string }>),

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
        view: { current_card_id: string | null; scroll_position: number } | null;
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
    fetch(`${BASE}/conversations/${convId}/explore`, { method: "POST", headers: ct(), body: JSON.stringify({ anchor_id: anchorId }) }).then(j<{ card: Card; run: Run; existing: boolean }>),

  // Messages
  sendMessage: (cardId: string, body: { content: string; quote_anchor_id?: string | null }) =>
    fetch(`${BASE}/cards/${cardId}/messages`, { method: "POST", headers: ct(), body: JSON.stringify(body) }).then(j<{ userMessage: Message; run: Run }>),

  // Run SSE
  streamRun: (runId: string, onEvent: (e: SSEEvent) => void, onDone?: () => void): (() => void) => {
    const ctrl = new AbortController();
    fetch(`${BASE}/runs/${runId}/stream`, { signal: ctrl.signal })
      .then(async (res) => {
        const reader = res.body!.getReader();
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
              if (e.type === "done" || e.type === "error") onDone?.();
            } catch {
              /* ignore */
            }
          }
        }
      })
      .catch(() => {});
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
  sendAssistant: (convId: string, question: string) =>
    fetch(`${BASE}/conversations/${convId}/assistant`, { method: "POST", headers: ct(), body: JSON.stringify({ question }) }).then(j<{ userMsgId: string; runId: string }>),

  // Backup
  backup: () => fetch(`${BASE}/backup`, { method: "POST" }).then(j<{ ok: boolean; file: string }>),
  exportData: () => fetch(`${BASE}/export`).then(j<any>),
};

function ct() {
  return { "Content-Type": "application/json" };
}
