// 运行编排器：管理一次生成的完整生命周期。
// 职责：创建用户消息+run、锁定会话、构建上下文、决定搜索策略、
// 流式输出并增量落盘、停止/失败/重试的明确状态、来源保存、知识助手执行。
import { ulid } from "../shared/ids.js";
import type {
  Conversation,
  Card,
  Message,
  Run,
  Source,
  WebMode,
  ProviderType,
  RunStatus,
} from "../shared/types.js";
import type { SSEEvent } from "../shared/types.js";
import * as repo from "./repo.js";
import { createAdapter, createSearchAdapter } from "./adapters/index.js";
import type { Adapter, StreamEvent, SearchResultItem } from "./adapters/types.js";
import { AdapterError } from "./adapters/types.js";
import { buildContext, buildContextWithIds, assistantSystemPrompt, defaultSystemPrompt } from "./context.js";
import { maybeCompressContext } from "./summary.js";
import { completeChat, parseQueryPlan, type QueryPlan } from "./complete.js";
import { markdownToPlaintext } from "./selection.js";
import { indexConversation } from "./knowledge.js";

// 每个 run 的事件订阅器
type Listener = (e: SSEEvent) => void;
const runListeners = new Map<string, Set<Listener>>();
const activeControllers = new Map<string, AbortController>();

export function subscribe(runId: string, fn: Listener): () => void {
  let set = runListeners.get(runId);
  if (!set) {
    set = new Set();
    runListeners.set(runId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) runListeners.delete(runId);
  };
}

function emit(runId: string, e: SSEEvent) {
  const set = runListeners.get(runId);
  if (set) for (const fn of set) fn(e);
}

// 幂等键：同一卡片+同一用户消息内容哈希
function idemKey(cardId: string, purpose: string, payload: string): string {
  return `${cardId}:${purpose}:${hash(payload)}`;
}
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export interface SendResult {
  conversation: Conversation;
  card: Card;
  userMessage: Message;
  run: Run;
}

// 发送一条用户消息并启动生成
export async function sendMessage(params: {
  conversation_id: string;
  card_id: string;
  content: string;
  quote_anchor_id?: string | null;
  purpose?: "chat" | "branch";
  // 分支首轮：自动用选区文本作为初始问题
  branch_prompt?: string;
}): Promise<SendResult> {
  const conv = repo.conversations.get(params.conversation_id);
  if (!conv) throw new Error("会话不存在");
  const card = repo.cards.get(params.card_id);
  if (!card) throw new Error("卡片不存在");
  const provider = repo.providers.get(conv.provider_id);
  if (!provider) throw new Error("Provider 不可用");

  const content = params.content.trim();
  if (!content && !params.branch_prompt) throw new Error("消息内容为空（本地校验失败）");

  // 幂等：相同请求不重复
  const payload = params.branch_prompt ? `BR:${params.branch_prompt}` : content;
  const idem = idemKey(params.card_id, "chat", payload + (params.quote_anchor_id || ""));
  const existing = repo.runs.getByIdem(idem);
  if (existing && existing.status !== "failed") {
    // 幂等命中：复用该 run，并从 card 中找到关联的用户消息
    const ownMsgs = repo.messages.listForCard(card.id);
    const um = [...ownMsgs].reverse().find((m) => m.role === "user");
    if (um) return { conversation: conv, card, userMessage: um, run: existing };
    // 若找不到用户消息（异常），允许创建新的
  }

  // 事务：写用户消息 + 创建 run + 锁定会话
  const { userMessage, run } = repo.transaction(() => {
    const um = repo.messages.create({
      card_id: card.id,
      conversation_id: conv.id,
      role: "user",
      content: params.branch_prompt ? params.branch_prompt : content,
      plaintext: markdownToPlaintext(params.branch_prompt ? params.branch_prompt : content),
      status: "complete",
      quote_anchor_id: params.quote_anchor_id ?? null,
    });
    if (params.quote_anchor_id) repo.quotes.link(um.id, params.quote_anchor_id);

    const r = repo.runs.create({
      conversation_id: conv.id,
      card_id: card.id,
      message_id: null,
      purpose: "chat",
      model: conv.model,
      provider_type: conv.provider_type,
      provider_config_version: conv.provider_config_version,
      web_mode: conv.web_mode,
      think_mode: conv.think_mode,
      idempotency_key: idem,
    });
    repo.messages.bindRun(um.id, r.id);
    if (!conv.locked) repo.conversations.lock(conv.id);
    return { userMessage: um, run: r };
  });

  // 不在此处执行；由 SSE 端点订阅时触发（避免竞态）
  return { conversation: repo.conversations.get(conv.id)!, card, userMessage, run };
}

// SSE 端点订阅后触发执行（仅 queued 状态执行一次）
export function startRunIfPending(runId: string): boolean {
  const run = repo.runs.get(runId);
  if (!run || run.status !== "queued") return false;
  const conv = repo.conversations.get(run.conversation_id);
  const card = repo.cards.get(run.card_id);
  if (!conv || !card) return false;
  executeRun(conv, card, run, { userContent: undefined, quoteText: null }).catch((e) => handleRunError(run, e));
  return true;
}

export interface ExecuteOptions {
  branch_prompt?: string;
  userContent?: string;
  quoteText?: string | null;
  // 已存在的 assistant message id（重试时复用）
  assistantMessageId?: string;
  // 重试时排除的旧用户消息
  excludeMessageId?: string;
}

// 执行一次 run：构建上下文、搜索、流式回答
export async function executeRun(conv: Conversation, card: Card, run: Run, opts: ExecuteOptions): Promise<void> {
  const controller = new AbortController();
  activeControllers.set(run.id, controller);
  emit(run.id, { type: "run", run: { ...run, status: "running" } });
  repo.runs.update(run.id, { status: "running" });

  try {
    const provider = repo.providers.get(conv.provider_id)!;
    const adapter = await createAdapter({ ...provider, api_base: provider.api_base });

    // 构建上下文（排除本轮用户消息，因我们会 appendUser 或它已在 own messages 中）
    const built = buildContextWithIds(card, {
      excludeMessageId: opts.excludeMessageId,
      appendUser: opts.branch_prompt ? opts.branch_prompt : undefined,
      quoteText: opts.quoteText,
      systemPrompt: defaultSystemPrompt(),
    });
    let context = built.messages;

    // 创建 assistant 消息（流式落盘）
    const assistantMsg = repo.messages.create({
      card_id: card.id,
      conversation_id: conv.id,
      role: "assistant",
      content: "",
      plaintext: "",
      status: "streaming",
      run_id: run.id,
      model: conv.model,
      provider_type: conv.provider_type,
      web_mode: conv.web_mode,
      think_mode: conv.think_mode,
    });
    repo.runs.update(run.id, { message_id: assistantMsg.id });
    emit(run.id, { type: "message", message: assistantMsg });

    // 自动摘要：接近模型上限时压缩较早内容（原文保留，可回看）
    try {
      const compressed = await maybeCompressContext(built.messages, built.ids, {
        conversation: conv,
        card,
        provider,
        runId: run.id,
        signal: controller.signal,
      });
      context = compressed.messages;
      if (compressed.state.failed) {
        // 摘要失败：保留原文，提示可重试，但不提交可能超限的请求
        emit(run.id, { type: "summary", run_id: run.id, detail: `摘要失败（可重试）：${compressed.state.error || "未知错误"}` });
        throw new AdapterError(`上下文接近模型上限，自动摘要失败：${compressed.state.error || "未知错误"}。请缩短会话或重试。`, "model");
      }
      if (compressed.state.compressed) {
        emit(run.id, {
          type: "summary",
          run_id: run.id,
          detail: `已自动摘要第 ${compressed.state.version} 版，覆盖 ${compressed.state.coveredCount} 条较早消息。原文仍可回看。`,
        });
      }
    } catch (e) {
      if (e instanceof AdapterError) throw e;
      // 摘要过程异常（非业务失败）：继续使用原文
    }

    // 搜索策略
    let injectedContext = context;
    const sources: Source[] = [];
    const searchPlan = await decideSearch(conv, provider, context, controller.signal);
    if (searchPlan.kind === "independent" && searchPlan.queries.length) {
      emit(run.id, { type: "searching", run_id: run.id, queries: searchPlan.queries, service: searchPlan.service });
      repo.runs.update(run.id, { status: "searching" });
      const results = await searchPlan.doSearch();
      if (results.length) {
        for (const r of results) {
          emit(run.id, { type: "reading", run_id: run.id, url: r.url });
          const src = repo.sources.create({
            run_id: run.id,
            conversation_id: conv.id,
            url: r.url,
            title: r.title,
            snippet: r.snippet,
            content_kind: r.content_kind,
            citation_message_id: assistantMsg.id,
          });
          sources.push(src);
        }
        emit(run.id, { type: "sources", run_id: run.id, sources });
        injectedContext = injectSearchResults(context, results, searchPlan.queries);
      }
    } else if (searchPlan.kind === "native") {
      // 由适配器在 stream 内处理
    } else if (searchPlan.kind === "failed_force") {
      // 强制搜索但无可用服务：明确报错，不静默退化
      throw new AdapterError("强制搜索已启用，但未配置可用的搜索服务，且模型无原生搜索能力。请在设置中配置独立搜索或改为不联网。", "capability");
    }

    // 流式生成
    const stream = adapter.stream({
      model: conv.model,
      messages: injectedContext,
      webMode: searchPlan.kind === "native" ? conv.web_mode : "off",
      thinkMode: conv.think_mode,
      signal: controller.signal,
      onUsage: (u) => repo.runs.update(run.id, { usage: u }),
    });

    let collected = "";
    let lastFlush = Date.now();
    for await (const evt of stream) {
      if (controller.signal.aborted) break;
      if (evt.type === "delta") {
        collected += evt.text;
        emit(run.id, { type: "delta", message_id: assistantMsg.id, text: evt.text });
        const now = Date.now();
        if (now - lastFlush > 200) {
          repo.messages.setContent(assistantMsg.id, collected);
          lastFlush = now;
        }
      } else if (evt.type === "searching") {
        emit(run.id, { type: "searching", run_id: run.id, queries: evt.queries, service: evt.service });
        repo.runs.update(run.id, { status: "searching" });
      } else if (evt.type === "reading") {
        emit(run.id, { type: "reading", run_id: run.id, url: evt.url });
      } else if (evt.type === "source") {
        const src = repo.sources.create({
          run_id: run.id,
          conversation_id: conv.id,
          url: evt.source.url,
          title: evt.source.title,
          snippet: evt.source.snippet,
          content_kind: evt.source.content_kind,
          citation_message_id: assistantMsg.id,
        });
        sources.push(src);
        emit(run.id, { type: "sources", run_id: run.id, sources });
      } else if (evt.type === "done") {
        if (evt.usage) repo.runs.update(run.id, { usage: evt.usage });
      }
    }

    // 最终落盘
    repo.messages.setContent(assistantMsg.id, collected);
    repo.messages.setStatus(assistantMsg.id, "complete");
    const finalMsg = repo.messages.get(assistantMsg.id)!;
    repo.runs.update(run.id, { status: "completed", finished_at: new Date().toISOString(), sources: sources.map((s) => s.id) });
    const finalRun = repo.runs.get(run.id)!;
    emit(run.id, { type: "done", run_id: run.id, message: finalMsg, run: finalRun });
    // 重建会话索引，供知识助手检索
    try { indexConversation(conv.id); } catch { /* 索引失败不影响主流程 */ }
  } catch (e) {
    handleRunError(run, e);
  } finally {
    activeControllers.delete(run.id);
    // 清理监听器在 SSE 关闭后由客户端断开处理
  }
}

function handleRunError(run: Run, e: unknown) {
  const aborted = e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message));
  const msg = e instanceof Error ? e.message : String(e);
  if (aborted) {
    repo.runs.update(run.id, { status: "stopped", finished_at: new Date().toISOString() });
    // 保留已生成内容，标记中止
    if (run.message_id) {
      const m = repo.messages.get(run.message_id);
      if (m && m.status === "streaming") repo.messages.setStatus(run.message_id, "stopped");
    }
    emit(run.id, { type: "done", run_id: run.id, message: repo.messages.get(run.message_id || "")!, run: repo.runs.get(run.id)! });
    try { indexConversation(run.conversation_id); } catch { /* ignore */ }
  } else {
    repo.runs.update(run.id, { status: "failed", error: msg, finished_at: new Date().toISOString() });
    if (run.message_id) repo.messages.setStatus(run.message_id, "failed", msg);
    emit(run.id, { type: "error", run_id: run.id, message: msg, run: repo.runs.get(run.id)! });
  }
}

export function stopRun(runId: string): boolean {
  const c = activeControllers.get(runId);
  if (c) {
    c.abort();
    return true;
  }
  return false;
}

// 重试：原请求重发，幂等不重复用户消息
export async function retryRun(runId: string): Promise<Run | null> {
  const old = repo.runs.get(runId);
  if (!old) return null;
  const conv = repo.conversations.get(old.conversation_id);
  const card = repo.cards.get(old.card_id);
  if (!conv || !card) return null;
  // 将失败的 assistant 消息标记并新建一条
  const userMsg = repo.messages.get(old.message_id || "");
  // 找到该 run 对应的用户消息（card 内 role=user 且 run 绑定前的）
  // 简化：用 card 的最后一条 user 消息
  const own = repo.messages.listForCard(card.id);
  const lastUser = [...own].reverse().find((m) => m.role === "user");
  if (!lastUser) return null;
  // 新 run，新幂等键（避免命中旧的失败 run）
  const idem = `${lastUser.id}:chat:retry:${ulid()}`;
  const newRun = repo.transaction(() => {
    const r = repo.runs.create({
      conversation_id: conv.id,
      card_id: card.id,
      message_id: null,
      purpose: "chat",
      model: conv.model,
      provider_type: conv.provider_type,
      provider_config_version: conv.provider_config_version,
      web_mode: conv.web_mode,
      think_mode: conv.think_mode,
      idempotency_key: idem,
    });
    return r;
  });
  executeRun(conv, card, newRun, { userContent: lastUser.content }).catch((e) => handleRunError(newRun, e));
  return newRun;
}

// ---- 搜索决策 ----

type SearchPlan =
  | { kind: "none" }
  | { kind: "native" }
  | { kind: "independent"; queries: string[]; service: string; doSearch: () => Promise<SearchResultItem[]> }
  | { kind: "failed_force" };

async function decideSearch(conv: Conversation, provider: any, context: any, signal: AbortSignal): Promise<SearchPlan> {
  const webMode = conv.web_mode as WebMode;
  if (webMode === "off") return { kind: "none" };

  const adapter = await createAdapter(provider);
  const nativeSearch = adapter.supportsNativeSearch() && provider.capabilities?.web_search;

  if (nativeSearch && (webMode === "auto" || webMode === "force")) {
    return { kind: "native" };
  }

  // 无原生搜索 → 独立搜索
  const searchAdapter = await createSearchAdapter();
  if (!searchAdapter) {
    if (webMode === "force") return { kind: "failed_force" };
    // auto 但无独立搜索：如实不搜索
    return { kind: "none" };
  }

  // 决定查询
  let plan: QueryPlan;
  if (webMode === "force") {
    const q = await planQueries(provider, conv.model, context, true, signal);
    plan = { search: true, queries: q.queries.length ? q.queries : [fallbackQuery(context)] };
  } else {
    // auto：让模型决定
    plan = await planQueries(provider, conv.model, context, false, signal);
  }
  if (!plan.search || !plan.queries.length) return { kind: "none" };

  return {
    kind: "independent",
    queries: plan.queries,
    service: searchAdapter.name,
    doSearch: async () => {
      const res = await searchAdapter.search(plan.queries, signal);
      return res.results;
    },
  };
}

async function planQueries(provider: any, model: string, context: any, force: boolean, signal: AbortSignal): Promise<QueryPlan> {
  const lastUser = [...context].reverse().find((m: any) => m.role === "user");
  if (!lastUser) return { search: false, queries: [] };
  const prompt = [
    "你是一个搜索查询规划器。根据用户的最新问题，判断是否需要联网搜索，并生成 1-3 条简洁的搜索查询（中文或英文均可）。",
    force ? "本次必须搜索，请务必给出查询。" : "如果问题不需要最新资料或外部信息，可以不搜索。",
    '只返回 JSON：{"search": true/false, "queries": ["...", "..."]}',
    `用户最新问题：${lastUser.content}`,
  ].join("\n");
  try {
    const text = await completeChat(provider, model, [{ role: "user", content: prompt }], { json: true, signal });
    const p = parseQueryPlan(text);
    if (force && !p.queries.length) p.queries = [fallbackQuery(context)];
    return p;
  } catch {
    if (force) return { search: true, queries: [fallbackQuery(context)] };
    return { search: false, queries: [] };
  }
}

function fallbackQuery(context: any): string {
  const lastUser = [...context].reverse().find((m: any) => m.role === "user");
  return (lastUser?.content || "").slice(0, 80) || "最新资料";
}

function injectSearchResults(context: any, results: SearchResultItem[], queries: string[]): any[] {
  const materials = results
    .slice(0, 6)
    .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content_kind === "full" ? r.content.slice(0, 1200) : r.snippet}`)
    .join("\n\n");
  const sys = context.find((m: any) => m.role === "system");
  const rest = context.filter((m: any) => m.role !== "system");
  const searchSystem = {
    role: "system",
    content: `以下是联网检索到的资料（查询：${queries.join("；")}）。请基于这些资料回答，并在文中用 [序号] 标注来源。\n\n${materials}`,
  };
  return [sys, searchSystem, ...rest].filter(Boolean);
}

// ---- 知识助手 ----

export async function runAssistant(params: {
  conversation_id: string;
  question: string;
  idempotency_key?: string;
}): Promise<{ userMsgId: string; runId: string }> {
  const conv = repo.conversations.get(params.conversation_id);
  if (!conv) throw new Error("会话不存在");
  const provider = repo.providers.get(conv.provider_id);
  if (!provider) throw new Error("Provider 不可用");

  const idem = params.idempotency_key || `assistant:${params.conversation_id}:${hash(params.question)}`;
  const existing = repo.runs.getByIdem(idem);
  if (existing && existing.status !== "failed") {
    return { userMsgId: "", runId: existing.id };
  }

  const cards = repo.cards.listForConversation(conv.id);
  if (!cards.length) throw new Error("会话缺少卡片");
  const cardId = cards[0]!.id;
  const run = repo.transaction(() => {
    const um = repo.assistant.add({
      conversation_id: conv.id,
      role: "user",
      content: params.question,
      evidence: [],
    });
    const r = repo.runs.create({
      conversation_id: conv.id,
      card_id: cardId,
      message_id: null,
      purpose: "assistant",
      model: conv.model,
      provider_type: conv.provider_type,
      provider_config_version: conv.provider_config_version,
      web_mode: "off",
      think_mode: "off",
      idempotency_key: idem,
    });
    if (!conv.locked) repo.conversations.lock(conv.id);
    return { umId: um.id, r, question: params.question };
  });

  // 保存 question 供执行使用（run 表无 question 字段，存入内存映射）
  pendingAssistant.set(run.r.id, run.question);
  return { userMsgId: run.umId, runId: run.r.id };
}

const pendingAssistant = new Map<string, string>();

export function startAssistantRunIfPending(runId: string): boolean {
  const run = repo.runs.get(runId);
  if (!run || run.status !== "queued") return false;
  const conv = repo.conversations.get(run.conversation_id);
  if (!conv) return false;
  const question = pendingAssistant.get(runId) || "";
  pendingAssistant.delete(runId);
  executeAssistant(conv, run, question).catch((e) => handleRunError(run, e));
  return true;
}

async function executeAssistant(conv: Conversation, run: Run, question: string): Promise<void> {
  const controller = new AbortController();
  activeControllers.set(run.id, controller);
  emit(run.id, { type: "run", run: { ...run, status: "running" } });
  repo.runs.update(run.id, { status: "running" });

  try {
    const provider = repo.providers.get(conv.provider_id)!;
    // 检索当前会话候选（强制限定 conversation_id）
    const candidates = await retrieveInSession(conv.id, question);
    const evidence = candidates.map((c) => ({ card_id: c.cardId, message_id: c.messageId, anchor_id: c.anchorId }));

    // 构建证据上下文
    const evidenceText = candidates
      .map((c, i) => `[证据${i + 1}] 卡片:${c.cardTitle}\n消息:${c.role}\n内容:${c.text.slice(0, 800)}`)
      .join("\n\n");
    const messages = [
      { role: "system", content: assistantSystemPrompt() },
      { role: "system", content: evidenceText ? `以下是本会话已保存的相关内容：\n\n${evidenceText}` : "本会话中未检索到相关内容。请如实告知未检索到。" },
      { role: "user", content: question },
    ];

    const full = await completeChat(provider, conv.model, messages as any, { signal: controller.signal });
    const finalContent = full + formatEvidence(evidence, candidates);
    repo.assistant.add({
      conversation_id: conv.id,
      role: "assistant",
      content: finalContent,
      evidence,
      run_id: run.id,
    });
    repo.runs.update(run.id, { status: "completed", finished_at: new Date().toISOString() });
    emit(run.id, { type: "done", run_id: run.id, message: repo.messages.listForCard(run.card_id).slice(-1)[0]!, run: repo.runs.get(run.id)! });
    try { indexConversation(conv.id); } catch { /* 索引失败不影响主流程 */ }
  } catch (e) {
    handleRunError(run, e);
  } finally {
    activeControllers.delete(run.id);
  }
}

function formatEvidence(evidence: any[], candidates: any[]): string {
  if (!candidates.length) return "";
  return "\n\n**来源：**\n" + candidates.map((c, i) => `- [${i + 1}] ${c.cardTitle} · ${c.messageId.slice(-6)}`).join("\n");
}

// 会话内检索：FTS + 标题匹配，强制限定 conversation_id
import { searchInSession } from "./knowledge.js";
async function retrieveInSession(conversationId: string, question: string): Promise<any[]> {
  return searchInSession(conversationId, question);
}

// 暴露供路由使用
export { ulid, hash };
