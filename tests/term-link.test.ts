import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { termKey } from "../src/shared/term-key.js";

let repo: typeof import("../src/server/repo.js");
let db: ReturnType<typeof import("../src/server/db.js")["getDb"]>;
beforeAll(async () => {
  process.env.KNOW_KNOW_DATA_DIR = mkdtempSync(join(tmpdir(), "kk-termlink-"));
  (await import("../src/server/migrate.js")).runMigrations();
  repo = await import("../src/server/repo.js");
  db = (await import("../src/server/db.js")).getDb();
});

function setup() {
  const p = repo.providers.create({ type: "custom", name: "test", api_base: "http://127.0.0.1:1", default_model: "test", is_default: false, capabilities: { web_search: false, thinking: false, tool_calls: false, force_search: false, models: [], context_window: 32000 }, secret_ref: "", has_secret: false });
  const conv = repo.conversations.create(p, "test", "off", "default");
  return { conv };
}

describe("termKey 规范化", () => {
  it("统一 NFC、去首尾空白、小写", () => {
    expect(termKey("  基准利率  ")).toBe("基准利率");
    expect(termKey("GDP")).toBe("gdp");
    expect(termKey("　联邦基金利率　")).toBe("联邦基金利率"); // 全角空格也 trim 掉
    // NFC 组合（e + 尖音符 → é 单一码元）
    const composed = "café"; // é (U+00E9)
    const decomposed = "café"; // e + 组合尖音
    expect(termKey(decomposed)).toBe(termKey(composed));
  });

  it("findTermMatches：中文句中匹配、英文词边界、忽略大小写", async () => {
    const { findTermMatches } = await import("../src/shared/term-key.js");
    // 中文：句中多次
    expect(findTermMatches("基准利率上升，基准利率回落。", "基准利率").map((m) => m.start)).toEqual([0, 7]);
    // 英文词边界：不匹配子串
    expect(findTermMatches("apple apple pie", "app")).toEqual([]);
    expect(findTermMatches("app application app", "app")).toHaveLength(2);
    // 忽略大小写
    expect(findTermMatches("GDP growth GDP", "gdp")).toHaveLength(2);
  });
});

describe("termLinks 命名空间", () => {
  it("upsertFirst 只在首次写入，不覆盖已有首次目标", () => {
    const { conv } = setup();
    const a = repo.termLinks.upsertFirst({ conversation_id: conv.id, term_text: "基准利率", first_card_id: "cardA", first_anchor_id: "anchorA" });
    const b = repo.termLinks.upsertFirst({ conversation_id: conv.id, term_text: "基准利率", first_card_id: "cardB", first_anchor_id: "anchorB" });
    expect(a.first_card_id).toBe("cardA");
    // 第二次调用应返回同一行（首次不变）
    expect(b.first_card_id).toBe("cardA");
    expect(b.id).toBe(a.id);
    expect(repo.termLinks.listForConversation(conv.id)).toHaveLength(1);
  });

  it("隔离：不同会话不同术语不串", () => {
    const a = setup(), b = setup();
    repo.termLinks.upsertFirst({ conversation_id: a.conv.id, term_text: "X", first_card_id: "c1", first_anchor_id: null });
    repo.termLinks.upsertFirst({ conversation_id: b.conv.id, term_text: "X", first_card_id: "c2", first_anchor_id: null });
    expect(repo.termLinks.listForConversation(a.conv.id).map((t) => t.first_card_id)).toEqual(["c1"]);
    expect(repo.termLinks.listForConversation(b.conv.id).map((t) => t.first_card_id)).toEqual(["c2"]);
  });

  it("deleteStale 清掉 first_card 不存在的链接", () => {
    const { conv } = setup();
    const real = repo.cards.createMain(conv.id);
    repo.termLinks.upsertFirst({ conversation_id: conv.id, term_text: "存在卡", first_card_id: real.id, first_anchor_id: null });
    repo.termLinks.upsertFirst({ conversation_id: conv.id, term_text: "失效卡", first_card_id: "ghostCardId", first_anchor_id: null });
    const deleted = repo.termLinks.deleteStale(conv.id);
    expect(deleted).toBe(1);
    const remaining = repo.termLinks.listForConversation(conv.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.term_text).toBe("存在卡");
  });
});
