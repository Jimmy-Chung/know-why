// Tavily 独立搜索适配器：为无原生搜索能力的兼容模型提供联网资料。
// 资料交回当前会话模型回答；不切换聊天模型。
import type { SearchAdapter, SearchResultItem } from "./types.js";

const DEFAULT_BASE = "https://api.tavily.com";

export class TavilyAdapter implements SearchAdapter {
  name = "Tavily";
  constructor(private apiKey: string, private apiBase: string = DEFAULT_BASE) {}

  private base() {
    return (this.apiBase || DEFAULT_BASE).replace(/\/$/, "");
  }

  async testConnection(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.base()}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: this.apiKey, query: "test", max_results: 1 }),
      });
      if (res.status === 401 || res.status === 403) return { ok: false, detail: "Tavily 鉴权失败：API Key 无效" };
      if (!res.ok) return { ok: false, detail: `Tavily 返回 ${res.status}` };
      return { ok: true, detail: "Tavily 连接成功" };
    } catch (e) {
      return { ok: false, detail: `Tavily 网络不可达：${(e as Error).message}` };
    }
  }

  async search(queries: string[], signal?: AbortSignal): Promise<{ results: SearchResultItem[]; raw: string }> {
    const all: SearchResultItem[] = [];
    for (const q of queries) {
      const res = await fetch(`${this.base()}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: this.apiKey,
          query: q,
          search_depth: "advanced", // 尝试获取正文
          max_results: 5,
          include_raw_content: true,
        }),
        signal,
      });
      if (res.status === 401 || res.status === 403) throw new Error("Tavily 鉴权失败");
      if (!res.ok) throw new Error(`Tavily 搜索失败 ${res.status}`);
      const j: any = await res.json();
      for (const r of j.results || []) {
        const content = r.raw_content || r.content || "";
        const kind: SearchResultItem["content_kind"] = content && content.length > 200 ? "full" : r.content ? "snippet" : "search_summary";
        all.push({
          url: r.url,
          title: r.title || r.url,
          snippet: (r.content || "").slice(0, 500),
          content: content || (r.content || "").slice(0, 1500),
          content_kind: kind,
        });
      }
    }
    // 去重
    const seen = new Set<string>();
    const dedup = all.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)));
    const raw = dedup.map((r) => `## ${r.title}\nURL: ${r.url}\n${r.content || r.snippet}`).join("\n\n---\n\n");
    return { results: dedup, raw };
  }
}
