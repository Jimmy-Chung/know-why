import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";

let app: Hono;
let repo: typeof import("../src/server/repo.js");
let db: typeof import("../src/server/db.js");
const mockBase = "https://fixture.invalid/v1";
const dataDir = mkdtempSync(join(tmpdir(), "kk-explore-term-"));
async function call(path: string, method = "GET", body?: any) {
  const response = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as any };
}
beforeAll(async () => {
  vi.stubEnv("KNOW_KNOW_DATA_DIR", dataDir);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "m", reasoning: { supported_efforts: [], mandatory: false } }] });
    return Response.json({ choices: [{ message: { content: "解释" } }] });
  }));
  ({ app } = await import("../src/server/index.js"));
  repo = await import("../src/server/repo.js");
  db = await import("../src/server/db.js");
});
afterAll(() => {
  db.closeDb();
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("explore-term 路由", () => {
  it("从当前出处建新锚点+新卡，且首次 target 保持稳定", async () => {
    const p = (await call("/api/providers", "POST", { type: "openrouter", name: "fixture", default_model: "m", api_base: mockBase, is_default: true })).body;
    const d = (await call("/api/conversations", "POST")).body;
    const convId = d.conversation.id;
    const mainCardId = d.mainCard.id;

    // 造一条含术语的 user 消息作为源
    const sent = (await call(`/api/cards/${mainCardId}/messages`, "POST", { content: "请问 基准利率 是什么？" })).body;
    const srcMsg = sent.userMessage;

    // 第一次 Shift+点击：新建探索
    const r1 = (await call(`/api/conversations/${convId}/explore-term`, "POST", {
      message_id: srcMsg.id,
      card_id: mainCardId,
      selected_text: "基准利率",
      start_offset: 3,
      end_offset: 7,
    })).body;
    expect(r1.existing).toBe(false);
    expect(r1.card).toBeTruthy();
    expect(r1.card.parent_card_id).toBe(mainCardId);
    expect(r1.termLink.first_card_id).toBe(r1.card.id);
    const firstCardId = r1.card.id;
    const anchorOfFirst = repo.anchors.forMessage(srcMsg.id).find((a: any) => a.branch_card_id === firstCardId);
    expect(anchorOfFirst).toBeTruthy();

    // 第二次 Shift+点击同一术语：新建另一张卡，但首次 target 不变
    const r2 = (await call(`/api/conversations/${convId}/explore-term`, "POST", {
      message_id: srcMsg.id,
      card_id: mainCardId,
      selected_text: "基准利率",
      start_offset: 3,
      end_offset: 7,
    })).body;
    expect(r2.existing).toBe(false);
    expect(r2.card.id).not.toBe(firstCardId);
    expect(r2.termLink.first_card_id).toBe(firstCardId); // 首次不变

    const detail = (await call(`/api/conversations/${convId}`)).body;
    expect(detail.termLinks).toHaveLength(1);
    expect(detail.termLinks[0]).toMatchObject({ first_card_id: firstCardId, term_text: "基准利率" });
    // 两张探索卡都保留，未合并
    expect(detail.cards.length).toBe(3); // main + 2 探索
  });

  it("拒绝跨会话/出处不匹配的请求", async () => {
    const p = (await call("/api/providers", "POST", { type: "openrouter", name: "fixture2", default_model: "m", api_base: mockBase, is_default: true })).body;
    const a = (await call("/api/conversations", "POST")).body;
    const b = (await call("/api/conversations", "POST")).body;
    const sentA = (await call(`/api/cards/${a.mainCard.id}/messages`, "POST", { content: "甲讨论" })).body;
    // 用 B 会话的 convId，但传 A 会话的消息 → 拒绝
    const isolated = await call(`/api/conversations/${b.conversation.id}/explore-term`, "POST", {
      message_id: sentA.userMessage.id,
      card_id: a.mainCard.id,
      selected_text: "甲",
      start_offset: 0,
      end_offset: 1,
    });
    expect(isolated.status).toBe(400);
  });
});
