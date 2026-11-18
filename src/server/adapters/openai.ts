// OpenAI 适配器：Chat Completions 流式聊天；原生搜索走 Responses API（web_search 工具）。
import type { Adapter, AdapterRequest, StreamEvent } from "./types.js";
import { AdapterError } from "./types.js";

import { reasoningRequest } from "../model-capabilities.js";
import { UNKNOWN_REASONING } from "../../shared/reasoning.js";

const DEFAULT_BASE = "https://api.openai.com/v1";

export class OpenAIAdapter implements Adapter {
  type = "openai" as const;
  constructor(private apiKey: string, private apiBase: string = DEFAULT_BASE, private nativeSearch: boolean = true) {}

  supportsNativeSearch() {
    return this.nativeSearch;
  }
  supportsThinking() {
    return true; // reasoning models 支持 reasoning 参数；具体能力以实际模型为准
  }

  private base(): string {
    return (this.apiBase || DEFAULT_BASE).replace(/\/$/, "");
  }

  async testConnection(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.base()}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (res.status === 401 || res.status === 403) return { ok: false, detail: "鉴权失败：API Key 无效或无权限" };
      if (res.status === 404) return { ok: false, detail: "接口不可达：地址不存在" };
      if (!res.ok) return { ok: false, detail: `接口返回 ${res.status}` };
      return { ok: true, detail: "连接成功" };
    } catch (e) {
      return { ok: false, detail: `网络不可达：${(e as Error).message}` };
    }
  }

  async *stream(req: AdapterRequest): AsyncIterable<StreamEvent> {
    // 原生搜索：当需要联网且支持时，走 Responses API
    const useNativeSearch = req.webMode !== "off" && this.supportsNativeSearch();
    if (useNativeSearch) {
      yield* this.streamResponses(req);
      return;
    }
    yield* this.streamChat(req);
  }

  private async *streamChat(req: AdapterRequest): AsyncIterable<StreamEvent> {
    const body: any = {
      model: req.model,
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.maxOutputTokens) body.max_completion_tokens = req.maxOutputTokens;
    Object.assign(body, reasoningRequest(req.thinkMode, req.reasoning ?? UNKNOWN_REASONING, "openai"));
    const res = await fetch(`${this.base()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body) {
      throw await toError(res);
    }
    yield* parseSSE(res.body, (evt: string) => {
      if (evt === "[DONE]") return { kind: "done" };
      try {
        const j = JSON.parse(evt);
        if (j.usage) req.onUsage?.(j.usage);
        const choice = j.choices?.[0];
        const delta = choice?.delta?.content;
        const d = j.choices?.[0]?.delta;
        const thinking = d?.reasoning_content || d?.reasoning || d?.reasoning_details?.map((r: any) => r.text || r.summary || "").join("");
        if (thinking || delta) return { kind: "multi", events: [
          ...(thinking ? [{ type: "thinking", text: thinking }] : []),
          ...(delta ? [{ type: "delta", text: delta }] : []),
        ] };
        if (j.usage) return { kind: "usage", usage: j.usage };
        return { kind: "ignore" };
      } catch {
        return { kind: "ignore" };
      }
    }, req);
  }

  // Responses API + web_search 工具：服务端执行搜索并返回带来源的回答
  private async *streamResponses(req: AdapterRequest): AsyncIterable<StreamEvent> {
    const tools: any[] = [{ type: "web_search" }];
    const body: any = {
      model: req.model,
      input: req.messages.map((m) => ({ role: m.role, content: m.content })),
      tools,
      stream: true,
    };
    if (req.maxOutputTokens) body.max_output_tokens = req.maxOutputTokens;
    Object.assign(body, reasoningRequest(req.thinkMode, req.reasoning ?? UNKNOWN_REASONING, "openai", true));

    let res: Response;
    try {
      res = await fetch(`${this.base()}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (e) {
      throw new AdapterError(`OpenAI Responses 请求失败：${(e as Error).message}`, "unreachable");
    }
    if (!res.ok || !res.body) throw await toError(res);

    const usage: any = {};
    for await (const evt of parseResponsesSSE(res.body)) {
      const t = evt.type;
      if (t === "response.output_text.delta") {
        yield { type: "delta", text: evt.delta || "" };
      } else if (t === "response.web_search_call.searching") {
        yield { type: "searching", queries: [evt.query || ""].filter(Boolean), service: "OpenAI Web Search" };
      } else if (t === "response.web_search_call.completed") {
        // 来源在最终 response.output 中
      } else if (t === "response.completed") {
        const out = evt.response?.output || [];
        for (const item of out) {
          if (item.type === "web_search_call" && item.action?.url) {
            yield { type: "source", source: { url: item.action.url, title: item.action.title || item.action.url, snippet: "", content_kind: "snippet" } };
          }
          if (item.type === "message" && item.content) {
            for (const c of item.content) {
              if (c.type === "output_text" && c.annotations) {
                for (const a of c.annotations) {
                  if (a.type === "url_citation" && a.url) {
                    yield { type: "source", source: { url: a.url, title: a.title || a.url, snippet: "", content_kind: "snippet" } };
                  }
                }
              }
            }
          }
        }
        if (evt.response?.usage) Object.assign(usage, evt.response.usage);
      }
    }
    yield { type: "done", usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens } };
  }
}

// DeepSeek 适配器：与 OpenAI 兼容的 Chat Completions。
// 原生联网通过声明 deepseek_web_search 工具启用：由模型自行决定是否搜索，
// tool_choice 不能指定该工具，因此支持自动联网、无法强制。
export class DeepSeekAdapter implements Adapter {
  type = "deepseek" as const;
  constructor(private apiKey: string, private apiBase: string = "https://api.deepseek.com/v1", private nativeSearch: boolean = true) {}

  supportsNativeSearch() {
    return this.nativeSearch;
  }
  supportsThinking() {
    return true; // deepseek-reasoner 支持推理
  }
  private base() {
    return (this.apiBase || "https://api.deepseek.com/v1").replace(/\/$/, "");
  }

  async testConnection(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.base()}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (res.status === 401 || res.status === 403) return { ok: false, detail: "鉴权失败：API Key 无效" };
      if (res.status === 404) return { ok: false, detail: "接口不可达" };
      if (!res.ok) return { ok: false, detail: `接口返回 ${res.status}` };
      return { ok: true, detail: "连接成功" };
    } catch (e) {
      return { ok: false, detail: `网络不可达：${(e as Error).message}` };
    }
  }

  async *stream(req: AdapterRequest): AsyncIterable<StreamEvent> {
    const useNativeSearch = req.webMode !== "off" && this.supportsNativeSearch();
    const body: any = {
      model: req.model,
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.maxOutputTokens) body.max_tokens = req.maxOutputTokens;
    if (useNativeSearch) {
      // 服务端工具：模型自行决定是否搜索，不能出现在 tool_choice 中
      body.tools = [{ type: "deepseek_web_search", name: "deepseek_web_search" }];
    }
    Object.assign(body, reasoningRequest(req.thinkMode, req.reasoning ?? UNKNOWN_REASONING, "deepseek"));
    const res = await fetch(`${this.base()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body) throw await toError(res);

    // 同一次回答里同一来源会在工具结果和引用标注中各出现一次，去重后再上报。
    const seenSources = new Set<string>();
    const pushSource = (out: StreamEvent[], raw: any): void => {
      const url = typeof raw?.url === "string" ? raw.url.trim() : "";
      if (!url) return;
      const title = typeof raw?.title === "string" && raw.title ? raw.title : url;
      const key = `${url}|${title}`;
      if (seenSources.has(key)) return;
      seenSources.add(key);
      out.push({
        type: "source",
        source: {
          url,
          title,
          snippet: typeof raw?.snippet === "string" ? raw.snippet : "",
          content_kind: "snippet",
        },
      });
    };

    yield* parseSSE(res.body, (evt: string) => {
      if (evt === "[DONE]") return { kind: "done" };
      try {
        const j = JSON.parse(evt);
        if (j.usage) req.onUsage?.(j.usage);
        const delta = j.choices?.[0]?.delta;
        if (!delta) return j.usage ? { kind: "usage", usage: j.usage } : { kind: "ignore" };

        const out: StreamEvent[] = [];
        if (delta.reasoning_content) out.push({ type: "thinking", text: delta.reasoning_content });
        if (delta.content) out.push({ type: "delta", text: delta.content });

        // 原生搜索的工具调用：calls[].action.queries + calls[].sources
        for (const group of delta.server_tool_calls ?? []) {
          for (const call of group?.calls ?? []) {
            const queries = Array.isArray(call?.action?.queries)
              ? call.action.queries.filter((q: unknown) => typeof q === "string" && q.trim())
              : [];
            if (queries.length) {
              out.push({ type: "searching", queries, service: "DeepSeek 原生搜索" });
            }
            for (const source of call?.sources ?? []) pushSource(out, source);
          }
        }
        // 最终回答里的引用标注
        for (const annotation of delta.annotations ?? []) {
          pushSource(out, annotation?.url_citation);
        }

        if (j.usage && !out.length) return { kind: "usage", usage: j.usage };
        return out.length ? { kind: "multi", events: out } : { kind: "ignore" };
      } catch {
        return { kind: "ignore" };
      }
    }, req);
  }
}

// 自定义兼容接口适配器：仅 OpenAI 兼容 Chat Completions，不假定原生搜索/思考。
export class CustomAdapter implements Adapter {
  type = "custom" as const;
  constructor(private apiKey: string, private apiBase: string, private protocol: string = "custom") {}
  supportsNativeSearch() {
    return false;
  }
  supportsThinking() {
    return false;
  }
  private base() {
    return this.apiBase.replace(/\/$/, "");
  }
  async testConnection(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.base()}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (res.status === 401 || res.status === 403) return { ok: false, detail: "鉴权失败" };
      if (!res.ok) return { ok: false, detail: `接口返回 ${res.status}` };
      // 校验返回的是 JSON API 而非 HTML 页面（如缺 /api/v1 时会命中网站首页）
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("json")) return { ok: false, detail: "接口地址可能有误：返回非 JSON（请检查是否缺 /api/v1 路径）" };
      const j = await res.json().catch(() => null);
      if (!j) return { ok: false, detail: "接口返回非 JSON（请检查地址是否含 /api/v1）" };
      return { ok: true, detail: "连接成功" };
    } catch (e) {
      return { ok: false, detail: `网络不可达：${(e as Error).message}` };
    }
  }
  async *stream(req: AdapterRequest): AsyncIterable<StreamEvent> {
    const body: any = { model: req.model, messages: req.messages, stream: true };
    if (req.maxOutputTokens) body.max_tokens = req.maxOutputTokens;
    Object.assign(body, reasoningRequest(req.thinkMode, req.reasoning ?? UNKNOWN_REASONING, this.protocol));
    const res = await fetch(`${this.base()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body) throw await toError(res);
    yield* parseSSE(res.body, (evt: string) => {
      if (evt === "[DONE]") return { kind: "done" };
      try {
        const j = JSON.parse(evt);
        if (j.usage) req.onUsage?.(j.usage);
        if (j.usage && !j.choices?.[0]?.delta?.content) return { kind: "usage", usage: j.usage };
        const delta = j.choices?.[0]?.delta?.content;
        const d = j.choices?.[0]?.delta;
        const thinking = d?.reasoning_content || d?.reasoning || d?.reasoning_details?.map((r: any) => r.text || r.summary || "").join("");
        if (thinking || delta) return { kind: "multi", events: [
          ...(thinking ? [{ type: "thinking", text: thinking }] : []),
          ...(delta ? [{ type: "delta", text: delta }] : []),
        ] };
        return { kind: "ignore" };
      } catch {
        return { kind: "ignore" };
      }
    }, req);
  }
}

// ---- SSE 解析工具 ----

type Callback =
  | ((evt: string) => { kind: "done" | "ignore" } | { kind: "delta"; text: string } | { kind: "usage"; usage: any } | { kind: "multi"; events: StreamEvent[] })
  | any;

async function* parseSSE(body: ReadableStream<Uint8Array>, cb: any, req: AdapterRequest): AsyncIterable<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: any = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const l = line.trim();
        if (!l || !l.startsWith("data:")) continue;
        const data = l.slice(5).trim();
        if (data === "[DONE]") {
          yield { type: "done", usage };
          return;
        }
        const r = cb(data);
        if (!r) continue;
        if (r.kind === "done") {
          yield { type: "done", usage };
          return;
        }
        if (r.kind === "delta") yield { type: "delta", text: r.text };
        else if (r.kind === "usage") usage = r.usage;
        else if (r.kind === "multi") for (const e of r.events) if (e && (e as any).type) yield e as StreamEvent;
      }
    }
    yield { type: "done", usage };
  } finally {
    reader.releaseLock();
  }
}

async function* parseResponsesSSE(body: ReadableStream<Uint8Array>): AsyncIterable<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const l = line.trim();
        if (!l.startsWith("data:")) continue;
        const data = l.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data);
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function toError(res: Response): Promise<AdapterError> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    /* ignore */
  }
  if (res.status === 401 || res.status === 403) return new AdapterError(`鉴权失败：${text || res.status}`, "auth");
  if (res.status === 404) return new AdapterError(`模型或接口不可用：${text || res.status}`, "model");
  if (res.status === 400) {
    if (/model/i.test(text)) return new AdapterError(`模型不可用：${text}`, "model");
    return new AdapterError(`请求参数错误：${text}`, "unknown");
  }
  return new AdapterError(`接口错误 ${res.status}：${text}`, "unknown");
}
