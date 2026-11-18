// 非流式补全：用于会话标题生成、知识助手证据整理等轻量调用。
// 走 OpenAI 兼容 Chat Completions（非流式），适用于 openai/deepseek/custom。
import type { ProviderConfig } from "../shared/types.js";
import type { ChatMessage } from "./adapters/types.js";
import { providerBase } from "./model-capabilities.js";
import { getSecret } from "./secret.js";

export async function completeChat(
  provider: ProviderConfig,
  model: string,
  messages: ChatMessage[],
  opts: { json?: boolean; signal?: AbortSignal } = {},
): Promise<string> {
  const key = provider.has_secret ? await getSecret(provider.secret_ref) : "";
  const base = providerBase(provider);
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
