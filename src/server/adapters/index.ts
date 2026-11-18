// 适配器工厂：根据 ProviderConfig 与系统凭据创建适配器实例。
import { OpenAIAdapter, DeepSeekAdapter, CustomAdapter } from "./openai.js";
import { TavilyAdapter } from "./tavily.js";
import type { Adapter, SearchAdapter } from "./types.js";
import type { ProviderConfig, ProviderCapabilities } from "../../shared/types.js";
import { reasoningProtocol, providerBase } from "../model-capabilities.js";
import { getSecret } from "../secret.js";
import * as repo from "../repo.js";

// 默认能力表（按类型；连接测试后可更新）
export function defaultCapabilities(type: ProviderConfig["type"]): ProviderCapabilities {
  switch (type) {
    case "openai":
      return { web_search: true, thinking: true, tool_calls: true, force_search: true, models: [], context_window: 128000 };
    case "deepseek":
      // DeepSeek 用 deepseek_web_search 工具原生联网：模型自行决定是否搜索，
      // tool_choice 不能强制，因此 force_search 为 false。
      // 上下文窗口在能力探测后会被接口返回的真实值覆盖。
      return { web_search: true, thinking: true, tool_calls: true, force_search: false, models: [], context_window: 128000 };
    case "openrouter":
    case "custom":
      return { web_search: false, thinking: false, tool_calls: false, force_search: false, models: [], context_window: 32000 };
  }
}

export async function createAdapter(provider: ProviderConfig): Promise<Adapter> {
  const key = provider.has_secret ? await getSecret(provider.secret_ref) : null;
  if (!key && provider.type !== "custom") {
    // 允许无 key 的自定义接口
  }
  const protocol = reasoningProtocol(provider);
  const base = providerBase(provider);
  switch (protocol) {
    case "openai":
      return new OpenAIAdapter(key || "", base, provider.capabilities.web_search);
    case "deepseek":
      return new DeepSeekAdapter(key || "", base, provider.capabilities.web_search);
    case "openrouter":
    case "custom":
      return new CustomAdapter(key || "", base, protocol);
  }
}

export async function createSearchAdapter(): Promise<SearchAdapter | null> {
  const cfg = repo.search.get();
  if (!cfg || !cfg.enabled || cfg.provider !== "tavily") return null;
  const key = cfg.has_secret ? await getSecret(cfg.secret_ref) : null;
  if (!key) return null;
  return new TavilyAdapter(key, cfg.api_base);
}

export { OpenAIAdapter, DeepSeekAdapter, CustomAdapter, TavilyAdapter };
