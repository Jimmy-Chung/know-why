// Provider 适配器统一接口。
// 每个适配器负责：连接测试、能力探测、聊天流式、（可选）原生搜索。
// 独立搜索由独立的 TavilyAdapter 承担，与聊天 Provider 解耦。

import type { ProviderType, WebMode, ThinkMode } from "../../shared/types.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AdapterRequest {
  model: string;
  maxOutputTokens?: number;
  messages: ChatMessage[];
  webMode: WebMode;
  thinkMode: ThinkMode;
  reasoning?: import("../../shared/reasoning.js").ReasoningCapabilities;
  signal?: AbortSignal;
  // 适配器可用此回调报告已用 token（尽力而为）
  onUsage?: (u: { prompt_tokens?: number; completion_tokens?: number }) => void;
}

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "searching"; queries: string[]; service: string }
  | { type: "reading"; url: string }
  | { type: "source"; source: { url: string; title: string; snippet: string; content_kind: "full" | "snippet" | "search_summary" } }
  | { type: "thinking"; text: string }
  | { type: "done"; usage?: { prompt_tokens?: number; completion_tokens?: number } }
  | { type: "error"; message: string };

export interface Adapter {
  type: ProviderType;
  // 真实连接测试：区分鉴权失败、接口不可达、模型不可用
  testConnection(): Promise<{ ok: boolean; detail: string }>;
  // 流式聊天（可能含原生搜索，取决于 webMode 与能力）
  stream(req: AdapterRequest): AsyncIterable<StreamEvent>;
  // 是否支持原生搜索（接口层保证 force 时返回 false）
  supportsNativeSearch(): boolean;
  // 是否支持原生思考参数
  supportsThinking(): boolean;
}

export interface SearchResultItem {
  url: string;
  title: string;
  snippet: string;
  content: string; // 正文或摘要
  content_kind: "full" | "snippet" | "search_summary";
}

export interface SearchAdapter {
  name: string;
  // 执行检索，返回带正文的资料
  search(queries: string[], signal?: AbortSignal): Promise<{ results: SearchResultItem[]; raw: string }>;
  testConnection(): Promise<{ ok: boolean; detail: string }>;
}

export class AdapterError extends Error {
  constructor(
    message: string,
    public kind: "auth" | "unreachable" | "model" | "capability" | "unknown",
  ) {
    super(message);
  }
}
