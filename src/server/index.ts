import { getModelCatalog, invalidateModelCache, reasoningProtocol, reasoningRequest } from "./model-capabilities.js";
import { normalizeThinkMode } from "../shared/reasoning.js";
// Know Know 本地服务入口。
// 只监听回环地址；校验请求来源；不含登录模块。
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { mkdirSync, existsSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
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
  assistantRunSnapshot,
  recoverStalledRuns,
  startRunWatchdog,
} from "./orchestrator.js";
import { defaultCapabilities, createAdapter, createSearchAdapter } from "./adapters/index.js";
import { setSecret, deleteSecret, maskSecret } from "./secret.js";
import { resolveAnchor, markdownToPlaintext, locateAnchor } from "./selection.js";
import { buildBranchSnapshot, buildContext, assistantSystemPrompt } from "./context.js";
import { indexConversation, indexEmbeddings, searchInSession, upsertTopic } from "./knowledge.js";
import { warmEmbeddings } from "./embedding.js";
import { ulid } from "../shared/ids.js";
import { backup, restore, exportJson } from "./backup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5179;

runMigrations();
recoverStalledRuns();
startRunWatchdog();

export const app = new Hono();

// 本地访问保护：只允许回环来源
app.use("*", async (c, next) => {
  const origin = c.req.header("Origin") || "";
  const host = c.req.header("Host") || "";
  // 允许无 Origin（同源/curl）或本地来源
  if (origin && !isLocalOrigin(origin, host)) {
    return c.json({ error: "拒绝非本地访问" }, 403);
  }
  // 允许本地跨域（开发模式前端 5180 直连后端 5179 的 SSE）
  if (origin) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Headers", "Content-Type");
    c.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  }
  if (c.req.method === "OPTIONS") return c.body(null, 204);
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
  // 仅传出现的字段，避免 undefined 覆盖现有值（如 capabilities）
  const patch: Record<string, any> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.api_base !== undefined) patch.api_base = body.api_base;
  if (body.default_model !== undefined) patch.default_model = body.default_model;
  if (body.is_default !== undefined) patch.is_default = body.is_default;
  if (body.capabilities !== undefined) patch.capabilities = body.capabilities;
  invalidateModelCache(id);
  const p = repo.providers.update(id, patch);
  return c.json(p);
});

app.put("/api/providers/:id/secret", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const p = repo.providers.get(id);
  if (!p) return c.json({ error: "not found" }, 404);
  if (body.key) {
    await setSecret(p.secret_ref, body.key);
    invalidateModelCache(id);
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

app.get("/api/providers/:id/models", async (c) => {
  const p = repo.providers.get(c.req.param("id"));
  if (!p) return c.json({ error: "Provider 不存在" }, 404);
  return c.json(await getModelCatalog(p, c.req.query("model") || p.default_model, c.req.query("refresh") === "1"));
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
  const conv = repo.conversations.create(def, def.default_model, "auto", "default");
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
  for (const card of allCards) {
    const msgs = repo.messages.listForCard(card.id);
    // 给 assistant 消息附上其 run 的联网搜索来源
    for (const m of msgs) {
      if (m.role === "assistant" && m.run_id) {
        (m as any).sources = repo.sources.forRun(m.run_id);
      }
    }
    messages[card.id] = msgs;
  }
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
  const termLinks = repo.termLinks.listForConversation(id);
  const assistant = repo.assistant.list(id);
  const notes = repo.notes.listForConversation(id);
  setImmediate(() => { void indexEmbeddings(id).catch(() => {}); });
  const view = repo.viewState.get(id);
  const provider = repo.providers.get(conv.provider_id);
  return c.json({
    conversation: conv,
    cards: allCards,
    messages,
    drafts,
    anchors: anchorList,
    termLinks,
    assistant,
    notes,
    view,
    provider,
  });
});

app.patch("/api/conversations/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const conv = repo.conversations.get(id);
  if (!conv) return c.json({ error: "not found" }, 404);
  const changesModel = body.model !== undefined || body.provider_id !== undefined;
  if (changesModel && conv.locked) return c.json({ error: "首条消息后不可切换 Provider 或模型" }, 409);
  const p = repo.providers.get(body.provider_id ?? conv.provider_id);
  if (!p) return c.json({ error: "Provider 不存在" }, 400);
  const model = body.model ?? (body.provider_id !== undefined ? p.default_model : conv.model);
  if (typeof model !== "string" || !model.trim()) return c.json({ error: "请选择模型" }, 400);
  if (body.web_mode !== undefined && !["off", "auto", "force"].includes(body.web_mode)) return c.json({ error: "无效联网模式" }, 400);
  if (changesModel) body.think_mode = "default";
  if (body.think_mode !== undefined) {
    const modes = ["default", "enabled", "none", "minimal", "low", "medium", "high", "xhigh", "max", "off", "standard", "deep"];
    if (!modes.includes(body.think_mode)) return c.json({ error: "无效推理设置" }, 400);
    body.think_mode = normalizeThinkMode(body.think_mode);
    if (body.think_mode !== "default") {
      const catalog = await getModelCatalog(p, model);
      try { reasoningRequest(body.think_mode, catalog.reasoning, reasoningProtocol(p)); }
      catch (e) { return c.json({ error: (e as Error).message }, 400); }
    }
  }
  // 能力读取可能等待网络；写入时重新检查锁定状态，防止与首次发送竞争。
  if (changesModel && repo.conversations.get(id)?.locked) return c.json({ error: "会话已锁定" }, 409);
  getDb().transaction(() => {
    if (changesModel) getDb().prepare("UPDATE conversation SET model=?, provider_id=?, provider_type=?, provider_config_version=?, updated_at=? WHERE id=?")
      .run(model, p.id, p.type, p.config_version, new Date().toISOString(), id);
    if (body.title !== undefined) repo.conversations.rename(id, body.title);
    repo.conversations.setSettings(id, { web_mode: body.web_mode, think_mode: body.think_mode });
  })();
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

// ---- 用户笔记卡片 ----
app.get("/api/conversations/:id/notes", (c) => {
  const conv = repo.conversations.get(c.req.param("id"));
  if (!conv) return c.json({ error: "会话不存在" }, 404);
  return c.json(repo.notes.listForConversation(c.req.param("id")));
});
app.post("/api/conversations/:id/notes", async (c) => {
  const conv = repo.conversations.get(c.req.param("id"));
  if (!conv) return c.json({ error: "会话不存在" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title : "";
  const content = typeof body.content_markdown === "string" ? body.content_markdown : "";
  if (!title.trim() && !content.trim()) return c.json({ error: "笔记内容为空" }, 400);
  return c.json(repo.notes.create({ conversation_id: c.req.param("id"), title, content_markdown: content }));
});
app.put("/api/notes/:noteId", async (c) => {
  const id = c.req.param("noteId");
  if (!repo.notes.get(id)) return c.json({ error: "笔记不存在" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const patch: { title?: string; content_markdown?: string } = {};
  if (typeof body.title === "string") patch.title = body.title;
  if (typeof body.content_markdown === "string") patch.content_markdown = body.content_markdown;
  if (!patch.title && !patch.content_markdown) return c.json({ error: "无更新内容" }, 400);
  return c.json(repo.notes.update(id, patch));
});
app.delete("/api/notes/:noteId", (c) => {
  repo.notes.delete(c.req.param("noteId"));
  return c.json({ ok: true });
});
app.post("/api/notes/batch-delete", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const raw = Array.isArray(body.ids) ? body.ids : [body.id];
  const ids = raw.filter((x: unknown): x is string => typeof x === "string" && x.length > 0);
  if (!ids.length) return c.json({ error: "没有要删除的笔记" }, 400);
  const deleted = repo.notes.deleteMany(ids);
  return c.json({ ok: true, deleted });
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
  // 旧选区探索也纳入术语注册表（首次 target 不变）
  repo.termLinks.upsertFirst({ conversation_id: convId, term_text: anchor.selected_text, first_card_id: card.id, first_anchor_id: anchor.id });

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

// 重新探索（Shift+点击）：从术语当前出现位置创建独立新探索，不强制先手动选词。
// body: { message_id, selected_text, start_offset, end_offset, card_id }（当前出处）
app.post("/api/conversations/:id/explore-term", async (c) => {
  const convId = c.req.param("id");
  const body = await c.req.json();
  const conv = repo.conversations.get(convId);
  if (!conv) return c.json({ error: "会话不存在" }, 404);
  const sourceMsg = repo.messages.get(body.message_id);
  const sourceCard = repo.cards.get(body.card_id);
  if (!sourceMsg || !sourceCard) return c.json({ error: "来源不存在" }, 404);
  // 校验 message/card 归属本会话
  if (sourceMsg.conversation_id !== convId || sourceCard.conversation_id !== convId) {
    return c.json({ error: "来源不属于本会话" }, 400);
  }
  if (sourceMsg.card_id !== sourceCard.id) return c.json({ error: "出处卡片不匹配" }, 400);
  const selectedText = typeof body.selected_text === "string" ? body.selected_text.trim() : "";
  if (!selectedText) return c.json({ error: "术语为空" }, 400);

  // 1) 在当前出处建新锚点（resolveAnchor 校验/修正偏移）
  const msgPlain = sourceMsg.plaintext || markdownToPlaintext(sourceMsg.content);
  const resolved = resolveAnchor(msgPlain, selectedText, body.start_offset, body.end_offset);
  const anchor = repo.anchors.create({
    source_message_id: sourceMsg.id,
    source_message_version: sourceMsg.version,
    card_id: sourceCard.id,
    conversation_id: convId,
    selected_text: selectedText,
    start_offset: resolved.start,
    end_offset: resolved.end,
    prefix: resolved.prefix,
    suffix: resolved.suffix,
  });

  // 2) 建新探索卡片，挂在当前出处卡片下
  const title = selectedText.slice(0, 24) || "探索分支";
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
    selected_text: selectedText,
    selection_end_offset: resolved.end,
  });
  getDb().prepare("UPDATE card SET initial_snapshot_id=? WHERE id=?").run(snapshot_id, card.id);
  repo.anchors.setBranch(anchor.id, card.id);
  upsertTopic(convId, title, card.id, [selectedText]);
  // 首次 target 在本会话内保持稳定（不会因重新探索改指向新卡）
  const termLink = repo.termLinks.upsertFirst({
    conversation_id: convId,
    term_text: selectedText,
    first_card_id: card.id,
    first_anchor_id: anchor.id,
  });

  // 触发首轮解释：新文案不预设原解释错误
  const result = await sendMessage({
    conversation_id: convId,
    card_id: card.id,
    content: "",
    branch_prompt: `请结合当前分支的上下文，解释「${selectedText}」的背景与含义。`,
    purpose: "branch",
  });
  return c.json({ card: repo.cards.get(card.id), run: result.run, existing: false, termLink });
});

// 清理失效术语链接（首次卡片已被删除时）。返回清理数量。
app.post("/api/conversations/:id/term-links/clean-stale", (c) => {
  const convId = c.req.param("id");
  const conv = repo.conversations.get(convId);
  if (!conv) return c.json({ error: "会话不存在" }, 404);
  const deleted = repo.termLinks.deleteStale(convId);
  return c.json({ ok: true, deleted });
});

// ---- 消息发送 ----
app.patch("/api/messages/:id/knowledge", async (c) => {
  const message = repo.messages.get(c.req.param("id"));
  const conv = message && repo.conversations.get(message.conversation_id);
  if (!message || !conv || conv.deleted_at) return c.json({ error: "消息不存在" }, 404);
  const body = await c.req.json().catch(() => null);
  if (typeof body?.excluded !== "boolean") return c.json({ error: "excluded 必须是布尔值" }, 400);
  if (message.role !== "assistant" || message.status !== "complete") return c.json({ error: "仅支持已完成的回答" }, 400);
  repo.messages.setKnowledgeExcluded(message.id, body.excluded);
  indexConversation(message.conversation_id);
  return c.json(repo.messages.get(message.id));
});

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
    attachments: Array.isArray(body.attachments) ? body.attachments : [],
  });
  return c.json({ userMessage: result.userMessage, run: result.run });
});

// ---- 附件上传/下载 ----
// 上传：multipart/form-data，字段名 file；落盘到数据目录 attachments/<id>
app.post("/api/conversations/:id/attachments", async (c) => {
  const convId = c.req.param("id");
  const conv = repo.conversations.get(convId);
  if (!conv) return c.json({ error: "会话不存在" }, 404);
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "需要 multipart/form-data 上传" }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "未提供文件" }, 400);
  // 限制 20MB
  if (file.size > 20 * 1024 * 1024) return c.json({ error: "文件过大（上限 20MB）" }, 413);
  const id = ulid();
  const name = file.name || "attachment";
  const mime = file.type || "application/octet-stream";
  const buf = Buffer.from(await file.arrayBuffer());
  const dir = join(getDataDir(), "attachments");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, id), buf);
  const meta = repo.attachments.create({ id, conversation_id: convId, name, mime, size: file.size });
  return c.json({ ...meta, url: `/api/attachments/${id}` });
});

// 下载：按 id 取附件本体，inline 展示（图片等）或下载
app.get("/api/attachments/:id", (c) => {
  const id = c.req.param("id");
  const meta = repo.attachments.get(id);
  if (!meta) return c.json({ error: "附件不存在" }, 404);
  const path = join(getDataDir(), "attachments", id);
  if (!existsSync(path)) return c.json({ error: "文件已丢失" }, 404);
  c.header("Content-Type", meta.mime);
  c.header("Content-Length", String(statSync(path).size));
  // 文本/图片等可内联展示，其它强制下载并带原文件名
  const inline = /^(image|text|audio|video)\//.test(meta.mime) || meta.mime === "application/pdf";
  c.header("Content-Disposition", inline ? "inline" : `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
  return c.body(readFileSync(path));
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

    const wake = () => {
      const r = resolveWait;
      resolveWait = null;
      if (r) r();
    };

    const unsub = subscribe(runId, (e) => {
      queue.push(e);
      wake();
    });

    // 发送已落盘的初始状态（如重连）
    const dbRun = repo.runs.get(runId);
    const answer = run.purpose === "assistant" ? assistantRunSnapshot(runId) : undefined;
    if (dbRun) await stream.writeSSE({ event: "run", data: JSON.stringify({ type: "run", run: dbRun }) });
    if (answer) await stream.writeSSE({event:"assistant_message",data:JSON.stringify({type:"assistant_message",message:answer})});
    // chat 中途重连：把当前流式中的 assistant 消息内容发过去，后续 deltas 续上，
    // 避免 run 在创建时即启动（无 SSE 依赖）后，早期 message 事件被丢弃导致回答"丢失"。
    if (run.purpose !== "assistant" && dbRun && !["completed", "stopped", "failed"].includes(dbRun.status) && dbRun.message_id) {
      const streamMsg = repo.messages.get(dbRun.message_id);
      if (streamMsg && streamMsg.status === "streaming") {
        await stream.writeSSE({ event: "message", data: JSON.stringify({ type: "message", message: streamMsg }) });
      }
    }
    if (dbRun && ["completed","stopped","failed"].includes(dbRun.status)) {
      const event = dbRun.status === "failed" ? {type:"error",run_id:runId,message:dbRun.error || "运行失败",run:dbRun}
        : {type:"done",run_id:runId,message:dbRun.message_id ? repo.messages.get(dbRun.message_id) : null,run:dbRun};
      await stream.writeSSE({event:event.type,data:JSON.stringify(event)});
      unsub();
      return;
    }
    if (run.purpose === "assistant") startAssistantRunIfPending(runId);
    else startRunIfPending(runId);
    stream.onAbort(() => { closed = true; wake(); });


    try {
      while (!closed) {
        // 清空当前队列
        while (queue.length) {
          const e = queue.shift();
          await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
          if (e.type === "done" || e.type === "error") {
            closed = true;
            break;
          }
        }
        if (closed) break;
        // 队列空，等待新事件；带超时兜底以防丢失唤醒
        await new Promise<void>((res) => {
          resolveWait = res;
          setTimeout(wake, 500);
        });
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
  const r = await runAssistant({ conversation_id: c.req.param("id"), question: body.question, thread_id: body.thread_id ?? null, quote: body.quote ?? null, scope_card_ids: Array.isArray(body.scope_card_ids) ? body.scope_card_ids : null, idempotency_key: body.idempotency_key });
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
  warmEmbeddings();
  console.log(`Know Know 本地服务：http://127.0.0.1:${info.port}`);
  console.log(`数据目录：${getDataDir()}`);
});
