// OpenAI 适配器：Chat Completions 流式聊天；原生搜索走 Responses API（web_search 工具）。
import type { Adapter, AdapterRequest, StreamEvent } from "./types.js";
import { AdapterError } from "./types.js";

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
    if (req.thinkMode !== "off") {
      // 兼容性参数：reasoning_effort（仅 reasoning 模型识别）
      body.reasoning_effort = req.thinkMode === "deep" ? "high" : "medium";
    }
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
        const choice = j.choices?.[0];
        const delta = choice?.delta?.content;
        if (delta) return { kind: "delta", text: delta };
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
    if (req.thinkMode !== "off") body.reasoning = { effort: req.thinkMode === "deep" ? "high" : "medium" };

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
// DeepSeek 的原生 web_search 能力以 Responses API 探测为准；默认不假定具备。
export class DeepSeekAdapter implements Adapter {
  type = "deepseek" as const;
  constructor(private apiKey: string, private apiBase: string = "https://api.deepseek.com/v1", private nativeSearch: boolean = false) {}

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
    const body: any = {
      model: req.model,
      messages: req.messages,
      stream: true,
    };
    if (req.thinkMode !== "off" && req.model.includes("reasoner")) {
      // deepseek-reasoner 自带推理，无需额外参数
    }
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
        const choice = j.choices?.[0];
        const delta = choice?.delta?.content;
        const reasoning = choice?.delta?.reasoning_content;
        const out: StreamEvent[] = [];
        if (reasoning) out.push({ type: "thinking", text: reasoning });
        if (delta) out.push({ type: "delta", text: delta });
        if (j.usage) return { kind: "multi", events: out.length ? out : [{ type: "usage-only" as any }] };
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
  constructor(private apiKey: string, private apiBase: string) {}
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
      return { ok: true, detail: "连接成功" };
    } catch (e) {
      return { ok: false, detail: `网络不可达：${(e as Error).message}` };
    }
  }
  async *stream(req: AdapterRequest): AsyncIterable<StreamEvent> {
    const body: any = { model: req.model, messages: req.messages, stream: true };
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
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) return { kind: "delta", text: delta };
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
