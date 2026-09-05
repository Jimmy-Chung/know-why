// 上下文构建器：为某张卡片构造发送给模型的有序消息。
// 规则：普通提问 = 初始快照消息 + 该卡片后续消息 + 本轮问题。
// 不把整个会话的全部消息塞入；兄弟分支互不影响。
import type { ChatMessage } from "./adapters/types.js";
import type { Card, Message } from "../shared/types.js";
import * as repo from "./repo.js";

export interface BuildContextOptions {
  // 排除某条用户消息（用于重试时不重复计入）
  excludeMessageId?: string;
  // 附加本轮问题（如未作为消息落盘）
  appendUser?: string;
  // 附加引用原文（作为本轮附加内容）
  quoteText?: string | null;
  // 系统提示
  systemPrompt?: string;
}

export function buildContext(card: Card, opts: BuildContextOptions = {}): ChatMessage[] {
  return buildContextWithIds(card, opts).messages;
}

// 同 buildContext，但额外返回每条消息对应的 DB 消息 ID（系统/未落盘为 null）。
// 供自动摘要模块确定被压缩的来源范围与版本。
export function buildContextWithIds(card: Card, opts: BuildContextOptions = {}): { messages: ChatMessage[]; ids: (string | null)[] } {
  const msgs: ChatMessage[] = [];
  const ids: (string | null)[] = [];
  const sys = opts.systemPrompt ?? defaultSystemPrompt();
  if (sys) {
    msgs.push({ role: "system", content: sys });
    ids.push(null);
  }

  // 1) 初始快照消息（继承的祖先上下文）
  if (card.initial_snapshot_id) {
    const snap = repo.snapshots.get(card.initial_snapshot_id);
    if (snap) {
      for (const mid of snap.message_refs) {
        const m = repo.messages.get(mid);
        if (m && m.id !== opts.excludeMessageId) {
          msgs.push({ role: m.role === "system" ? "user" : m.role, content: m.content });
          ids.push(m.id);
        }
      }
    }
  }

  // 2) 该卡片自身消息（按 seq）
  const own = repo.messages.listForCard(card.id);
  for (const m of own) {
    if (m.id === opts.excludeMessageId) continue;
    msgs.push({ role: m.role === "system" ? "user" : m.role, content: m.content });
    ids.push(m.id);
  }

  // 3) 本轮附加（若未落盘）
  if (opts.appendUser) {
    let content = opts.appendUser;
    if (opts.quoteText) {
      content = `> 引用：\n${opts.quoteText}\n\n${content}`;
    }
    msgs.push({ role: "user", content });
    ids.push(null);
  }

  return { messages: msgs, ids };
}

// 构建分叉快照：沿祖先路径截至分叉边界的消息 + 源回答至选区末尾的内容。
// 注意：源回答保留完整原文用于回溯，但子分支上下文截至选区末尾。
export function buildBranchSnapshot(params: {
  conversation_id: string;
  new_card_id: string;
  parent_card_id: string;
  source_message: Message;
  source_message_card: Card;
  selected_text: string;
  // 选区末尾在源回答 plaintext 中的偏移
  selection_end_offset: number;
}): { snapshot_id: string; message_refs: string[] } {
  // 父卡片在分叉点之前的上下文 = 父卡片自身上下文（其快照 + 自身消息直到源消息）
  const parentCard = params.source_message_card;
  const refs: string[] = [];

  // 父卡片初始快照
  if (parentCard.initial_snapshot_id) {
    const snap = repo.snapshots.get(parentCard.initial_snapshot_id);
    if (snap) refs.push(...snap.message_refs);
  }
  // 父卡片自身消息，截至源消息（含源消息）
  const own = repo.messages.listForCard(parentCard.id);
  for (const m of own) {
    refs.push(m.id);
    if (m.id === params.source_message.id) break;
  }

  const snap = repo.snapshots.create({
    card_id: params.new_card_id,
    conversation_id: params.conversation_id,
    message_refs: refs,
    fork_boundary_message_id: params.source_message.id,
  });
  return { snapshot_id: snap.id, message_refs: refs };
}

export function defaultSystemPrompt(): string {
  return [
    "你是 Know Know 的知识探索助手。用户会沿着分支深入探索概念。",
    "请用清晰、准确的中文回答，必要时用 Markdown 结构化。",
    "如果提供了联网检索资料，请基于资料回答并可在文中标注来源 URL；若资料不足请如实说明。",
    "不要捏造来源，不要把模型自身知识说成用户已保存的会话内容。",
  ].join("\n");
}

// 知识助手系统提示
export function assistantSystemPrompt(): string {
  return [
    "你是当前会话的知识助手。你只能依据本会话已保存的消息和资料回答，不使用模型自身的世界知识冒充用户已保存的内容。",
    "回答时在相应位置标注来源（卡片与消息）。若会话中未检索到相关内容，明确说明未检索到。",
    "不要新增探索树节点；不对外搜索。",
  ].join("\n");
}
