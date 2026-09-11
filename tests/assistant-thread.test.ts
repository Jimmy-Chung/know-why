import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
let repo: typeof import("../src/server/repo.js");
let migrate: typeof import("../src/server/migrate.js");
let orchestrator: typeof import("../src/server/orchestrator.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "kk-thread-"));
  process.env.KNOW_KNOW_DATA_DIR = tmpDir;
  migrate = await import("../src/server/migrate.js");
  repo = await import("../src/server/repo.js");
  orchestrator = await import("../src/server/orchestrator.js");
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

describe("repo.assistant thread_id", () => {
  it("add 带 thread_id 落盘，list 返回带 thread_id", () => {
    const p = makeProvider();
    const { conv } = makeConv(p);
    repo.assistant.add({ conversation_id: conv.id, role: "user", content: "Q1", evidence: [], thread_id: "t1" });
    repo.assistant.add({ conversation_id: conv.id, role: "assistant", content: "A1", evidence: [], thread_id: "t1", run_id: null });
    repo.assistant.add({ conversation_id: conv.id, role: "user", content: "Q2", evidence: [], thread_id: "t2" });
    const list = repo.assistant.list(conv.id);
    expect(list).toHaveLength(3);
    expect(list.every((m) => "thread_id" in m)).toBe(true);
    expect(list.filter((m) => m.thread_id === "t1")).toHaveLength(2);
    expect(list.filter((m) => m.thread_id === "t2")).toHaveLength(1);
  });

  it("thread_id 省略时落盘为 null（兼容旧消息）", () => {
    const p = makeProvider();
    const { conv } = makeConv(p);
    repo.assistant.add({ conversation_id: conv.id, role: "user", content: "旧", evidence: [] });
    const list = repo.assistant.list(conv.id);
    expect(list[0]!.thread_id).toBeNull();
  });
});

describe("runAssistant 幂等按 thread 隔离", () => {
  it("同会话同问题不同 thread 返回不同 run", async () => {
    const p = makeProvider();
    const { conv, main } = makeConv(p);
    const r1 = await orchestrator.runAssistant({ conversation_id: conv.id, question: "大立人的信息", thread_id: "tA" });
    const r2 = await orchestrator.runAssistant({ conversation_id: conv.id, question: "大立人的信息", thread_id: "tB" });
    expect(r1.runId).not.toBe(r2.runId);
  });

  it("同会话同问题同 thread 返回同一 run（幂等命中）", async () => {
    const p = makeProvider();
    const { conv, main } = makeConv(p);
    const r1 = await orchestrator.runAssistant({ conversation_id: conv.id, question: "象牙是什么", thread_id: "tC" });
    const r2 = await orchestrator.runAssistant({ conversation_id: conv.id, question: "象牙是什么", thread_id: "tC" });
    expect(r1.runId).toBe(r2.runId);
  });
});