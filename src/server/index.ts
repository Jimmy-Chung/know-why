// Know Know 本地服务入口。
// 只监听回环地址；校验请求来源；不含登录模块。
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { mkdirSync, existsSync, createReadStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./migrate.js";
import { getDb, getDataDir } from "./db.js";
import * as repo from "./repo.js";
import {
  sendMessage,
  startRunIfPending,
  stopRun,
  retryRun,
  runAssistant,
  startAssistantRunIfPending,
  subscribe,
} from "./orchestrator.js";
import { defaultCapabilities, createAdapter, createSearchAdapter } from "./adapters/index.js";
import { setSecret, deleteSecret, maskSecret } from "./secret.js";
import { resolveAnchor, markdownToPlaintext, locateAnchor } from "./selection.js";
import { buildBranchSnapshot, buildContext, assistantSystemPrompt } from "./context.js";
import { indexConversation, searchInSession, upsertTopic } from "./knowledge.js";
import { ulid } from "../shared/ids.js";
import { backup, restore, exportJson } from "./backup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5179;

runMigrations();

const app = new Hono();

// 本地访问保护：只允许回环来源
app.use("*", async (c, next) => {
  const origin = c.req.header("Origin") || "";
  const host = c.req.header("Host") || "";
  // 允许无 Origin（同源/curl）或本地来源
  if (origin && !isLocalOrigin(origin, host)) {
    return c.json({ error: "拒绝非本地访问" }, 403);
  }
  await next();
});

function isLocalOrigin(origin: string, host: string): boolean {
  try {
    const u = new URL(origin);
    return (
      u.hostname === "127.0.0.1" ||
      u.hostname === "localhost" ||
      u.hostname === "0.0.0.0"
    );
  } catch {
    return false;
  }
}

// ---- Provider ----
app.get("/api/providers", (c) => c.json(repo.providers.list()));

app.post("/api/providers", async (c) => {
  const body = await c.req.json();
  const type = body.type;
  const name = body.name || "Provider";
  const p = repo.providers.create({
    type,
    name,
    api_base: body.api_base || "",
    default_model: body.default_model || "",
    is_default: !!body.is_default,
    capabilities: body.capabilities || defaultCapabilities(type),
    secret_ref: `provider:${ulid()}`,
    has_secret: false,
  });
  return c.json(p);
});

app.patch("/api/providers/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const p = repo.providers.update(id, {
    name: body.name,
    api_base: body.api_base,
    default_model: body.default_model,
    is_default: body.is_default,
    capabilities: body.capabilities,
  });
  return c.json(p);
});

app.put("/api/providers/:id/secret", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const p = repo.providers.get(id);
  if (!p) return c.json({ error: "not found" }, 404);
  if (body.key) {
    await setSecret(p.secret_ref, body.key);
    repo.providers.update(id, { has_secret: true });
  }
  return c.json({ ok: true });
});

app.delete("/api/providers/:id", async (c) => {
  const id = c.req.param("id");
  const p = repo.providers.get(id);
  if (p) await deleteSecret(p.secret_ref);
  repo.providers.disable(id);
  return c.json({ ok: true });
});

app.post("/api/providers/:id/default", (c) => {
  repo.providers.setDefault(c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/api/providers/:id/test", async (c) => {
  const p = repo.providers.get(c.req.param("id"));
  if (!p) return c.json({ ok: false, detail: "Provider 不存在" }, 404);
  const adapter = await createAdapter(p);
  const r = await adapter.testConnection();
  return c.json(r);
});

// ---- 搜索配置 ----
app.get("/api/search", (c) => c.json(repo.search.get()));

app.put("/api/search", async (c) => {
  const body = await c.req.json();
  const cfg = repo.search.upsert({
    provider: "tavily",
    api_base: body.api_base || "",
    has_secret: !!body.has_secret,
    secret_ref: "search:tavily",
    enabled: body.enabled !== false,
  });
  return c.json(cfg);
});

app.put("/api/search/secret", async (c) => {
  const body = await c.req.json();
  if (body.key) {
    await setSecret("search:tavily", body.key);
    repo.search.upsert({ provider: "tavily", api_base: body.api_base || "", has_secret: true, secret_ref: "search:tavily", enabled: true });
  }
  return c.json({ ok: true });
});

app.post("/api/search/test", async (c) => {
  const adapter = await createSearchAdapter();
  if (!adapter) return c.json({ ok: false, detail: "未配置独立搜索或缺少凭据" });
  return c.json(await adapter.testConnection());
});

// ---- 会话 ----
app.get("/api/conversations", (c) => c.json(repo.conversations.list()));
app.get("/api/conversations/deleted", (c) => c.json(repo.conversations.deleted()));

app.post("/api/conversations", (c) => {
  const def = repo.providers.defaultProvider();
  if (!def) return c.json({ error: "请先配置 Provider" }, 400);
  const conv = repo.conversations.create(def, def.default_model, "off", "off");
  const main = repo.cards.createMain(conv.id);
  repo.viewState.upsert(conv.id, main.id, 0);
  return c.json({ conversation: repo.conversations.get(conv.id), mainCard: main });
});

app.get("/api/conversations/:id", (c) => {
  const id = c.req.param("id");
  const conv = repo.conversations.get(id);
  if (!conv) return c.json({ error: "not found" }, 404);
  const allCards = repo.cards.listForConversation(id);
  const messages: Record<string, any[]> = {};
  for (const card of allCards) messages[card.id] = repo.messages.listForCard(card.id);
  const drafts: Record<string, any> = {};
  for (const card of allCards) {
    const d = repo.drafts.get(card.id);
    if (d) drafts[card.id] = d;
  }
  const anchors = repo.anchors; // 用于前端还原选区入口
  const anchorList: any[] = [];
  for (const card of allCards) {
    for (const m of messages[card.id] || []) {
      for (const a of repo.anchors.forMessage(m.id)) anchorList.push(a);
    }
  }
  const assistant = repo.assistant.list(id);
  const view = repo.viewState.get(id);
  const provider = repo.providers.get(conv.provider_id);
  return c.json({
    conversation: conv,
    cards: allCards,
    messages,
    drafts,
    anchors: anchorList,
    assistant,
    view,
    provider,
  });
});

app.patch("/api/conversations/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const conv = repo.conversations.get(id);
  if (!conv) return c.json({ error: "not found" }, 404);
  // 首条消息前可切换模型；锁定后不允许
  if (body.model !== undefined && !conv.locked) {
    getDb().prepare("UPDATE conversation SET model=?, updated_at=? WHERE id=?").run(body.model, new Date().toISOString(), id);
  }
  if (body.provider_id !== undefined && !conv.locked) {
    const p = repo.providers.get(body.provider_id);
    if (p) {
      getDb().prepare("UPDATE conversation SET provider_id=?, provider_type=?, provider_config_version=?, updated_at=? WHERE id=?").run(p.id, p.type, p.config_version, new Date().toISOString(), id);
    }
  }
  if (body.title !== undefined) repo.conversations.rename(id, body.title);
  if (body.web_mode !== undefined || body.think_mode !== undefined) {
    repo.conversations.setSettings(id, { web_mode: body.web_mode, think_mode: body.think_mode });
  }
  return c.json(repo.conversations.get(id));
});

app.delete("/api/conversations/:id", (c) => {
  repo.conversations.softDelete(c.req.param("id"));
  return c.json({ ok: true });
});
app.post("/api/conversations/:id/restore", (c) => {
  repo.conversations.restore(c.req.param("id"));
  return c.json({ ok: true });
});
app.delete("/api/conversations/:id/purge", (c) => {
  repo.conversations.purge(c.req.param("id"));
  return c.json({ ok: true });
});

// ---- 卡片与选区 ----
app.post("/api/conversations/:id/anchors", async (c) => {
  const convId = c.req.param("id");
  const body = await c.req.json();
  const msg = repo.messages.get(body.source_message_id);
  if (!msg) return c.json({ error: "源消息不存在" }, 404);
  const resolved = resolveAnchor(msg.plaintext || markdownToPlaintext(msg.content), body.selected_text, body.start_offset, body.end_offset);
  const anchor = repo.anchors.create({
    source_message_id: msg.id,
    source_message_version: msg.version,
    card_id: msg.card_id,
    conversation_id: convId,
    selected_text: body.selected_text,
    start_offset: resolved.start,
    end_offset: resolved.end,
    prefix: resolved.prefix,
    suffix: resolved.suffix,
  });
  return c.json(anchor);
});

// 探索：创建子卡片 + 快照 + 触发首轮解释
app.post("/api/conversations/:id/explore", async (c) => {
  const convId = c.req.param("id");
  const body = await c.req.json();
  const conv = repo.conversations.get(convId);
  if (!conv) return c.json({ error: "会话不存在" }, 404);
  const anchor = repo.anchors.get(body.anchor_id);
  if (!anchor) return c.json({ error: "锚点不存在" }, 404);
  if (anchor.branch_card_id) {
    // 已有分支：返回已有卡片（不覆盖）
    return c.json({ card: repo.cards.get(anchor.branch_card_id), existing: true });
  }
  const sourceMsg = repo.messages.get(anchor.source_message_id);
  const sourceCard = repo.cards.get(anchor.card_id);
  if (!sourceMsg || !sourceCard) return c.json({ error: "来源不存在" }, 404);

  const title = anchor.selected_text.slice(0, 24) || "探索分支";
  const card = repo.cards.createBranch({
    conversation_id: convId,
    parent_card_id: sourceCard.id,
    source_anchor_id: anchor.id,
    initial_snapshot_id: "pending",
    title,
  });
  const { snapshot_id } = buildBranchSnapshot({
    conversation_id: convId,
    new_card_id: card.id,
    parent_card_id: sourceCard.id,
    source_message: sourceMsg,
    source_message_card: sourceCard,
    selected_text: anchor.selected_text,
    selection_end_offset: anchor.end_offset,
  });
  getDb().prepare("UPDATE card SET initial_snapshot_id=? WHERE id=?").run(snapshot_id, card.id);
  repo.anchors.setBranch(anchor.id, card.id);
  upsertTopic(convId, title, card.id, [anchor.selected_text]);

  // 触发首轮解释：作为该卡片首条用户消息
  const result = await sendMessage({
    conversation_id: convId,
    card_id: card.id,
    content: "",
    branch_prompt: `请解释：「${anchor.selected_text}」的背景与含义。`,
    purpose: "branch",
  });
  return c.json({ card: repo.cards.get(card.id), run: result.run, existing: false });
});

// ---- 消息发送 ----
app.post("/api/cards/:id/messages", async (c) => {
  const cardId = c.req.param("id");
  const card = repo.cards.get(cardId);
  if (!card) return c.json({ error: "卡片不存在" }, 404);
  const body = await c.req.json();
  const conv = repo.conversations.get(card.conversation_id);
  if (!conv) return c.json({ error: "会话不存在" }, 404);
  if (body.content && !body.content.trim()) {
    return c.json({ error: "消息内容为空（本地校验失败）" }, 400);
  }
  const result = await sendMessage({
    conversation_id: conv.id,
    card_id: cardId,
    content: body.content || "",
    quote_anchor_id: body.quote_anchor_id || null,
  });
  return c.json({ userMessage: result.userMessage, run: result.run });
});

// ---- Run SSE ----
app.get("/api/runs/:id/stream", (c) => {
  const runId = c.req.param("id");
  const run = repo.runs.get(runId);
  if (!run) return c.json({ error: "run 不存在" }, 404);
  return streamSSE(c, async (stream) => {
    let closed = false;
    const queue: any[] = [];
    let resolveWait: (() => void) | null = null;

    const unsub = subscribe(runId, (e) => {
      queue.push(e);
      if (resolveWait) {
        resolveWait();
        resolveWait = null;
      }
    });

    // 触发执行
    if (run.purpose === "assistant") startAssistantRunIfPending(runId);
    else startRunIfPending(runId);

    // 发送已落盘的初始状态（如重连）
    const dbRun = repo.runs.get(runId);
    if (dbRun) await stream.writeSSE({ event: "run", data: JSON.stringify({ type: "run", run: dbRun }) });

    try {
      while (!closed) {
        if (!queue.length) {
          await new Promise<void>((res) => {
            resolveWait = res;
            setTimeout(() => {
              if (resolveWait) {
                resolveWait = null;
                res();
              }
            }, 500);
          });
        }
        while (queue.length) {
          const e = queue.shift();
          await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
          if (e.type === "done" || e.type === "error") {
            closed = true;
            break;
          }
        }
      }
    } finally {
      unsub();
    }
  });
});

app.post("/api/runs/:id/stop", (c) => {
  const ok = stopRun(c.req.param("id"));
  return c.json({ ok });
});

app.post("/api/runs/:id/retry", async (c) => {
  const run = await retryRun(c.req.param("id"));
  return c.json({ run });
});

// ---- 草稿与视图状态 ----
app.put("/api/cards/:id/draft", async (c) => {
  const body = await c.req.json();
  repo.drafts.upsert(c.req.param("id"), body.text || "", body.pending_quote_anchor_id || null);
  return c.json({ ok: true });
});

app.put("/api/conversations/:id/viewstate", async (c) => {
  const body = await c.req.json();
  repo.viewState.upsert(c.req.param("id"), body.current_card_id, body.scroll_position || 0);
  return c.json({ ok: true });
});

// ---- 知识助手 ----
app.get("/api/conversations/:id/assistant", (c) => c.json(repo.assistant.list(c.req.param("id"))));

app.post("/api/conversations/:id/assistant", async (c) => {
  const body = await c.req.json();
  const r = await runAssistant({ conversation_id: c.req.param("id"), question: body.question });
  return c.json(r);
});

// ---- 备份与导出 ----
app.post("/api/backup", async (c) => c.json(await backup()));
app.get("/api/export", (c) => c.json(exportJson()));
app.post("/api/restore", async (c) => {
  const body = await c.req.json();
  return c.json(restore(body));
});

// ---- 健康检查 ----
app.get("/api/health", (c) => c.json({ ok: true, dataDir: getDataDir() }));

// ---- 静态资源（生产）----
const clientDist = join(__dirname, "..", "..", "dist-client");
if (existsSync(clientDist)) {
  app.use("/*", serveStatic({ root: join(__dirname, "..", "..", "dist-client") }));
}

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
  console.log(`Know Know 本地服务：http://127.0.0.1:${info.port}`);
  console.log(`数据目录：${getDataDir()}`);
});
