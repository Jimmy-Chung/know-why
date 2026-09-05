// 会话内知识检索：FTS5 候选 + 中文词项预处理 + 标题/别名匹配。
// 所有检索强制限定 conversation_id（数据层，不只在提示词要求）。
import { getDb } from "./db.js";
import * as repo from "./repo.js";
import { markdownToPlaintext } from "./selection.js";
import { ulid } from "../shared/ids.js";

// 中文分词：CJK 双字组 + 拉丁按词；用于 FTS 索引与查询。
export function tokenize(text: string): string {
  const out: string[] = [];
  // 提取拉丁词
  const latin = text.match(/[A-Za-z0-9]+/g) || [];
  out.push(...latin);
  // CJK 双字组
  const cjk = text.replace(/[^一-鿿㐀-䶿]/g, " ").split(/\s+/).filter(Boolean);
  for (const seg of cjk) {
    for (let i = 0; i < seg.length - 1; i++) {
      out.push(seg.slice(i, i + 2));
    }
    if (seg.length === 1) out.push(seg);
  }
  return out.join(" ");
}

// 为某会话重建索引（消息变更后调用）
export function indexConversation(conversationId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM knowledge_chunk WHERE conversation_id=?").run(conversationId);
  const msgs = repo.messages.listForConversation(conversationId);
  const stmt = db.prepare(
    "INSERT INTO knowledge_chunk (conversation_id,message_id,card_id,role,text,raw_text,index_version) VALUES (?,?,?,?,?,?,1)",
  );
  for (const m of msgs) {
    if (!m.content.trim()) continue;
    const card = repo.cards.get(m.card_id);
    stmt.run(conversationId, m.id, m.card_id, m.role, tokenize(m.plaintext || markdownToPlaintext(m.content)), m.content);
    void card;
  }
}

// 会话内检索：返回候选证据（card_id, message_id, text, cardTitle, role, anchorId?）
export interface Candidate {
  cardId: string;
  messageId: string;
  role: string;
  text: string;
  cardTitle: string;
  anchorId?: string;
}

export function searchInSession(conversationId: string, question: string, limit = 12): Candidate[] {
  const db = getDb();
  const qTokens = tokenize(question).trim();
  const results: Candidate[] = [];
  const seen = new Set<string>();

  // 1) FTS 匹配
  if (qTokens) {
    const fts = db
      .prepare(
        `SELECT message_id, card_id, role, raw_text FROM knowledge_chunk
         WHERE conversation_id=? AND knowledge_chunk MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(conversationId, qTokens, limit) as any[];
    for (const r of fts) {
      if (seen.has(r.message_id)) continue;
      seen.add(r.message_id);
      results.push({
        cardId: r.card_id,
        messageId: r.message_id,
        role: r.role,
        text: r.raw_text,
        cardTitle: repo.cards.get(r.card_id)?.title || "卡片",
      });
    }
  }

  // 2) 标题/别名精确与子串匹配（短词与中文子串补充）
  const topics = db
    .prepare("SELECT title, aliases, card_ids FROM knowledge_topic WHERE conversation_id=?")
    .all(conversationId) as any[];
  const q = question.toLowerCase();
  for (const t of topics) {
    const names = [t.title, ...(JSON.parse(t.aliases || "[]") as string[])];
    if (names.some((n: string) => n && (q.includes(n.toLowerCase()) || n.toLowerCase().includes(q)))) {
      for (const cardId of JSON.parse(t.card_ids || "[]") as string[]) {
        const msgs = repo.messages.listForCard(cardId);
        for (const m of msgs) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          results.push({
            cardId,
            messageId: m.id,
            role: m.role,
            text: m.content,
            cardTitle: repo.cards.get(cardId)?.title || "卡片",
          });
        }
      }
    }
  }

  // 3) 短查询兜底：直接子串扫描消息 plaintext
  if (results.length < limit && question.length >= 2) {
    const msgs = repo.messages.listForConversation(conversationId);
    for (const m of msgs) {
      if (seen.has(m.id)) continue;
      if (m.plaintext.includes(question)) {
        seen.add(m.id);
        results.push({
          cardId: m.card_id,
          messageId: m.id,
          role: m.role,
          text: m.content,
          cardTitle: repo.cards.get(m.card_id)?.title || "卡片",
        });
      }
    }
  }

  return results.slice(0, limit);
}

// 创建/更新知识主题（探索分支时调用，便于别名检索）
export function upsertTopic(conversationId: string, title: string, cardId: string, aliases: string[] = []): void {
  const db = getDb();
  // 同名只提示候选，不自动合并
  const existing = db
    .prepare("SELECT id, card_ids, aliases FROM knowledge_topic WHERE conversation_id=? AND title=?")
    .get(conversationId, title) as any;
  if (existing) {
    const cardIds = JSON.parse(existing.card_ids || "[]");
    if (!cardIds.includes(cardId)) cardIds.push(cardId);
    db.prepare("UPDATE knowledge_topic SET card_ids=? WHERE id=?").run(JSON.stringify(cardIds), existing.id);
  } else {
    const id = ulid();
    db.prepare(
      "INSERT INTO knowledge_topic (id,conversation_id,title,aliases,card_ids,created_at) VALUES (?,?,?,?,?,?)",
    ).run(id, conversationId, title, JSON.stringify(aliases), JSON.stringify([cardId]), new Date().toISOString());
  }
}
