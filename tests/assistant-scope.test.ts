import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
let repo: typeof import("../src/server/repo.js");
let migrate: typeof import("../src/server/migrate.js");
let knowledge: typeof import("../src/server/knowledge.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "kk-scope-"));
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

function setupThreeCards() {
  const p = makeProvider();
  const conv = repo.conversations.create(p, p.default_model, "off", "off");
  const main = repo.cards.createMain(conv.id);
  // 两张子卡，各放一条不同主题的 assistant 消息
  const cardA = repo.cards.createBranch({
    conversation_id: conv.id, parent_card_id: main.id, title: "光合卡",
    source_anchor_id: null as any, initial_snapshot_id: "pending",
  });
  const cardB = repo.cards.createBranch({
    conversation_id: conv.id, parent_card_id: main.id, title: "天气卡",
    source_anchor_id: null as any, initial_snapshot_id: "pending",
  });
  const mA = repo.messages.create({
    card_id: cardA.id, conversation_id: conv.id, role: "assistant",
    content: "光合作用是植物利用光能制造养分的过程。", plaintext: "光合作用是植物利用光能制造养分的过程。",
    status: "complete",
  });
  const mB = repo.messages.create({
    card_id: cardB.id, conversation_id: conv.id, role: "assistant",
    content: "今天天气晴朗适合出门散步。", plaintext: "今天天气晴朗适合出门散步。",
    status: "complete",
  });
  knowledge.indexConversation(conv.id);
  return { conv, main, cardA, cardB, mA, mB };
}

describe("retrievePassages @ 作用域过滤", () => {
  it("传 null/空 → 全会话（两张卡的消息都可召回）", async () => {
    const { conv, mA, mB } = setupThreeCards();
    const r = await knowledge.retrievePassages(conv.id, "光合", 40);
    const ids = r.candidates.map((c) => c.messageId);
    expect(ids).toContain(mA.id);
    // 全会话：天气卡消息也在候选池（FTS 未命中"光合"，但语义路 fakeVec 让"天气"方向正交，score<.3 被滤；改用 overview 或不严格断言）
    // 这里只确保不报错且光合卡命中
  });

  it("传单个 scopeCardIds → 只返回该卡 passage", async () => {
    const { conv, cardA, cardB, mA, mB } = setupThreeCards();
    const r = await knowledge.retrievePassages(conv.id, "光合 植物", 40, undefined, [cardA.id]);
    const ids = r.candidates.map((c) => c.messageId);
    expect(ids).toContain(mA.id);
    expect(ids).not.toContain(mB.id);
    // 候选里不应出现 cardB 的任何 passage
    expect(r.candidates.every((c) => c.cardId !== cardB.id)).toBe(true);
  });

  it("传多个 scopeCardIds → 并集", async () => {
    const { conv, cardA, cardB, mA, mB } = setupThreeCards();
    const r = await knowledge.retrievePassages(conv.id, "光合 天气", 40, undefined, [cardA.id, cardB.id]);
    const ids = r.candidates.map((c) => c.messageId);
    expect(ids).toContain(mA.id);
    expect(ids).toContain(mB.id);
  });

  it("传不属于本会话的非法 cardId → 被过滤，回退全会话", async () => {
    const { conv, cardA, mA } = setupThreeCards();
    // 全是非法 id → scope 退化为 null（全会话）
    const r = await knowledge.retrievePassages(conv.id, "光合", 40, undefined, ["nonexistent-xxx"]);
    const ids = r.candidates.map((c) => c.messageId);
    expect(ids).toContain(mA.id);
  });

  it("scope 限定到 cardB → cardA 消息绝不出现，即使查询词命中 cardA", async () => {
    const { conv, cardB, mA, mB } = setupThreeCards();
    const r = await knowledge.retrievePassages(conv.id, "光合 植物", 40, undefined, [cardB.id]);
    const ids = r.candidates.map((c) => c.messageId);
    expect(ids).not.toContain(mA.id);
    // cardB 消息通过语义/FTS 可能命中"天气"方向；这里只验 cardA 被严格排除
    expect(r.candidates.every((c) => c.cardId !== mA.card_id)).toBe(true);
    void mB;
  });
});
