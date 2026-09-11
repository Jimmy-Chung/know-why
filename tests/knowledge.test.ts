import { describe, it, expect, beforeAll, vi } from "vitest";
import * as embeddingMod from "../src/server/embedding.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock embedding：避免下载真实模型。保留真实 BLOB 工具与模型常量，
// 仅替换 embed / embedQuery / embeddingAvailable 为确定性伪实现。
vi.mock("../src/server/embedding.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  // 伪向量：按关键词落到不同基底方向，模拟语义近邻
  function fakeVec(text: string): Float32Array {
    const v = new Float32Array(4);
    if (text.includes("光合")) {
      v[0] = 1;
      v[1] = 0.05;
    } else if (text.includes("植物") || text.includes("养分") || text.includes("制造养分")) {
      // 与「光合」方向相近，模拟语义相关
      v[0] = 0.9;
      v[1] = 0.4;
    } else if (text.includes("天气")) {
      v[2] = 1;
    } else {
      v[3] = 1;
    }
    const norm = Math.hypot(...Array.from(v)) || 1;
    for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
    return v;
  }
  return {
    ...actual,
    embeddingAvailable: async () => true,
    embed: async (texts: string[]) => texts.map((t) => fakeVec(t)),
    embedQuery: async (q: string) => fakeVec(q),
  };
});

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

  it("FTS 未命中时向量路召回语义相关消息", async () => {
    const { conv, main } = setupConv();
    // 答案只讲「光合作用...」，与查询「植物如何制造养分」无任何双字组重合 → FTS 必定漏
    const m1 = repo.messages.create({
      card_id: main.id,
      conversation_id: conv.id,
      role: "assistant",
      content: "光合作用是指生物利用光能将二氧化碳和水转化为有机物并释放氧气的过程。",
      plaintext: "光合作用是指生物利用光能将二氧化碳和水转化为有机物并释放氧气的过程。",
      status: "complete",
    });
    // 无关消息，向量方向正交
    const m2 = repo.messages.create({
      card_id: main.id,
      conversation_id: conv.id,
      role: "assistant",
      content: "今天天气很好适合出门散步。",
      plaintext: "今天天气很好适合出门散步。",
      status: "complete",
    });
    knowledge.indexConversation(conv.id);
    await knowledge.indexEmbeddings(conv.id);
    const cands = await knowledge.searchInSession(conv.id, "植物如何制造养分");
    const ids = cands.map((c) => c.messageId);
    expect(ids).toContain(m1.id);
    expect(ids).not.toContain(m2.id);
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
    await knowledge.indexEmbeddings(conv.id);
    // 查询同时命中 FTS（光合作用）与向量（光合）
    const cands = await knowledge.searchInSession(conv.id, "光合作用");
    const occ = cands.filter((c) => c.messageId === m.id).length;
    expect(occ).toBe(1);
  });
});

describe("searchInSession 自然问句（FTS OR 语义）", () => {
  // 回归「大立人的信息」类型问题：默认 AND 会因噪声双字组「人的」「的信」全挂。
  // 此组隔离向量路（embeddingAvailable 返回 false），只验 FTS 路的 OR 修复。
  beforeAll(() => {
    vi.spyOn(embeddingMod, "embeddingAvailable").mockResolvedValue(false);
  });

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
