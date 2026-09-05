// 非流式补全：用于独立搜索的查询计划生成、知识助手证据整理。
// 走 OpenAI 兼容 Chat Completions（非流式），适用于 openai/deepseek/custom。
import type { ProviderConfig } from "../shared/types.js";
import type { ChatMessage } from "./adapters/types.js";
import { getSecret } from "./secret.js";

export async function completeChat(
  provider: ProviderConfig,
  model: string,
  messages: ChatMessage[],
  opts: { json?: boolean; signal?: AbortSignal } = {},
): Promise<string> {
  const key = provider.has_secret ? await getSecret(provider.secret_ref) : "";
  const base = (provider.api_base || defaultBase(provider.type)).replace(/\/$/, "");
  const body: any = { model, messages, stream: false };
  if (opts.json) {
    body.response_format = { type: "json_object" };
  }
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`completeChat ${res.status}: ${t}`);
  }
  const j: any = await res.json();
  return j.choices?.[0]?.message?.content ?? "";
}

function defaultBase(type: ProviderConfig["type"]): string {
  if (type === "openai") return "https://api.openai.com/v1";
  if (type === "deepseek") return "https://api.deepseek.com/v1";
  return "";
}

// 解析查询计划 JSON，容错
export interface QueryPlan {
  search: boolean;
  queries: string[];
}
export function parseQueryPlan(text: string): QueryPlan {
  // 尝试抽取 JSON
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      const search = !!j.search;
      let queries: string[] = Array.isArray(j.queries) ? j.queries.filter((q: any) => typeof q === "string" && q.trim()) : [];
      if (!queries.length && typeof j.query === "string") queries = [j.query];
      return { search, queries: queries.slice(0, 5) };
    } catch {
      /* fall through */
    }
  }
  return { search: false, queries: [] };
}
