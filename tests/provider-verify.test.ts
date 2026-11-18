import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";

let app: Hono;
let db: typeof import("../src/server/db.js");
const dataDir = mkdtempSync(join(tmpdir(), "kk-verify-"));

// 模拟 DeepSeek 官方 /models 的真实返回结构
const deepseekModels = [
  {
    id: "deepseek-flash",
    context_window: 1048576,
    max_output_tokens: 393216,
    input_modalities: ["text", "image"],
    effort: { supported_levels: ["low", "high", "max"], default_level: "high" },
  },
];

beforeAll(async () => {
  vi.stubEnv("KNOW_KNOW_DATA_DIR", dataDir);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: any) => {
      const target = String(url);
      const auth = String(init?.headers?.Authorization ?? "");
      if (target.startsWith("https://api.deepseek.com/")) {
        if (auth.includes("bad")) return new Response("{}", { status: 401 });
        return Response.json({ data: deepseekModels });
      }
      return new Response("{}", { status: 404 });
    }),
  );
  ({ app } = await import("../src/server/index.js"));
  db = await import("../src/server/db.js");
});

afterAll(() => {
  db.closeDb();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

async function verify(body: Record<string, unknown>) {
  const response = await app.request("/api/providers/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

describe("POST /api/providers/verify", () => {
  it("DeepSeek 免填域名：按官方默认地址验证，并返回窗口与推理档位", async () => {
    const r = await verify({ type: "deepseek", api_key: "sk-test", model: "deepseek-flash" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.catalog.contextWindow).toBe(1048576);
    expect(r.body.catalog.maxOutputTokens).toBe(393216);
    expect(r.body.catalog.reasoning.efforts).toEqual(["low", "high", "max"]);
    expect(r.body.capabilities).toMatchObject({ web_search: true, force_search: false, context_window: 1048576 });
  });

  it("退役别名可匹配到当前模型", async () => {
    const r = await verify({ type: "deepseek", api_key: "sk-test", model: "deepseek-v4-flash" });
    expect(r.body.ok).toBe(true);
    expect(r.body.resolvedModel).toBe("deepseek-flash");
  });

  it("鉴权失败给出明确原因", async () => {
    const r = await verify({ type: "deepseek", api_key: "bad", model: "deepseek-flash" });
    expect(r.body.ok).toBe(false);
    expect(r.body.errorKind).toBe("auth");
    expect(r.body.detail).toContain("鉴权失败");
  });

  it("模型不在列表时给出可用示例", async () => {
    const r = await verify({ type: "deepseek", api_key: "sk-test", model: "not-exist" });
    expect(r.body.ok).toBe(false);
    expect(r.body.errorKind).toBe("model");
    expect(r.body.availableModels).toContain("deepseek-flash");
  });

  it("缺少 Key 或模型时不放行", async () => {
    expect((await verify({ type: "deepseek", model: "deepseek-flash" })).body).toMatchObject({ ok: false, errorKind: "auth" });
    expect((await verify({ type: "deepseek", api_key: "sk-test", model: "   " })).status).toBe(400);
    expect((await verify({ type: "unknown", api_key: "sk-test", model: "x" })).status).toBe(400);
  });
});
