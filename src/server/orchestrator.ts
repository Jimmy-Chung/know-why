import { normalizeThinkMode } from "../shared/reasoning.js";
import { getModelCatalog, reasoningRequest, reasoningProtocol } from "./model-capabilities.js";
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
  Attachment,
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
import { indexConversation, indexEmbeddings, retrievePassages } from "./knowledge.js";
import { assistantHistory, retrievalQuestion, buildRagRequest } from "./rag.js";
import { getDb } from "./db.js";

// 每个 run 的事件订阅器
type Listener = (e: SSEEvent) => void;
const runListeners = new Map<string, Set<Listener>>();
const activeControllers = new Map<string, AbortController>();
const liveAssistantMessages = new Map<string, import("../shared/types.js").KnowledgeAssistantMessage>();
export function assistantRunSnapshot(runId:string) {
  const live=liveAssistantMessages.get(runId);
  if(live)return {...live};
  const run=repo.runs.get(runId);
  return run?repo.assistant.list(run.conversation_id).find(m=>m.run_id===runId && m.role==="assistant"):undefined;
}
// 服务重启无法续跑 in-flight 的 provider 流：把所有非终态 run 收敛为 stopped，
// 流式未完成的消息标记为中断（chat 与 assistant 两套消息表）。
// queued 也一并收敛：重启后不存在活着的 SSE 消费者，悬挂的 queued 永远不会被
// startRunIfPending 消费，用户看不到可重试状态；收敛后由用户点重试恢复。
export function recoverStalledRuns(): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `UPDATE message SET status='stopped' WHERE status='streaming'
        AND run_id IN (SELECT id FROM run WHERE status IN ('running','searching','reading'))`,
    ).run();
    db.prepare(
      `UPDATE knowledge_assistant_message SET status='stopped' WHERE role='assistant' AND status='streaming'
        AND run_id IN (SELECT id FROM run WHERE status IN ('running','searching','reading'))`,
    ).run();
    db.prepare(
      `UPDATE run SET status='stopped', error='服务重启，运行已中断，可重新发送。', finished_at=?
        WHERE status NOT IN ('completed','stopped','failed')`,
    ).run(new Date().toISOString());
  })();
}

// ---- 心跳与看门狗：兜底「悬挂 run」（无执行器 / 执行器无进展） ----
const runHeartbeat = new Map<string, number>();
function touchRun(id: string) {
  runHeartbeat.set(id, Date.now());
}
const ORPHAN_MS = 45_000; // 创建后迟迟没有执行器接管（SSE 订阅窗口远小于此，缺失即孤儿）
const STALL_MS = 5 * 60_000; // 执行中长时间无任何产出（delta / 状态变化）

function sweepStalledRuns() {
  const now = Date.now();
  const rows = getDb()
    .prepare("SELECT id, created_at FROM run WHERE status NOT IN ('completed','stopped','failed')")
    .all() as { id: string; created_at: string }[];
  for (const row of rows) {
    if (!activeControllers.has(row.id)) {
      // 孤 child：无执行器（如创建后 SSE 一直没连上、进程内控制器丢失）
      if (now - new Date(row.created_at).getTime() > ORPHAN_MS) forceStopRun(row.id);
    } else {
      // 执行中但长时间无心跳：底层流可能吞掉了 abort，强制收敛
      const last = runHeartbeat.get(row.id) ?? now;
      if (now - last > STALL_MS) {
        activeControllers.get(row.id)?.abort();
        forceStopRun(row.id);
      }
    }
  }
}

export function startRunWatchdog(): NodeJS.Timeout {
  runHeartbeat.clear();
  return setInterval(sweepStalledRuns, 30_000).unref();
}

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
  attachments?: Attachment[];
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
  // 首次提问（主卡片、无历史用户消息、标题仍为默认）时，异步生成会话标题
  const isFirstQuestion =
    !card.parent_card_id &&
    conv.title === "新会话" &&
    repo.messages.listForCard(card.id).filter((m) => m.role === "user").length === 0;
  const { userMessage, run } = repo.transaction(() => {
    const um = repo.messages.create({
      card_id: card.id,
      conversation_id: conv.id,
      role: "user",
      content: params.branch_prompt ? params.branch_prompt : content,
      plaintext: markdownToPlaintext(params.branch_prompt ? params.branch_prompt : content),
      status: "complete",
      quote_anchor_id: params.quote_anchor_id ?? null,
      attachments: params.attachments ?? [],
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

  // 首次提问：用 LLM 从问题提炼会话标题（不阻塞主 run）
  if (isFirstQuestion) {
    generateTitle(conv, content).catch(() => {});
  }

  // 不在此处执行；由 SSE 端点订阅时触发。若前端从未订阅（连接失败），
  // 看门狗会把超时未消费的 queued run 收敛为 stopped，避免无限期悬挂。
  return { conversation: repo.conversations.get(conv.id)!, card, userMessage, run };
}

// 从首个问题提炼会话标题：非流式轻量调用，失败静默保留默认标题。
// 仅在标题仍为默认「新会话」时写入，避免覆盖用户手动改名。
async function generateTitle(conv: Conversation, question: string): Promise<void> {
  try {
    const provider = repo.providers.get(conv.provider_id);
    if (!provider) return;
    const raw = await completeChat(
      provider,
      conv.model,
      [
        { role: "system", content: "你是会话标题生成器。根据用户的提问提炼一个简洁标题。要求：中文不超过 16 个字，英文不超过 8 个单词；不要引号、不要句末标点；直接输出标题文本，不要任何解释。" },
        { role: "user", content: question.slice(0, 500) },
      ],
      { signal: AbortSignal.timeout(15000) },
    );
    const title = raw.trim().replace(/^[「『"'"]|[」』"'"]$/g, "").replace(/[。.！!？?…]+$/g, "").slice(0, 30);
    if (!title) return;
    // 仅在仍为默认标题时写入，避免覆盖用户手动改名
    const cur = repo.conversations.get(conv.id);
    if (cur && cur.title === "新会话") repo.conversations.rename(conv.id, title);
  } catch {
    // 静默失败：保留默认标题，不影响主流程
  }
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
  conv = { ...conv, web_mode: run.web_mode, think_mode: run.think_mode, model: run.model };
  const controller = new AbortController();
  activeControllers.set(run.id, controller);
  touchRun(run.id);
  emit(run.id, { type: "run", run: { ...run, status: "running" } });
  repo.runs.update(run.id, { status: "running" });

  try {
    const provider = repo.providers.get(conv.provider_id)!;
    const adapter = await createAdapter({ ...provider, api_base: provider.api_base });

    const modelCapabilities = normalizeThinkMode(conv.think_mode) === "default" ? undefined : await getModelCatalog(provider, conv.model);
    if (modelCapabilities) reasoningRequest(conv.think_mode, modelCapabilities.reasoning, reasoningProtocol(provider));

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
      emit(run.id, { type: "status", run_id: run.id, status: "running", detail: "整理上下文……" });
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
    if (conv.web_mode !== "off") emit(run.id, { type: "status", run_id: run.id, status: "running", detail: "规划搜索……" });
    const searchPlan = await decideSearch(conv, provider, context, controller.signal);
    touchRun(run.id);
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
      reasoning: modelCapabilities?.reasoning,
      signal: controller.signal,
      onUsage: (u) => repo.runs.update(run.id, { usage: u }),
    });

    let collected = "";
    let lastFlush = Date.now();
    for await (const evt of stream) {
      if (controller.signal.aborted) break;
      if (evt.type === "delta") {
        collected += evt.text;
        touchRun(run.id);
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
      } else if (evt.type === "thinking") {
        emit(run.id, { type: "thinking", run_id: run.id, text: evt.text });
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
    if (controller.signal.aborted) {
      // 停止/中断：若底层流吞掉了 abort 并正常走完，也不得标为已完成
      throw new Error("aborted");
    }
    repo.messages.setContent(assistantMsg.id, collected);
    repo.messages.setStatus(assistantMsg.id, "complete");
    const finalMsg = repo.messages.get(assistantMsg.id)!;
    repo.runs.update(run.id, { status: "completed", finished_at: new Date().toISOString(), sources: sources.map((s) => s.id) });
    const finalRun = repo.runs.get(run.id)!;
    emit(run.id, { type: "done", run_id: run.id, message: finalMsg, run: finalRun });
    // 重建会话索引，供知识助手检索
    try { indexConversation(conv.id); } catch { /* 索引失败不影响主流程 */ }
    void indexEmbeddings(conv.id).catch(() => {});
  } catch (e) {
    handleRunError(run, e);
  } finally {
    activeControllers.delete(run.id);
    runHeartbeat.delete(run.id);
    // 清理监听器在 SSE 关闭后由客户端断开处理
  }
}

function handleRunError(run: Run, e: unknown) {
  const aborted = e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message));
  const msg = e instanceof Error ? e.message : String(e);
  if (aborted) {
    repo.runs.update(run.id, { status: "stopped", finished_at: new Date().toISOString() });
    // 用 repo 中最新的 run 取 message_id（闭包 run 是初始值，message_id 可能为 null），
    // 避免向前端 emit undefined message 导致渲染崩溃
    const latestRun = repo.runs.get(run.id);
    const stoppedMsg = latestRun?.message_id ? repo.messages.get(latestRun.message_id) : undefined;
    if (stoppedMsg && stoppedMsg.status === "streaming") repo.messages.setStatus(stoppedMsg.id, "stopped");
    emit(run.id, { type: "done", run_id: run.id, message: stoppedMsg ?? null, run: latestRun ?? run });
    try { indexConversation(run.conversation_id); } catch { /* ignore */ }
    void indexEmbeddings(run.conversation_id).catch(() => {});
  } else {
    repo.runs.update(run.id, { status: "failed", error: msg, finished_at: new Date().toISOString() });
    if (run.message_id) repo.messages.setStatus(run.message_id, "failed", msg);
    emit(run.id, { type: "error", run_id: run.id, message: msg, run: repo.runs.get(run.id)! });
  }
}

// 无论 run 处于哪个非终态，都保证停止：中止控制器（若存在）并强制落盘为 stopped。
// 覆盖：queued（未启动）、running/searching/reading（执行中）、以及控制器丢失的
// 悬挂 run（页面刷新后点停止、或 executeRun 异常退出未清理的场景）。
export function stopRun(runId: string): boolean {
  const run = repo.runs.get(runId);
  if (!run) return false;
  if (["completed", "stopped", "failed"].includes(run.status)) return true; // 已终态：视为已停止
  const c = activeControllers.get(runId);
  if (c) {
    // 有执行器：中止控制器，先落 DB 为 stopped（界面立即可见），
    // 由执行循环的 catch/abort 检查随后 emit done 收敛。
    c.abort();
    repo.runs.update(runId, { status: "stopped", error: null, finished_at: new Date().toISOString() });
    return true;
  }
  // 无执行器：孤儿/悬挂 run（页面刷新后、异常退出未清理），直接收敛并 emit done。
  forceStopRun(runId);
  return true;
}

// 写入 stopped 终态并通知 SSE；幂等（终态后不再重复写）
function forceStopRun(runId: string): void {
  const run = repo.runs.get(runId);
  if (!run || ["completed", "stopped", "failed"].includes(run.status)) return;
  repo.runs.update(runId, { status: "stopped", finished_at: new Date().toISOString() });
  const latest = repo.runs.get(runId)!;
  let msg = undefined;
  if (latest.message_id) {
    const m = repo.messages.get(latest.message_id);
    if (m && m.status === "streaming") repo.messages.setStatus(m.id, "stopped");
    if (m) msg = m;
  }
  emit(runId, { type: "done", run_id: runId, message: msg ?? null, run: latest });
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
  const lastUser = [...context].reverse().find((m: any) => m.role === "user");
  const question = lastUser?.content || "";

  // auto：先用启发式对"明显需要/不需要搜索"的问题直接裁决，
  // 避免为它们多花一次 LLM 规划 round-trip（~500ms）。模糊问题才升级到 LLM。
  if (webMode === "auto") {
    const verdict = quickSearchVerdict(question);
    if (verdict === "skip") return { kind: "none" };
    if (verdict === "need") {
      const queries = [question.slice(0, 80) || "latest news"];
      return {
        kind: "independent", queries, service: searchAdapter.name,
        doSearch: async () => (await searchAdapter.search(queries, signal)).results,
      };
    }
    // verdict === null：模糊地带，落回 LLM 规划（与现状一致）
  }

  // 决定查询（force 或 auto 的模糊地带）
  let plan: QueryPlan;
  if (webMode === "force") {
    const q = await planQueries(provider, conv.model, context, true, signal);
    plan = { search: true, queries: q.queries.length ? q.queries : [fallbackQuery(context)] };
  } else {
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
    "You are a search query planner. Based on the user's latest question, decide whether web search is needed, and generate 1-3 concise search queries IN ENGLISH.",
    "Always generate queries in English regardless of the user's language — English queries return the most authoritative and globally relevant results; the answering model will translate as needed.",
    force ? "This round must search; please provide queries." : "If the question does not need fresh or external info, you may skip searching.",
    'Return JSON only: {"search": true/false, "queries": ["...", "..."]}',
    `User's latest question: ${lastUser.content}`,
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
  return (lastUser?.content || "").slice(0, 80) || "latest news";
}

// 快速启发式判定：对"明显需要/不需要搜索"的问题在 auto 模式下直接决策，避免为它们
// 多花一次 LLM 规划 round-trip（~500ms）。只有两方都不命中的"模糊问题"才升级到 LLM 规划，
// 保证准确度不受影响。返回 "need" | "skip" | null。
export function quickSearchVerdict(question: string): "need" | "skip" | null {
  const q = question.trim();
  if (!q) return null;

  // 需要搜索的强信号（中文做子串匹配；\b 对中文无效勿用）
  const needWords = [
    // 时效性
    "今天", "今早", "今日", "昨天", "前天", "明天", "去年", "今年", "上周", "上月", "上个月", "现在", "最新", "最近", "实时", "目前", "当前",
    // 实时/外部信息
    "新闻", "天气", "气温", "降温", "降雪", "下雨", "台风", "地震", "疫情", "热搜", "排行榜", "榜单", "股价", "股票", "油价", "金价", "涨停", "跌停",
    // 财报/经济
    "财报", "营收", "净利润", "市值", "汇率", "比分",
    // 赛事/发布
    "赛程", "赛果", "预览", "发布会", "新款", "开售", "开卖", "预售", "上线", "下线", "更新至",
  ];
  for (const w of needWords) if (q.includes(w)) return "need";
  // 价格/钞票类即时查询（排除定义类提问）
  if (/(多少钱|值多少|换多少钱|贵不贵|便宜|升值|贬值)/.test(q) && !/(什么是|解释|讲讲|介绍)/.test(q)) return "need";
  // 带年份的时效话题
  if (/(20\d{2}|19\d{2})年/.test(q) && /(新闻|事件|情况|进展|结果|现状|数据|统计|报告|行情|更新|版本|发布|成绩)/.test(q)) return "need";
  // 外链
  if (/https?:\/\/|www\./.test(q)) return "need";

  // 不需要搜索的强信号
  const greeting = /^(hi|hello|hey|你好|您好|嗨|哈喽|在吗|喂|早上好|早安|中午好|下午好|晚上好|晚安|谢谢|感谢|多谢|辛苦了|收到|好的|明白|嗯|再见|拜拜)/i.test(q);
  if (greeting) return "skip";
  // 纯数字/算式
  if (/^[\s\d+\-*/÷×^=?%(),。，.]+$/.test(q)) return "skip";
  // 代码块或涉及代码的请求
  if (/^(```|~~~)/.test(q) || /`[a-zA-Z_][\w-]*`/.test(q)) return "skip";
  // 引用上文/追问上文
  if (/(上面|上一条|你刚才|你之前|刚刚|接着|继续)/.test(q) && q.length <= 20) return "skip";

  return null; // 模糊地带 → 走 LLM 规划
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
    content: `以下是联网检索到的资料（查询：${queries.join("；")}）。请基于这些资料回答，并在文中用 [序号] 标注来源。若资料语言与你的回答语言不同，请自行翻译整理。\n\n${materials}`,
  };
  return [sys, searchSystem, ...rest].filter(Boolean);
}

// ---- 知识助手 ----

export async function runAssistant(params: {
  conversation_id: string;
  question: string;
  thread_id?: string | null;
  quote?: string | null;
  scope_card_ids?: string[] | null;
  idempotency_key?: string;
}): Promise<{ userMsgId: string; runId: string }> {
  const conv = repo.conversations.get(params.conversation_id);
  if (!conv) throw new Error("会话不存在");
  const provider = repo.providers.get(conv.provider_id);
  if (!provider) throw new Error("Provider 不可用");

  if (typeof params.question !== "string" || !params.question.trim()) throw new Error("请输入问题");
  const threadKey = params.thread_id || "default";
  // 作用域参与幂等键：不同 @ 范围视为不同提问
  const scopeKey = params.scope_card_ids && params.scope_card_ids.length ? [...params.scope_card_ids].sort().join(",") : "all";
  const idem = params.idempotency_key || `assistant:${params.conversation_id}:${threadKey}:${scopeKey}:${hash(params.question)}`;
  const existing = repo.runs.getByIdem(idem);
  if (existing && existing.status !== "failed") {
    return { userMsgId: repo.assistant.list(conv.id).find(m => m.run_id === existing.id && m.role === "user")?.id || "", runId: existing.id };
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
      thread_id: params.thread_id ?? null,
      quote: params.quote ?? null,
      scope_card_ids: params.scope_card_ids ?? null,
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
    getDb().prepare("UPDATE knowledge_assistant_message SET run_id=? WHERE id=?").run(r.id, um.id);
    return { umId: um.id, r, question: params.question };
  });

  return { userMsgId: run.umId, runId: run.r.id };
}

export function startAssistantRunIfPending(runId: string): boolean {
  const run = repo.runs.get(runId);
  if (!run || run.status !== "queued") return false;
  const conv = repo.conversations.get(run.conversation_id);
  if (!conv) return false;
  const user = repo.assistant.list(conv.id).find(m => m.run_id === runId && m.role === "user");
  if (!user) { handleRunError(run, new Error("助手提问记录不存在，请重新提问。")); return false; }
  void executeAssistant(conv, run, user.content, user.thread_id, user.id, user.quote ?? null, user.scope_card_ids ?? null);
  return true;
}

async function executeAssistant(conv: Conversation, run: Run, question: string, threadId: string | null, userMessageId: string, quote: string | null, scopeCardIds: string[] | null): Promise<void> {
  const controller = new AbortController();
  activeControllers.set(run.id, controller);
  touchRun(run.id);
  repo.runs.update(run.id, { status: "running" });
  emit(run.id, { type: "run", run: repo.runs.get(run.id)! });
  const started = performance.now();
  let answer: import("../shared/types.js").KnowledgeAssistantMessage | undefined;
  let full = "";
  let firstToken: number | null = null;
  let metrics = { retrieval_ms: 0, candidate_count: 0, evidence_count: 0, estimated_input_tokens: 0, evidence_tokens: 0, cache_hit: 0, semantic_ready: 0 };
  try {
    const provider = repo.providers.get(conv.provider_id)!;
    emit(run.id, { type:"status", run_id:run.id, status:"running", detail:"正在查找相关对话……" });
    const history = assistantHistory(repo.assistant.list(conv.id),threadId,userMessageId);
    buildRagRequest(question,history,[],provider.capabilities?.context_window || 32000,quote); // reject oversized questions before embedding
    const query = retrievalQuestion(question,history);
    const found = await retrievePassages(conv.id,query,40,controller.signal,scopeCardIds);
    controller.signal.throwIfAborted();
    // Backfill old sessions without delaying this keyword-based answer.
    void indexEmbeddings(conv.id).catch(() => {});
    const prepared = buildRagRequest(question,history,found.candidates,provider.capabilities?.context_window || 32000,quote);
    metrics = { retrieval_ms:performance.now()-started,candidate_count:found.candidates.length,evidence_count:prepared.evidence.length,
      estimated_input_tokens:prepared.inputTokens,evidence_tokens:prepared.evidenceTokens,cache_hit:Number(found.cacheHit),semantic_ready:Number(found.semanticReady) };
    answer = repo.assistant.add({ conversation_id:conv.id,role:"assistant",content:"",evidence:prepared.evidence,run_id:run.id,thread_id:threadId,status:"streaming" });
    liveAssistantMessages.set(run.id,answer);
    emit(run.id,{type:"assistant_message",message:answer});
    emit(run.id,{type:"status",run_id:run.id,status:"running",detail:"正在依据会话资料回答……"});
    if (!prepared.evidence.length) {
      full = "本次未检索到足够的相关内容。你可以补充具体术语或分支名称后再试。";
      if (!found.semanticReady) full += "新内容仍可能在整理中，也可以稍后重试。";
      firstToken = performance.now() - started;
      emit(run.id,{type:"assistant_delta",message_id:answer.id,text:full});
      repo.runs.update(run.id,{usage:{prompt_tokens:0,completion_tokens:0}});
    } else {
      const adapter = await createAdapter(provider);
      let lastFlush = performance.now();
      for await (const event of adapter.stream({ model:run.model,messages:prepared.messages,webMode:"off",thinkMode:"default",
        maxOutputTokens:prepared.outputReserve,onUsage:usage=>repo.runs.update(run.id,{usage}),signal:controller.signal })) {
        controller.signal.throwIfAborted();
        if(event.type==="error") throw new Error(event.message);
        if(event.type==="delta") {
          touchRun(run.id);
          if(firstToken===null) firstToken=performance.now()-started;
          full+=event.text;
          liveAssistantMessages.set(run.id,{...answer,content:full});
          emit(run.id,{type:"assistant_delta",message_id:answer.id,text:event.text});
          if(performance.now()-lastFlush>250) {repo.assistant.update(answer.id,full,"streaming");lastFlush=performance.now();}
        } else if(event.type==="done" && event.usage) repo.runs.update(run.id,{usage:event.usage});
      }
    }
    controller.signal.throwIfAborted();
    if(!full.trim())throw new Error("模型未返回回答内容，请重试。");
    repo.assistant.update(answer.id,full,"complete");
    emit(run.id,{type:"assistant_message",message:{...answer,content:full,status:"complete"}});
    repo.runs.update(run.id,{status:"completed",finished_at:new Date().toISOString()});
    emit(run.id,{type:"done",run_id:run.id,message:null,run:repo.runs.get(run.id)!});
  } catch(error) {
    const stopped=controller.signal.aborted;
    if(answer) {
      repo.assistant.update(answer.id,full,stopped?"stopped":"failed");
      emit(run.id,{type:"assistant_message",message:{...answer,content:full,status:stopped?"stopped":"failed"}});
    }
    repo.runs.update(run.id,{status:stopped?"stopped":"failed",error:stopped?null:(error as Error).message,finished_at:new Date().toISOString()});
    if(stopped)emit(run.id,{type:"done",run_id:run.id,message:null,run:repo.runs.get(run.id)!});
    else emit(run.id,{type:"error",run_id:run.id,message:(error as Error).message,run:repo.runs.get(run.id)!});
  } finally {
    activeControllers.delete(run.id);
    runHeartbeat.delete(run.id);
    liveAssistantMessages.delete(run.id);
    try {
      getDb().prepare(`INSERT OR REPLACE INTO knowledge_rag_metrics VALUES(?,?,?,?,?,?,?,?,?,?)`).run(run.id,metrics.retrieval_ms,firstToken,performance.now()-started,
        metrics.candidate_count,metrics.evidence_count,metrics.estimated_input_tokens,metrics.evidence_tokens,metrics.cache_hit,metrics.semantic_ready);
    } catch { /* Metrics never interrupt an answer or a concurrent conversation purge. */ }
  }
}

export { ulid, hash };
