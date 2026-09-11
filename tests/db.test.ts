import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 用独立临时数据目录隔离 DB，避免污染本机真实数据。
let tmpDir: string;
let repo: typeof import("../src/server/repo.js");
let context: typeof import("../src/server/context.js");
let migrate: typeof import("../src/server/migrate.js");
let orchestrator: typeof import("../src/server/orchestrator.js");
let dbMod: typeof import("../src/server/db.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "kk-test-"));
  process.env.KNOW_KNOW_DATA_DIR = tmpDir;
  // 动态导入确保 env 生效后再初始化 DB 单例
  migrate = await import("../src/server/migrate.js");
  repo = await import("../src/server/repo.js");
  context = await import("../src/server/context.js");
  orchestrator = await import("../src/server/orchestrator.js");
  dbMod = await import("../src/server/db.js");
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

function makeConv(p: any) {
  const conv = repo.conversations.create(p, p.default_model, "off", "off");
  const main = repo.cards.createMain(conv.id);
  repo.viewState.upsert(conv.id, main.id, 0);
  return { conv, main };
}

function mkAnchor(convId: string, msgId: string, cardId: string, text: string): string {
  const a = repo.anchors.create({
    source_message_id: msgId,
    source_message_version: 1,
    card_id: cardId,
    conversation_id: convId,
    selected_text: text,
    start_offset: 0,
    end_offset: text.length,
    prefix: "",
    suffix: "",
  });
  return a.id;
}

describe("buildContext 顺序与隔离", () => {
  it("主卡片上下文 = 系统 + 自身消息", () => {
    const p = makeProvider();
    const { conv, main } = makeConv(p);
    repo.messages.create({ card_id: main.id, conversation_id: conv.id, role: "user", content: "你好", plaintext: "你好", status: "complete" });
    repo.messages.create({ card_id: main.id, conversation_id: conv.id, role: "assistant", content: "你好啊", plaintext: "你好啊", status: "complete" });
    const { messages } = context.buildContextWithIds(main, { systemPrompt: "SYS" });
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toBe("SYS");
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });

  it("分支卡片继承父卡片截至分叉点的上下文，且不含分叉后的新消息", () => {
    const p = makeProvider();
    const { conv, main } = makeConv(p);
    const u1 = repo.messages.create({ card_id: main.id, conversation_id: conv.id, role: "user", content: "问题1", plaintext: "问题1", status: "complete" });
    const a1 = repo.messages.create({ card_id: main.id, conversation_id: conv.id, role: "assistant", content: "回答1，关键概念在这里", plaintext: "回答1，关键概念在这里", status: "complete" });
    // 父卡片分叉后继续追加消息（不应进入子分支上下文）
    repo.messages.create({ card_id: main.id, conversation_id: conv.id, role: "user", content: "父分支后追问", plaintext: "父分支后追问", status: "complete" });

    // 先创建子卡片（initial_snapshot_id 暂占位，无 FK 约束），再构建快照后回填
    const anchorId = mkAnchor(conv.id, a1.id, main.id, "关键概念");
    const child = repo.cards.createBranch({ conversation_id: conv.id, parent_card_id: main.id, source_anchor_id: anchorId, initial_snapshot_id: "pending", title: "分支" });
    const { snapshot_id } = context.buildBranchSnapshot({
      conversation_id: conv.id,
      new_card_id: child.id,
      parent_card_id: main.id,
      source_message: a1,
      source_message_card: main,
      selected_text: "关键概念",
      selection_end_offset: 10,
    });
    const db = dbMod.getDb();
    db.prepare("UPDATE card SET initial_snapshot_id=? WHERE id=?").run(snapshot_id, child.id);
    repo.messages.create({ card_id: child.id, conversation_id: conv.id, role: "user", content: "子分支问题", plaintext: "子分支问题", status: "complete" });

    const childFresh = repo.cards.get(child.id)!;
    const { messages } = context.buildContextWithIds(childFresh, { systemPrompt: "SYS" });
    const contents = messages.map((m) => m.content);
    // 包含父卡片截至源回答的消息 + 子分支自身消息
    expect(contents).toContain("问题1");
    expect(contents).toContain("回答1，关键概念在这里");
    expect(contents).toContain("子分支问题");
    // 不含父分支分叉后追加的消息
    expect(contents).not.toContain("父分支后追问");
  });

  it("兄弟分支互不影响", () => {
    const p = makeProvider();
    const { conv, main } = makeConv(p);
    const u1 = repo.messages.create({ card_id: main.id, conversation_id: conv.id, role: "user", content: "Q", plaintext: "Q", status: "complete" });
    const a1 = repo.messages.create({ card_id: main.id, conversation_id: conv.id, role: "assistant", content: "A 含概念甲与概念乙", plaintext: "A 含概念甲与概念乙", status: "complete" });

    // 兄弟分支 A
    const anchorA = mkAnchor(conv.id, a1.id, main.id, "概念甲");
    const childA = repo.cards.createBranch({ conversation_id: conv.id, parent_card_id: main.id, source_anchor_id: anchorA, initial_snapshot_id: "pending", title: "A" });
    const snapA = context.buildBranchSnapshot({ conversation_id: conv.id, new_card_id: childA.id, parent_card_id: main.id, source_message: a1, source_message_card: main, selected_text: "概念甲", selection_end_offset: 8 });
    dbMod.getDb().prepare("UPDATE card SET initial_snapshot_id=? WHERE id=?").run(snapA.snapshot_id, childA.id);
    repo.messages.create({ card_id: childA.id, conversation_id: conv.id, role: "user", content: "A分支追问", plaintext: "A分支追问", status: "complete" });

    // 兄弟分支 B
    const anchorB = mkAnchor(conv.id, a1.id, main.id, "概念乙");
    const childB = repo.cards.createBranch({ conversation_id: conv.id, parent_card_id: main.id, source_anchor_id: anchorB, initial_snapshot_id: "pending", title: "B" });
    const snapB = context.buildBranchSnapshot({ conversation_id: conv.id, new_card_id: childB.id, parent_card_id: main.id, source_message: a1, source_message_card: main, selected_text: "概念乙", selection_end_offset: 12 });
    dbMod.getDb().prepare("UPDATE card SET initial_snapshot_id=? WHERE id=?").run(snapB.snapshot_id, childB.id);
    repo.messages.create({ card_id: childB.id, conversation_id: conv.id, role: "user", content: "B分支追问", plaintext: "B分支追问", status: "complete" });

    const ctxA = context.buildContextWithIds(repo.cards.get(childA.id)!, { systemPrompt: undefined }).messages.map((m) => m.content);
    const ctxB = context.buildContextWithIds(repo.cards.get(childB.id)!, { systemPrompt: undefined }).messages.map((m) => m.content);
    expect(ctxA).toContain("A分支追问");
    expect(ctxA).not.toContain("B分支追问");
    expect(ctxB).toContain("B分支追问");
    expect(ctxB).not.toContain("A分支追问");
  });
});

describe("幂等性", () => {
  it("相同卡片+相同内容返回同一 run（queued 状态命中）", async () => {
    const p = makeProvider();
    const { conv, main } = makeConv(p);
    const r1 = await orchestrator.sendMessage({ conversation_id: conv.id, card_id: main.id, content: "重复问题" });
    const r2 = await orchestrator.sendMessage({ conversation_id: conv.id, card_id: main.id, content: "重复问题" });
    expect(r1.run.id).toBe(r2.run.id);
  });

  it("不同内容返回不同 run", async () => {
    const p = makeProvider();
    const { conv, main } = makeConv(p);
    const r1 = await orchestrator.sendMessage({ conversation_id: conv.id, card_id: main.id, content: "问题A" });
    const r2 = await orchestrator.sendMessage({ conversation_id: conv.id, card_id: main.id, content: "问题B" });
    expect(r1.run.id).not.toBe(r2.run.id);
  });
});

describe("附件", () => {
  it("messages.create 携带 attachments 落盘并可读回", () => {
    const p = makeProvider();
    const { conv, main } = makeConv(p);
    const atts = [
      { id: "att-1", name: "图.png", mime: "image/png", size: 1024 },
      { id: "att-2", name: "笔记.md", mime: "text/markdown", size: 256 },
    ];
    const um = repo.messages.create({
      card_id: main.id,
      conversation_id: conv.id,
      role: "user",
      content: "看这个文件",
      plaintext: "看这个文件",
      status: "complete",
      attachments: atts,
    });
    expect(um.attachments).toEqual(atts);
    const list = repo.messages.listForCard(main.id);
    expect(list[0]!.attachments).toEqual(atts);
  });

  it("未传 attachments 时默认空数组（兼容旧消息）", () => {
    const p = makeProvider();
    const { conv, main } = makeConv(p);
    const um = repo.messages.create({
      card_id: main.id,
      conversation_id: conv.id,
      role: "user",
      content: "无附件",
      plaintext: "无附件",
      status: "complete",
    });
    expect(um.attachments).toEqual([]);
  });

  it("attachments.create 与 get 元数据读写", () => {
    const p = makeProvider();
    const { conv } = makeConv(p);
    repo.attachments.create({ id: "att-x", conversation_id: conv.id, name: "a.txt", mime: "text/plain", size: 10 });
    const got = repo.attachments.get("att-x");
    expect(got).toEqual({ id: "att-x", name: "a.txt", mime: "text/plain", size: 10 });
    expect(repo.attachments.get("不存在的id")).toBeNull();
  });
});
