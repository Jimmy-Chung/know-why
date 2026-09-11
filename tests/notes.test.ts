import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let repo: typeof import("../src/server/repo.js");
let db: ReturnType<typeof import("../src/server/db.js")["getDb"]>;
beforeAll(async () => {
  process.env.KNOW_KNOW_DATA_DIR = mkdtempSync(join(tmpdir(), "kk-notes-"));
  (await import("../src/server/migrate.js")).runMigrations();
  repo = await import("../src/server/repo.js");
  db = (await import("../src/server/db.js")).getDb();
});

function setup() {
  const p = repo.providers.create({ type: "custom", name: "test", api_base: "http://127.0.0.1:1", default_model: "test", is_default: false, capabilities: { web_search: false, thinking: false, tool_calls: false, force_search: false, models: [], context_window: 32000 }, secret_ref: "", has_secret: false });
  const conv = repo.conversations.create(p, "test", "off", "default");
  return { conv };
}

describe("user note cards", () => {
  it("creates, lists (newest first) and reads a note", () => {
    const { conv } = setup();
    const a = repo.notes.create({ conversation_id: conv.id, title: "第一条", content_markdown: "# 标题\n内容" });
    repo.notes.create({ conversation_id: conv.id, title: "第二条", content_markdown: "其他" });
    const list = repo.notes.listForConversation(conv.id);
    expect(list.map((n) => n.id)).toEqual([expect.any(String), expect.any(String)]);
    expect(list[0]!.title).toBe("第二条");
    const got = repo.notes.get(a.id);
    expect(got).toMatchObject({ id: a.id, title: "第一条", content_markdown: "# 标题\n内容" });
  });

  it("updates title/content and bumps updated_at without touching other fields", () => {
    const { conv } = setup();
    const n = repo.notes.create({ conversation_id: conv.id, title: "旧标题", content_markdown: "旧正文" });
    const before = repo.notes.get(n.id)!;
    const updated = repo.notes.update(n.id, { title: "新标题", content_markdown: "**加粗**" })!;
    expect(updated.title).toBe("新标题");
    expect(updated.content_markdown).toBe("**加粗**");
    expect(new Date(updated.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(before.updated_at).getTime());
  });

  it("deletes a note and returns update null for a missing note", () => {
    const { conv } = setup();
    const n = repo.notes.create({ conversation_id: conv.id, title: "待删", content_markdown: "x" });
    repo.notes.delete(n.id);
    expect(repo.notes.get(n.id)).toBeNull();
    expect(repo.notes.update("nope", { title: "t" })).toBeNull();
    expect(repo.notes.listForConversation(conv.id)).toEqual([]);
  });

  it("deleteMany removes only the given ids and reports the count", () => {
    const { conv } = setup();
    const a = repo.notes.create({ conversation_id: conv.id, title: "批量删 A", content_markdown: "x" });
    const b = repo.notes.create({ conversation_id: conv.id, title: "批量删 B", content_markdown: "y" });
    const c = repo.notes.create({ conversation_id: conv.id, title: "保留 C", content_markdown: "z" });
    const deleted = repo.notes.deleteMany([a.id, b.id, "不存在的id"]);
    expect(deleted).toBe(2);
    expect(repo.notes.get(a.id)).toBeNull();
    expect(repo.notes.get(b.id)).toBeNull();
    expect(repo.notes.get(c.id)).not.toBeNull();
    expect(repo.notes.listForConversation(conv.id).map((n) => n.id)).toEqual([c.id]);
    // 空数组是安全 no-op
    expect(repo.notes.deleteMany([])).toBe(0);
  });

  it("isolates notes between conversations", () => {
    const a = setup(), b = setup();
    repo.notes.create({ conversation_id: a.conv.id, title: "A 的笔记", content_markdown: "x" });
    expect(repo.notes.listForConversation(a.conv.id)).toHaveLength(1);
    expect(repo.notes.listForConversation(b.conv.id)).toEqual([]);
  });

  it("purges notes together with the conversation", () => {
    const { conv } = setup();
    repo.notes.create({ conversation_id: conv.id, title: "将随会话删除", content_markdown: "y" });
    repo.conversations.purge(conv.id);
    expect(repo.notes.listForConversation(conv.id)).toEqual([]);
  });

  it("exports note_card via backup exportJson", async () => {
    const { exportJson } = await import("../src/server/backup.js");
    const { conv } = setup();
    repo.notes.create({ conversation_id: conv.id, title: "导出检查", content_markdown: "z" });
    const data = exportJson();
    const rows = data.tables.note_card as any[];
    expect(rows.some((r) => r.title === "导出检查")).toBe(true);
  });
});