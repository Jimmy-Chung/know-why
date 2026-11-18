// 会话内知识检索：FTS5 候选 + 中文词项预处理 + 标题/别名匹配。
// 所有检索强制限定 conversation_id（数据层，不只在提示词要求）。
import { createHash } from "node:crypto";
import { getDbPath, getDb } from "./db.js";
import * as repo from "./repo.js";
import { markdownToPlaintext } from "./selection.js";
import { isOverview } from "./rag.js";
import { ulid } from "../shared/ids.js";

// 查询侧停用双字组：高频结构词切出的双字组，单独无区分度，
// 会召回大量无关消息并干扰 rank 排序。仅在查询时过滤，索引侧保留完整。
// （单字虚词如「的」「是」「了」切不出双字组，故不在此列。）
const QUERY_STOPWORDS = new Set([
  "人的", "的事", "的话", "的时", "的方", "的过", "的信", "的意", "的关", "的作",
  "是一", "是的", "是什", "是怎", "是为",
  "了我", "了这", "了那",
  "在这", "在那", "在什",
  "可以", "可的",
  "什么", "怎么", "如何",
  "关于", "对于", "以及",
  "信息", "内容", "资料", "介绍", "解释", "背景", "含义",
  "的话", "的话",
]);

// 从查询 token 列表里剔除停用双字组，保留有区分度的核心词
function filterQueryTokens(tokens: string): string {
  return tokens
    .split(/\s+/)
    .filter((t) => t && !QUERY_STOPWORDS.has(t))
    .join(" ");
}

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

export interface Candidate {
  passageId: number;
  cardId: string;
  messageId: string;
  role: string;
  text: string;
  question: string;
  cardTitle: string;
  path: string;
  createdAt: string;
  startOffset: number;
  endOffset: number;
  score: number;
  anchorId?: string;
}
interface PassageRow {
  id: number; conversation_id: string; message_id: string; card_id: string;
  role: string; ordinal: number; start_offset: number; end_offset: number;
  text: string; question: string; card_title: string; path: string;
  created_at: string; fingerprint: string;
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

// Paragraphs stay intact when small; long paragraphs split at sentence boundaries.
// Keep offsets in plaintext for exact source excerpts. No overlapping duplicate passages.
export function splitPassages(text: string, maxChars = 360): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  for (const match of text.matchAll(/[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g)) {
    let start = match.index!;
    const end = start + match[0].length;
    while (start < end) {
      let stop = Math.min(start + maxChars, end);
      if (stop < end) {
        const part = text.slice(start, stop);
        const boundaries = [...part.matchAll(/[。！？.!?；;\n]\s*/g)];
        const last = boundaries.at(-1);
        if (last && last.index! > maxChars / 2) stop = start + last.index! + last[0].length;
      }
      const raw = text.slice(start, stop);
      const leading = raw.length - raw.trimStart().length;
      const body = raw.trim();
      if (body) out.push({ text: body, start: start + leading, end: start + leading + body.length });
      start = stop;
    }
  }
  return out;
}

// Scan source rows, but only rewrite passages whose content/context changed.
// Snapshots reference messages; never expand snapshots into duplicate knowledge records.
export function indexConversation(conversationId: string): void {
  const db = getDb();
  const conv = repo.conversations.get(conversationId);
  if (!conv || conv.deleted_at) return;
  const state = db.prepare("SELECT dirty FROM knowledge_index_state WHERE conversation_id=?").get(conversationId) as {dirty:number} | undefined;
  if (state?.dirty === 0) return;
  const cards = repo.cards.listForConversation(conversationId);
  const cardMap = new Map(cards.map(c => [c.id, c]));
  const pathFor = (id: string) => {
    const titles: string[] = []; const visited = new Set<string>();
    let card = cardMap.get(id);
    while (card && !visited.has(card.id)) {
      visited.add(card.id); titles.unshift(card.title || "主卡片");
      card = card.parent_card_id ? cardMap.get(card.parent_card_id) : undefined;
    }
    return titles.join(" > ");
  };
  const messages = repo.messages.listForConversation(conversationId).sort((a,b) => a.card_id.localeCompare(b.card_id) || a.seq - b.seq);
  const old = new Map((db.prepare("SELECT message_id,fingerprint FROM knowledge_index_message WHERE conversation_id=?").all(conversationId) as { message_id: string; fingerprint: string }[]).map(r => [r.message_id, r.fingerprint]));
  const live = new Set<string>();
  const previousQuestion = new Map<string, string>();
  let changed = false;
  db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO knowledge_index_state(conversation_id) VALUES(?)").run(conversationId);
    for (const m of messages) {
      if (m.knowledge_excluded) continue;
      if (m.status !== "complete" || !["user", "assistant"].includes(m.role) || !m.content.trim()) continue;
      const text = m.plaintext || markdownToPlaintext(m.content);
      if (m.role === "user") previousQuestion.set(m.card_id, text);
      const question = m.role === "assistant" ? previousQuestion.get(m.card_id) || "" : "";
      const title = cardMap.get(m.card_id)?.title || "主卡片";
      const path = pathFor(m.card_id);
      const fingerprint = digest(JSON.stringify([2, text, question, path, m.role, m.version]));
      live.add(m.id);
      if (old.get(m.id) === fingerprint) continue;
      changed = true;
      db.prepare("DELETE FROM knowledge_passage WHERE message_id=?").run(m.id);
      const insert = db.prepare(`INSERT INTO knowledge_passage
        (conversation_id,message_id,card_id,role,ordinal,start_offset,end_offset,text,question,card_title,path,created_at,fingerprint,tokens)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      splitPassages(text).forEach((part, ordinal) => {
        insert.run(conversationId,m.id,m.card_id,m.role,ordinal,part.start,part.end,part.text,question.slice(0,240),title,path,m.created_at,fingerprint,
          tokenize(`${title} ${part.text} ${question.slice(0,120)}`));
      });
      db.prepare(`INSERT INTO knowledge_index_message VALUES(?,?,?) ON CONFLICT(message_id) DO UPDATE SET fingerprint=excluded.fingerprint`).run(m.id, conversationId, fingerprint);
    }
    for (const id of old.keys()) if (!live.has(id)) {
      changed = true;
      db.prepare("DELETE FROM knowledge_passage WHERE message_id=?").run(id);
      db.prepare("DELETE FROM knowledge_index_message WHERE message_id=?").run(id);
    }
    db.prepare("UPDATE knowledge_index_state SET dirty=0,revision=revision+? WHERE conversation_id=?").run(Number(changed),conversationId);
  })();
}

interface SearchResult { candidates: Candidate[]; cacheHit: boolean; semanticReady: boolean; revision: string }
const searchCache = new Map<string, { value: SearchResult; expires: number }>();
function candidate(row: PassageRow, score: number): Candidate {
  return { passageId:row.id, cardId:row.card_id, messageId:row.message_id, role:row.role,
    text:row.text, question:row.question, cardTitle:row.card_title, path:row.path, createdAt:row.created_at,
    startOffset:row.start_offset,endOffset:row.end_offset,score };
}

export async function retrievePassages(conversationId: string, question: string, limit = 40, signal?: AbortSignal, scopeCardIds?: string[] | null): Promise<SearchResult> {
  signal?.throwIfAborted();
  indexConversation(conversationId); // also upgrades old sessions lazily, without modifying source history
  const db = getDb();
  const conv = repo.conversations.get(conversationId);
  if (!conv || conv.deleted_at) return { candidates:[],cacheHit:false,semanticReady:false,revision:"missing" };
  // 作用域：@ 指定的卡片集合。校验归属本会话后取交集；空/非法 → 全会话（null）。
  let scope: Set<string> | null = null;
  if (scopeCardIds && scopeCardIds.length) {
    const convCards = new Set(repo.cards.listForConversation(conversationId).map(c => c.id));
    const filtered = scopeCardIds.filter(id => convCards.has(id));
    if (filtered.length) scope = new Set(filtered);
  }
  const scopeClause = scope && scope.size ? `AND p.card_id IN (${[...scope].map(() => "?").join(",")})` : "";
  const scopeParams = scope && scope.size ? [...scope] : [];
  const state = db.prepare("SELECT * FROM knowledge_index_state WHERE conversation_id=?").get(conversationId) as { revision:number; vector_revision:number };
  const revision = `${state.revision}:${state.vector_revision}:${scope ? [...scope].sort().join(",") : "all"}`;
  // 语义检索已移除：只用关键词召回，知识助手的语义能力由会话模型自行处理。
  const semanticReady = false;
  signal?.throwIfAborted();
  const key = JSON.stringify([getDbPath(),conversationId,revision,semanticReady,question,limit]);
  const cached = searchCache.get(key);
  if (cached && cached.expires > Date.now()) return { ...cached.value, candidates:cached.value.candidates.map(c=>({...c})),cacheHit:true };

  const ranks = new Map<number,{row:PassageRow; score:number}>();
  const add = (rows: PassageRow[], weight=1) => rows.forEach((row,rank) => {
    const item = ranks.get(row.id) || {row,score:0}; item.score += weight/(60+rank+1); ranks.set(row.id,item);
  });
  const terms = [...new Set(filterQueryTokens(tokenize(question)).split(/\s+/).filter(Boolean))].slice(0,64);
  if (terms.length) {
    const query = terms.map(t => `"${t}"`).join(" OR ");
    add(db.prepare(`SELECT p.* FROM knowledge_passage_fts f JOIN knowledge_passage p ON p.id=f.rowid
      WHERE knowledge_passage_fts MATCH ? AND p.conversation_id=? ${scopeClause} ORDER BY rank LIMIT 60`).all(query,conversationId,...scopeParams) as PassageRow[]);
  }
  // Topic boosts are bounded, and never supply messages from outside this conversation.
  const topics = db.prepare("SELECT title,aliases,card_ids FROM knowledge_topic WHERE conversation_id=?").all(conversationId) as any[];
  const titleIds = new Set<string>();
  const q = question.toLowerCase();
  for (const topic of topics) {
    const names = [topic.title,...JSON.parse(topic.aliases || "[]")];
    if (names.some((n:string)=>n && q.includes(n.toLowerCase()))) for (const id of JSON.parse(topic.card_ids)) titleIds.add(id);
  }
  for (const c of repo.cards.listForConversation(conversationId)) if (c.title && c.parent_card_id && q.includes(c.title.toLowerCase())) titleIds.add(c.id);
  // 作用域限定：topic/title 命中的卡片必须也在 scope 内
  if (scope) for (const id of [...titleIds]) if (!scope.has(id)) titleIds.delete(id);
  for (const id of titleIds) {
    add(db.prepare("SELECT * FROM knowledge_passage WHERE conversation_id=? AND card_id=? ORDER BY ordinal,id LIMIT 12").all(conversationId,id) as PassageRow[],.6);
  }
  if (isOverview(question)) {
    const representatives = db.prepare(`SELECT * FROM (
      SELECT p.*, ROW_NUMBER() OVER(PARTITION BY card_id ORDER BY CASE role WHEN 'assistant' THEN 0 ELSE 1 END, created_at DESC, ordinal) AS position
      FROM knowledge_passage p WHERE p.conversation_id=? ${scopeClause}
    ) WHERE position=1 ORDER BY created_at DESC LIMIT 40`).all(conversationId,...scopeParams) as PassageRow[];
    add(representatives,1.2);
  }
  signal?.throwIfAborted();
  // Re-check after asynchronous inference: edits/deletes may have invalidated candidates.
  indexConversation(conversationId);
  if (!repo.conversations.get(conversationId) || repo.conversations.get(conversationId)?.deleted_at) return {candidates:[],cacheHit:false,semanticReady,revision};
  const live = new Set((db.prepare("SELECT id FROM knowledge_passage WHERE conversation_id=?").all(conversationId) as {id:number}[]).map(r=>r.id));
  const candidates = [...ranks.values()].filter(r=>live.has(r.row.id)).sort((a,b)=>b.score-a.score || a.row.id-b.row.id)
    .slice(0,Math.max(1,Math.min(limit,80))).map(r=>candidate(r.row,r.score));
  const result = {candidates,cacheHit:false,semanticReady,revision};
  searchCache.set(key,{value:result,expires:Date.now()+60_000});
  while (searchCache.size>64) searchCache.delete(searchCache.keys().next().value!);
  return {...result,candidates:candidates.map(c=>({...c}))};
}

export async function searchInSession(conversationId: string, question: string, limit = 12): Promise<Candidate[]> {
  return (await retrievePassages(conversationId,question,limit)).candidates;
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
    db.prepare("UPDATE knowledge_topic SET card_ids=?, aliases=? WHERE id=?").run(JSON.stringify(cardIds),JSON.stringify([...new Set([...JSON.parse(existing.aliases || "[]"),...aliases])]),existing.id);
  } else {
    const id = ulid();
    db.prepare(
      "INSERT INTO knowledge_topic (id,conversation_id,title,aliases,card_ids,created_at) VALUES (?,?,?,?,?,?)",
    ).run(id, conversationId, title, JSON.stringify(aliases), JSON.stringify([cardId]), new Date().toISOString());
  }
}
