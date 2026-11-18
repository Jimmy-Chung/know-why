import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
let repo: typeof import("../src/server/repo.js");
let migrate: typeof import("../src/server/migrate.js");
let knowledge: typeof import("../src/server/knowledge.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "kk-kn-"));
  process.env.KNOW_KNOW_DATA_DIR = tmpDir;
  migrate = await import("../src/server/migrate.js");
  repo = await import("../src/server/repo.js");
  knowledge = await import("../src/server/knowledge.js");
  migrate.runMigrations();
});

function makeProvider() {
  return repo.providers.create({
    type: "custom",
    name: "T",
    api_base: "http://127.0.0.1:1/v1",
    default_model: "m",
    is_default: true,
    capabilities: { web_search: false, thinking: false, tool_calls: false, force_search: false, models: ["m"], context_window: 32000 },
    secret_ref: "provider:test",
    has_secret: false,
  });
}

function setupConv() {
  const p = makeProvider();
  const conv = repo.conversations.create(p, p.default_model, "off", "off");
  const main = repo.cards.createMain(conv.id);
  return { conv, main };
}

describe("searchInSession 混合检索", () => {
  it("FTS 命中时返回词匹配结果", async () => {
    const { conv, main } = setupConv();
    const m = repo.messages.create({
      card_id: main.id,
      conversation_id: conv.id,
      role: "assistant",
      content: "光合作用是重要的生物化学过程。",
      plaintext: "光合作用是重要的生物化学过程。",
      status: "complete",
    });
    knowledge.indexConversation(conv.id);
    const cands = await knowledge.searchInSession(conv.id, "光合作用");
    expect(cands.map((c) => c.messageId)).toContain(m.id);
  });

  it("去重：同一条消息不被多路重复召回", async () => {
    const { conv, main } = setupConv();
    const m = repo.messages.create({
      card_id: main.id,
      conversation_id: conv.id,
      role: "assistant",
      content: "光合作用相关内容。",
      plaintext: "光合作用相关内容。",
      status: "complete",
    });
    knowledge.indexConversation(conv.id);
    // 查询同时命中 FTS（光合作用）与向量（光合）
    const cands = await knowledge.searchInSession(conv.id, "光合作用");
    const occ = cands.filter((c) => c.messageId === m.id).length;
    expect(occ).toBe(1);
  });
});

describe("searchInSession 自然问句（FTS OR 语义）", () => {
  it("自然问句含噪声双字组仍能召回核心关键词命中的消息", async () => {
    const { conv, main } = setupConv();
    const m = repo.messages.create({
      card_id: main.id,
      conversation_id: conv.id,
      role: "assistant",
      content: "青铜大立人像是三星堆最核心的镇坑之宝之一。",
      plaintext: "青铜大立人像是三星堆最核心的镇坑之宝之一。",
      status: "complete",
    });
    knowledge.indexConversation(conv.id);
    // 「大立人的信息」切出「大立 立人 人的 的信 信息」——AND 全挂，OR 能命中
    const cands = await knowledge.searchInSession(conv.id, "大立人的信息");
    expect(cands.map((c) => c.messageId)).toContain(m.id);
  });
});
