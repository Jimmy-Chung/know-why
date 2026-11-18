import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let repo: typeof import("../src/server/repo.js");
let corpusMod: typeof import("../src/server/assistant-corpus.js");
let db: typeof import("../src/server/db.js");
const dataDir = mkdtempSync(join(tmpdir(), "kk-corpus-"));

beforeAll(async () => {
  process.env.KNOW_KNOW_DATA_DIR = dataDir;
  (await import("../src/server/migrate.js")).runMigrations();
  repo = await import("../src/server/repo.js");
  corpusMod = await import("../src/server/assistant-corpus.js");
  db = await import("../src/server/db.js");
});

afterAll(() => {
  db.closeDb();
  delete process.env.KNOW_KNOW_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

function setup() {
  const p = repo.providers.create({
    type: "custom",
    name: "t",
    api_base: "http://127.0.0.1:1/v1",
    default_model: "m",
    is_default: true,
    capabilities: { web_search: false, thinking: false, tool_calls: false, force_search: false, models: [], context_window: 1048576 },
    secret_ref: "",
    has_secret: false,
  });
  const conv = repo.conversations.create(p, "m", "off", "default");
  const main = repo.cards.createMain(conv.id);
  return { conv, main };
}

function msg(cardId: string, conversationId: string, role: "user" | "assistant", content: string, extra: any = {}) {
  return repo.messages.create({ card_id: cardId, conversation_id: conversationId, role, content, plaintext: content, status: "complete", ...extra });
}

function branch(conversationId: string, parentId: string, title: string) {
  return repo.cards.createBranch({ conversation_id: conversationId, parent_card_id: parentId, title, source_anchor_id: null as any, initial_snapshot_id: "pending" });
}

describe("全量会话语料", () => {
  it("按卡片树路径组织，并给每张卡一个编号", () => {
    const { conv, main } = setup();
    const sub = branch(conv.id, main.id, "联邦基金利率");
    msg(main.id, conv.id, "user", "长端利率和短端利率是什么关系？");
    msg(main.id, conv.id, "assistant", "短端由政策利率锚定。");
    msg(sub.id, conv.id, "user", "什么是利率走廊？");
    msg(sub.id, conv.id, "assistant", "利率走廊是央行管理短期利率的框架。");

    const corpus = corpusMod.buildConversationCorpus(conv.id, null, 100000);
    expect(corpus.truncated).toBe(false);
    expect(corpus.cardCount).toBe(2);
    expect(corpus.messageCount).toBe(4);
    expect(corpus.text).toContain("<目录>");
    expect(corpus.text).toContain("[1] 路径：主卡片");
    expect(corpus.text).toContain("[2] 路径：主卡片 > 联邦基金利率");
    expect(corpus.text).toContain("卡片ID：" + main.id);
    expect(corpus.text).toContain("用户问：长端利率和短端利率是什么关系？");
    expect(corpus.evidence).toHaveLength(2);
    expect(corpus.evidence[0]!.card_id).toBe(main.id);
    expect(corpus.evidence[0]!.excerpts).toHaveLength(2);
    expect(corpus.evidence[1]!.card_id).toBe(sub.id);
  });

  it("按 @ 作用域只收录指定卡片", () => {
    const { conv, main } = setup();
    const sub = branch(conv.id, main.id, "另一个分支");
    msg(main.id, conv.id, "assistant", "主卡片内容");
    msg(sub.id, conv.id, "assistant", "分支内容");

    const corpus = corpusMod.buildConversationCorpus(conv.id, [sub.id], 100000);
    expect(corpus.evidence.map((e) => e.card_id)).toEqual([sub.id]);
    expect(corpus.text).not.toContain("主卡片内容");
  });

  it("排除被标记不入库的消息与未完成消息", () => {
    const { conv, main } = setup();
    const kept = msg(main.id, conv.id, "assistant", "保留内容");
    const excluded = msg(main.id, conv.id, "assistant", "排除内容");
    repo.messages.setKnowledgeExcluded(excluded.id, true);
    repo.messages.create({ card_id: main.id, conversation_id: conv.id, role: "assistant", content: "生成中", plaintext: "生成中", status: "streaming" });

    const corpus = corpusMod.buildConversationCorpus(conv.id, null, 100000);
    expect(corpus.text).toContain("保留内容");
    expect(corpus.text).not.toContain("排除内容");
    expect(corpus.text).not.toContain("生成中");
    expect(corpus.evidence[0]!.message_id).toBe(kept.id);
  });

  it("超出预算时整体标记 truncated，不交出半截语料", () => {
    const { conv, main } = setup();
    msg(main.id, conv.id, "assistant", "长内容。".repeat(400));
    const corpus = corpusMod.buildConversationCorpus(conv.id, null, 100);
    expect(corpus.truncated).toBe(true);
    expect(corpus.evidence).toHaveLength(0);
  });
});

describe("全量语料请求", () => {
  it("目录在前、问题在后，证据与编号对齐", () => {
    const { conv, main } = setup();
    msg(main.id, conv.id, "user", "问题一");
    msg(main.id, conv.id, "assistant", "回答一");
    const corpus = corpusMod.buildConversationCorpus(conv.id, null, 100000);
    const built = corpusMod.buildCorpusRequest("我们聊过什么？", [], corpus, 1048576);
    expect(built).not.toBeNull();
    expect(built!.messages[0]!.role).toBe("system");
    const userMessage = built!.messages.at(-1)!;
    expect(userMessage.content).toContain("<会话资料>");
    expect(userMessage.content).toContain("我们聊过什么？");
    expect(userMessage.content.indexOf("<会话资料>")).toBeLessThan(userMessage.content.indexOf("我们聊过什么？"));
    expect(built!.evidence).toEqual(corpus.evidence);
  });

  it("窗口不足时返回 null，交给调用方退回检索", () => {
    const { conv, main } = setup();
    msg(main.id, conv.id, "assistant", "长内容。".repeat(2000));
    const corpus = corpusMod.buildConversationCorpus(conv.id, null, 100000);
    expect(corpusMod.buildCorpusRequest("问题", [], corpus, 2000)).toBeNull();
  });
});
