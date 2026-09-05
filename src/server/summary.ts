// 自动摘要：当分支上下文接近模型上限时，把较早内容摘要成带来源范围与版本的记录。
// 原文永不删除；摘要仅用于压缩发送给模型的上下文。失败时保留原文并显示可重试状态。
import type { Conversation, Card, Message, ProviderConfig, SummaryRecord } from "../shared/types.js";
import type { ChatMessage } from "./adapters/types.js";
import * as repo from "./repo.js";
import { completeChat } from "./complete.js";
import { markdownToPlaintext } from "./selection.js";

// 粗略 token 估算：CJK 约 1 token/字，拉丁文约 4 字符/token。
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (ch >= "一" && ch <= "鿿") cjk++;
    else if (ch >= "぀" && ch <= "ヿ") cjk++;
    else if (ch >= "가" && ch <= "힯") cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((s, m) => s + estimateTokens(m.content), 0);
}

interface ContextParts {
  system: ChatMessage | null;
  body: ChatMessage[]; // 非系统消息（有序，含快照继承 + 卡片自身 + 本轮）
  bodyMessageIds: (string | null)[]; // 与 body 对应的消息 ID（系统/摘要为 null）
}

// 拆分上下文为系统 + 主体，并记录主体对应的消息 ID。
// 约定：buildContext 产出的消息中 role==="system" 仅首条为系统指令。
export function splitContext(messages: ChatMessage[], bodyIds: (string | null)[]): ContextParts {
  let system: ChatMessage | null = null;
  const body: ChatMessage[] = [];
  const ids: (string | null)[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (!system && m.role === "system") {
      system = m;
      continue;
    }
    body.push(m);
    ids.push(bodyIds[i] ?? null);
  }
  return { system, body, bodyMessageIds: ids };
}

export interface SummaryState {
  compressed: boolean;
  version: number;
  coveredCount: number;
  summaryId: string | null;
  failed: boolean;
  error?: string;
}

export interface CompressOptions {
  conversation: Conversation;
  card: Card;
  provider: ProviderConfig;
  runId: string;
  signal: AbortSignal;
}

export interface CompressResult {
  messages: ChatMessage[]; // 可直接发给模型的新上下文
  state: SummaryState;
}

// 预留：系统指令 + 搜索资料 + 输出空间
const RESERVE_TOKENS = 6000;
// 触发比例：达到窗口的 70% 即开始压缩
const TRIGGER_RATIO = 0.7;
// 近期保留比例：保证近期原文不被动摘要
const RECENT_RATIO = 0.35;
// 至少需有这么多条较早消息才值得压缩
const MIN_SUMMARIZE_COUNT = 4;

export function shouldCompress(totalTokens: number, contextWindow: number): boolean {
  return totalTokens > (contextWindow - RESERVE_TOKENS) * TRIGGER_RATIO;
}

// 主入口：根据预算决定是否压缩，必要时调用模型生成摘要并落盘。
export async function maybeCompressContext(
  messages: ChatMessage[],
  bodyMessageIds: (string | null)[],
  opts: CompressOptions,
): Promise<CompressResult> {
  const window = opts.provider.capabilities?.context_window || 32000;
  const total = estimateMessagesTokens(messages);
  const state0: SummaryState = {
    compressed: false,
    version: 0,
    coveredCount: 0,
    summaryId: null,
    failed: false,
  };

  if (!shouldCompress(total, window)) {
    return { messages, state: state0 };
  }

  const parts = splitContext(messages, bodyMessageIds);
  // 近期保留预算（token）
  const recentBudget = Math.max(2000, Math.floor(window * RECENT_RATIO));
  // 从尾部向前保留尽可能多的近期消息，但不低于 2 条
  let keepIdx = parts.body.length;
  let keptTokens = 0;
  for (let i = parts.body.length - 1; i >= 0; i--) {
    const t = estimateTokens(parts.body[i]!.content);
    if (keptTokens + t > recentBudget && keepIdx - i > 2) break;
    keptTokens += t;
    keepIdx = i;
  }
  // 至少保留最后 2 条原文
  keepIdx = Math.min(keepIdx, parts.body.length - 2);
  const older = parts.body.slice(0, keepIdx);
  const olderIds = parts.bodyMessageIds.slice(0, keepIdx);
  const recent = parts.body.slice(keepIdx);

  if (older.length < MIN_SUMMARIZE_COUNT) {
    // 较早消息不足，不值得压缩；直接发送原文（可能仍超限，由模型层返回错误）
    return { messages, state: state0 };
  }

  // 仅压缩有 ID 的真实消息（排除本轮 appendUser 等未落盘内容）
  const olderReal: { msg: ChatMessage; id: string; version: number }[] = [];
  for (let i = 0; i < older.length; i++) {
    const id = olderIds[i];
    if (!id) continue;
    const m = repo.messages.get(id);
    if (!m) continue;
    olderReal.push({ msg: older[i]!, id, version: m.version });
  }

  if (olderReal.length < MIN_SUMMARIZE_COUNT) {
    return { messages, state: state0 };
  }

  // 复用已有摘要：若已有摘要的 covered 范围是当前 olderReal 的前缀且版本一致，直接复用其文本
  const existing = repo.summaries.listForCard(opts.card.id);
  const coveredIds = olderReal.map((o) => o.id);
  let reused: SummaryRecord | null = null;
  for (const s of existing) {
    if (s.covered_message_ids.length === coveredIds.length &&
        s.covered_message_ids.every((cid, idx) => cid === coveredIds[idx])) {
      reused = s;
      break;
    }
  }

  // 复用已有摘要文本（若摘要消息仍在）
  let reuseText: string | null = null;
  if (reused && reused.summary_message_id) {
    const sm = repo.messages.get(reused.summary_message_id);
    if (sm && sm.content) reuseText = sm.content;
    else reused = null; // 摘要消息丢失，重新生成
  }

  let summaryText: string;
  let version: number;
  let summaryMessageId: string | null;
  let usage: any = null;

  if (reuseText && reused) {
    summaryText = reuseText;
    version = reused.version;
    summaryMessageId = reused.summary_message_id;
  } else {
    // 生成新摘要
    const nextVersion = (existing[0]?.version || 0) + 1;
    try {
      const result = await generateSummary(opts.conversation, opts.card, opts.provider, olderReal.map((o) => o.msg), opts.signal);
      summaryText = result.text;
      usage = result.usage;
      version = nextVersion;
      // 摘要文本作为一条 system 消息持久化（便于回看与失败重试）
      const sm = repo.messages.create({
        card_id: opts.card.id,
        conversation_id: opts.conversation.id,
        role: "system",
        content: summaryText,
        plaintext: markdownToPlaintext(summaryText),
        status: "complete",
        run_id: opts.runId,
        model: opts.conversation.model,
        provider_type: opts.conversation.provider_type,
      });
      summaryMessageId = sm.id;
      repo.summaries.create({
        card_id: opts.card.id,
        conversation_id: opts.conversation.id,
        summary_message_id: sm.id,
        covered_message_ids: coveredIds,
        version,
        usage,
      });
    } catch (e) {
      // 摘要失败：保留原文，标记可重试，不提交超限请求
      return {
        messages,
        state: {
          ...state0,
          failed: true,
          error: e instanceof Error ? e.message : String(e),
        },
      };
    }
  }

  // 构造压缩后上下文：系统指令 + 摘要系统消息 + 近期原文
  const summarySystem: ChatMessage = {
    role: "system",
    content: `以下是本分支较早对话内容的摘要（第 ${version} 版，覆盖 ${coveredIds.length} 条消息）。原文仍完整保存在本机，可回看。摘要仅供参考，回答仍应以近期原文为准。\n\n${summaryText}`,
  };
  const out: ChatMessage[] = [];
  if (parts.system) out.push(parts.system);
  out.push(summarySystem);
  out.push(...recent);

  return {
    messages: out,
    state: {
      compressed: true,
      version,
      coveredCount: coveredIds.length,
      summaryId: summaryMessageId,
      failed: false,
    },
  };
}

// 调用模型生成摘要（非流式）。分段时每段输入也需满足预算。
async function generateSummary(
  conv: Conversation,
  card: Card,
  provider: ProviderConfig,
  older: ChatMessage[],
  signal: AbortSignal,
): Promise<{ text: string; usage: any }> {
  const dialog = older
    .map((m) => `${m.role === "user" ? "用户" : "回答"}：${m.content}`)
    .join("\n\n");
  const prompt: ChatMessage[] = [
    {
      role: "system",
      content: "你是摘要助手。请把下方对话内容压缩成一份简洁的中文摘要，保留关键概念、结论与待追问的点。不要引入对话外的信息。用 Markdown 列表组织。",
    },
    { role: "user", content: dialog },
  ];
  const text = await completeChat(provider, conv.model, prompt, { signal });
  return { text, usage: null };
}
