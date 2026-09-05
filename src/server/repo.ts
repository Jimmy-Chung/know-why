// 数据访问层。所有 SQL 集中于此，路由与编排层只调用函数。
import type { Database as DBType } from "better-sqlite3";
import { ulid } from "../shared/ids.js";
import type {
  ProviderConfig,
  ProviderCapabilities,
  ProviderType,
  SearchConfig,
  Conversation,
  Card,
  Message,
  MessageRole,
  MessageStatus,
  SelectionAnchor,
  ContextSnapshot,
  Run,
  RunPurpose,
  RunStatus,
  Source,
  SummaryRecord,
  WebMode,
  ThinkMode,
  KnowledgeAssistantMessage,
  Draft,
  ViewState,
} from "../shared/types.js";
import { getDb } from "./db.js";

type Row = Record<string, any>;

function rowToProvider(r: any): ProviderConfig {
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    api_base: r.api_base,
    default_model: r.default_model,
    is_default: !!r.is_default,
    config_version: r.config_version,
    capabilities: JSON.parse(r.capabilities || "{}"),
    has_secret: !!r.has_secret,
    secret_ref: r.secret_ref,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export const providers = {
  list(): ProviderConfig[] {
    return getDb()
      .prepare("SELECT * FROM provider_config WHERE disabled=0 ORDER BY is_default DESC, created_at")
      .all()
      .map(rowToProvider);
  },
  get(id: string): ProviderConfig | null {
    const r = getDb().prepare("SELECT * FROM provider_config WHERE id=?").get(id) as Row | undefined;
    return r ? rowToProvider(r) : null;
  },
  create(input: {
    type: ProviderType;
    name: string;
    api_base: string;
    default_model: string;
    is_default: boolean;
    capabilities: ProviderCapabilities;
    secret_ref: string;
    has_secret: boolean;
  }): ProviderConfig {
    const now = new Date().toISOString();
    const id = ulid();
    if (input.is_default) {
      getDb().prepare("UPDATE provider_config SET is_default=0").run();
    }
    getDb()
      .prepare(
        "INSERT INTO provider_config (id,type,name,api_base,default_model,is_default,config_version,capabilities,secret_ref,has_secret,disabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)",
      )
      .run(
        id,
        input.type,
        input.name,
        input.api_base,
        input.default_model,
        input.is_default ? 1 : 0,
        1,
        JSON.stringify(input.capabilities),
        input.secret_ref,
        input.has_secret ? 1 : 0,
        now,
        now,
      );
    return this.get(id)!;
  },
  update(
    id: string,
    patch: Partial<{
      name: string;
      api_base: string;
      default_model: string;
      is_default: boolean;
      capabilities: ProviderCapabilities;
      has_secret: boolean;
    }>,
  ): ProviderConfig | null {
    const cur = this.get(id);
    if (!cur) return null;
    const now = new Date().toISOString();
    const next = { ...cur, ...patch, config_version: cur.config_version + 1, updated_at: now };
    if (patch.is_default) {
      getDb().prepare("UPDATE provider_config SET is_default=0 WHERE id<>?").run(id);
    }
    getDb()
      .prepare(
        "UPDATE provider_config SET name=?,api_base=?,default_model=?,is_default=?,capabilities=?,has_secret=?,config_version=?,updated_at=? WHERE id=?",
      )
      .run(
        next.name,
        next.api_base,
        next.default_model,
        next.is_default ? 1 : 0,
        JSON.stringify(next.capabilities),
        next.has_secret ? 1 : 0,
        next.config_version,
        now,
        id,
      );
    return this.get(id);
  },
  setDefault(id: string): void {
    getDb().exec("BEGIN");
    try {
      getDb().prepare("UPDATE provider_config SET is_default=0").run();
      getDb().prepare("UPDATE provider_config SET is_default=1 WHERE id=?").run(id);
      getDb().exec("COMMIT");
    } catch {
      getDb().exec("ROLLBACK");
      throw new Error("set default failed");
    }
  },
  disable(id: string): void {
    getDb().prepare("UPDATE provider_config SET disabled=1, is_default=0 WHERE id=?").run(id);
  },
  defaultProvider(): ProviderConfig | null {
    const r = getDb()
      .prepare("SELECT * FROM provider_config WHERE is_default=1 AND disabled=0 LIMIT 1")
      .get() as Row | undefined;
    if (r) return rowToProvider(r);
    const any = getDb()
      .prepare("SELECT * FROM provider_config WHERE disabled=0 ORDER BY created_at LIMIT 1")
      .get() as Row | undefined;
    return any ? rowToProvider(any) : null;
  },
};

export const search = {
  get(): SearchConfig | null {
    const r = getDb()
      .prepare("SELECT * FROM search_config WHERE enabled=1 ORDER BY created_at LIMIT 1")
      .get() as Row | undefined;
    if (!r) return null;
    return {
      id: r.id,
      provider: r.provider,
      api_base: r.api_base,
      config_version: r.config_version,
      has_secret: !!r.has_secret,
      enabled: !!r.enabled,
      secret_ref: r.secret_ref,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  },
  upsert(input: { provider: "tavily"; api_base: string; has_secret: boolean; secret_ref: string; enabled: boolean }): SearchConfig {
    const now = new Date().toISOString();
    const cur = getDb().prepare("SELECT * FROM search_config LIMIT 1").get() as Row | undefined;
    if (cur) {
      getDb()
        .prepare(
          "UPDATE search_config SET provider=?,api_base=?,has_secret=?,secret_ref=?,enabled=?,config_version=config_version+1,updated_at=? WHERE id=?",
        )
        .run(input.provider, input.api_base, input.has_secret ? 1 : 0, input.secret_ref, input.enabled ? 1 : 0, now, cur.id);
      return this.get()!;
    }
    const id = ulid();
    getDb()
      .prepare(
        "INSERT INTO search_config (id,provider,api_base,config_version,secret_ref,has_secret,enabled,created_at,updated_at) VALUES (?,?,?,1,?,?,?, ?,?)",
      )
      .run(id, input.provider, input.api_base, input.secret_ref, input.has_secret ? 1 : 0, input.enabled ? 1 : 0, now, now);
    return this.get()!;
  },
};

function rowToConversation(r: any): Conversation {
  return {
    id: r.id,
    title: r.title,
    provider_id: r.provider_id,
    provider_type: r.type,
    provider_config_version: r.provider_config_version,
    model: r.model,
    locked: !!r.locked,
    locked_at: r.locked_at,
    web_mode: r.web_mode,
    think_mode: r.think_mode,
    deleted: !!r.deleted,
    deleted_at: r.deleted_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export const conversations = {
  list(): Conversation[] {
    return getDb()
      .prepare("SELECT c.*, p.type FROM conversation c JOIN provider_config p ON c.provider_id=p.id WHERE c.deleted=0 ORDER BY c.updated_at DESC")
      .all()
      .map(rowToConversation);
  },
  deleted(): Conversation[] {
    return getDb()
      .prepare("SELECT c.*, p.type FROM conversation c JOIN provider_config p ON c.provider_id=p.id WHERE c.deleted=1 ORDER BY c.deleted_at DESC")
      .all()
      .map(rowToConversation);
  },
  get(id: string): Conversation | null {
    const r = getDb()
      .prepare("SELECT c.*, p.type FROM conversation c JOIN provider_config p ON c.provider_id=p.id WHERE c.id=?")
      .get(id) as Row | undefined;
    return r ? rowToConversation(r) : null;
  },
  create(provider: ProviderConfig, model: string, webMode: WebMode, thinkMode: ThinkMode): Conversation {
    const now = new Date().toISOString();
    const id = ulid();
    getDb()
      .prepare(
        "INSERT INTO conversation (id,title,provider_id,provider_type,provider_config_version,model,locked,locked_at,web_mode,think_mode,deleted,created_at,updated_at) VALUES (?,?,?,?,?,?,0,NULL,?,?,0,?,?)",
      )
      .run(id, "新会话", provider.id, provider.type, provider.config_version, model, webMode, thinkMode, now, now);
    return this.get(id)!;
  },
  rename(id: string, title: string): void {
    getDb().prepare("UPDATE conversation SET title=?, updated_at=? WHERE id=?").run(title, new Date().toISOString(), id);
  },
  setSettings(id: string, patch: { web_mode?: WebMode; think_mode?: ThinkMode }): void {
    const sets: string[] = [];
    const vals: any[] = [];
    if (patch.web_mode) {
      sets.push("web_mode=?");
      vals.push(patch.web_mode);
    }
    if (patch.think_mode) {
      sets.push("think_mode=?");
      vals.push(patch.think_mode);
    }
    if (!sets.length) return;
    sets.push("updated_at=?");
    vals.push(new Date().toISOString());
    vals.push(id);
    getDb().prepare(`UPDATE conversation SET ${sets.join(",")} WHERE id=?`).run(...vals);
  },
  lock(id: string): void {
    const now = new Date().toISOString();
    getDb().prepare("UPDATE conversation SET locked=1, locked_at=?, updated_at=? WHERE id=?").run(now, now, id);
  },
  softDelete(id: string): void {
    getDb().prepare("UPDATE conversation SET deleted=1, deleted_at=?, updated_at=? WHERE id=?").run(
      new Date().toISOString(),
      new Date().toISOString(),
      id,
    );
  },
  restore(id: string): void {
    getDb().prepare("UPDATE conversation SET deleted=0, deleted_at=NULL, updated_at=? WHERE id=?").run(
      new Date().toISOString(),
      id,
    );
  },
  purge(id: string): void {
    // 永久清理：级联删除该会话全部数据
    getDb().exec("BEGIN");
    try {
      const db = getDb();
      db.prepare("DELETE FROM source WHERE conversation_id=?").run(id);
      db.prepare("DELETE FROM knowledge_assistant_message WHERE conversation_id=?").run(id);
      db.prepare("DELETE FROM knowledge_chunk WHERE conversation_id=?").run(id);
      db.prepare("DELETE FROM knowledge_topic WHERE conversation_id=?").run(id);
      db.prepare("DELETE FROM summary_record WHERE conversation_id=?").run(id);
      db.prepare("DELETE FROM run WHERE conversation_id=?").run(id);
      db.prepare("DELETE FROM message_quote WHERE anchor_id IN (SELECT id FROM selection_anchor WHERE conversation_id=?)").run(id);
      db.prepare("DELETE FROM selection_anchor WHERE conversation_id=?").run(id);
      db.prepare("DELETE FROM draft WHERE card_id IN (SELECT id FROM card WHERE conversation_id=?)").run(id);
      db.prepare("DELETE FROM message WHERE conversation_id=?").run(id);
      db.prepare("DELETE FROM context_snapshot WHERE conversation_id=?").run(id);
      db.prepare("DELETE FROM card WHERE conversation_id=?").run(id);
      db.prepare("DELETE FROM view_state WHERE conversation_id=?").run(id);
      db.prepare("DELETE FROM conversation WHERE id=?").run(id);
      getDb().exec("COMMIT");
    } catch (e) {
      getDb().exec("ROLLBACK");
      throw e;
    }
  },
};

export const cards = {
  listForConversation(conversationId: string): Card[] {
    return getDb()
      .prepare("SELECT * FROM card WHERE conversation_id=? ORDER BY created_at")
      .all(conversationId)
      .map((r: any) => ({
        id: r.id,
        conversation_id: r.conversation_id,
        parent_card_id: r.parent_card_id,
        title: r.title,
        source_anchor_id: r.source_anchor_id,
        initial_snapshot_id: r.initial_snapshot_id,
        created_at: r.created_at,
      }));
  },
  get(id: string): Card | null {
    const r = getDb().prepare("SELECT * FROM card WHERE id=?").get(id) as Row | undefined;
    return r
      ? {
          id: r.id,
          conversation_id: r.conversation_id,
          parent_card_id: r.parent_card_id,
          title: r.title,
          source_anchor_id: r.source_anchor_id,
          initial_snapshot_id: r.initial_snapshot_id,
          created_at: r.created_at,
        }
      : null;
  },
  createMain(conversationId: string): Card {
    const now = new Date().toISOString();
    const id = ulid();
    getDb()
      .prepare(
        "INSERT INTO card (id,conversation_id,parent_card_id,title,source_anchor_id,initial_snapshot_id,created_at) VALUES (?,?,NULL,'主卡片',NULL,NULL,?)",
      )
      .run(id, conversationId, now);
    return this.get(id)!;
  },
  createBranch(input: {
    conversation_id: string;
    parent_card_id: string;
    source_anchor_id: string;
    initial_snapshot_id: string;
    title: string;
  }): Card {
    const now = new Date().toISOString();
    const id = ulid();
    getDb()
      .prepare(
        "INSERT INTO card (id,conversation_id,parent_card_id,title,source_anchor_id,initial_snapshot_id,created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(id, input.conversation_id, input.parent_card_id, input.title, input.source_anchor_id, input.initial_snapshot_id, now);
    return this.get(id)!;
  },
  updateTitle(id: string, title: string): void {
    getDb().prepare("UPDATE card SET title=? WHERE id=?").run(title, id);
  },
  // 构建祖先路径（从根到当前卡片）
  ancestorPath(cardId: string): Card[] {
    const path: Card[] = [];
    let cur = this.get(cardId);
    while (cur) {
      path.unshift(cur);
      cur = cur.parent_card_id ? this.get(cur.parent_card_id) : null;
    }
    return path;
  },
  children(cardId: string): Card[] {
    return getDb()
      .prepare("SELECT * FROM card WHERE parent_card_id=? ORDER BY created_at")
      .all(cardId)
      .map((r: any) => this.get(r.id)!);
  },
};

function rowToMessage(r: any): Message {
  return {
    id: r.id,
    card_id: r.card_id,
    conversation_id: r.conversation_id,
    role: r.role,
    content: r.content,
    plaintext: r.plaintext,
    version: r.version,
    status: r.status,
    seq: r.seq,
    run_id: r.run_id,
    model: r.model,
    provider_type: r.provider_type,
    web_mode: r.web_mode,
    think_mode: r.think_mode,
    error: r.error,
    created_at: r.created_at,
    updated_at: r.updated_at,
    quote_anchor_id: r.quote_anchor_id,
  };
}

export const messages = {
  listForCard(cardId: string): Message[] {
    return getDb()
      .prepare("SELECT * FROM message WHERE card_id=? ORDER BY seq")
      .all(cardId)
      .map(rowToMessage);
  },
  listForConversation(conversationId: string): Message[] {
    return getDb()
      .prepare("SELECT * FROM message WHERE conversation_id=? ORDER BY created_at")
      .all(conversationId)
      .map(rowToMessage);
  },
  get(id: string): Message | null {
    const r = getDb().prepare("SELECT * FROM message WHERE id=?").get(id) as Row | undefined;
    return r ? rowToMessage(r) : null;
  },
  nextSeq(cardId: string): number {
    const r = getDb()
      .prepare("SELECT MAX(seq) AS m FROM message WHERE card_id=?")
      .get(cardId) as Row | undefined;
    return (r?.m ?? -1) + 1;
  },
  create(input: {
    card_id: string;
    conversation_id: string;
    role: MessageRole;
    content: string;
    plaintext: string;
    status: MessageStatus;
    run_id?: string | null;
    model?: string | null;
    provider_type?: ProviderType | null;
    web_mode?: WebMode | null;
    think_mode?: ThinkMode | null;
    quote_anchor_id?: string | null;
  }): Message {
    const now = new Date().toISOString();
    const id = ulid();
    const seq = this.nextSeq(input.card_id);
    getDb()
      .prepare(
        "INSERT INTO message (id,card_id,conversation_id,role,content,plaintext,version,status,seq,run_id,model,provider_type,web_mode,think_mode,error,quote_anchor_id,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?,?,NULL,?,?,?)",
      )
      .run(
        id,
        input.card_id,
        input.conversation_id,
        input.role,
        input.content,
        input.plaintext,
        input.status,
        seq,
        input.run_id ?? null,
        input.model ?? null,
        input.provider_type ?? null,
        input.web_mode ?? null,
        input.think_mode ?? null,
        input.quote_anchor_id ?? null,
        now,
        now,
      );
    return this.get(id)!;
  },
  appendDelta(id: string, delta: string): void {
    // 流式增量追加。单次事务。
    getDb()
      .prepare("UPDATE message SET content = content || ?, updated_at=? WHERE id=?")
      .run(delta, new Date().toISOString(), id);
  },
  setContent(id: string, content: string): void {
    // 流式落盘：整体覆盖 content 与 plaintext。
    getDb()
      .prepare("UPDATE message SET content=?, plaintext=?, updated_at=? WHERE id=?")
      .run(content, content, new Date().toISOString(), id);
  },
  setStatus(id: string, status: MessageStatus, error?: string | null): void {
    getDb()
      .prepare("UPDATE message SET status=?, error=?, updated_at=? WHERE id=?")
      .run(status, error ?? null, new Date().toISOString(), id);
  },
  bindRun(id: string, runId: string): void {
    getDb().prepare("UPDATE message SET run_id=? WHERE id=?").run(runId, id);
  },
  // 改动内容生成新版本，保留旧版本锚点可用
  newVersion(id: string): void {
    getDb().prepare("UPDATE message SET version = version + 1 WHERE id=?").run(id);
  },
};

export const anchors = {
  get(id: string): SelectionAnchor | null {
    const r = getDb().prepare("SELECT * FROM selection_anchor WHERE id=?").get(id) as Row | undefined;
    return r
      ? {
          id: r.id,
          source_message_id: r.source_message_id,
          source_message_version: r.source_message_version,
          card_id: r.card_id,
          conversation_id: r.conversation_id,
          selected_text: r.selected_text,
          start_offset: r.start_offset,
          end_offset: r.end_offset,
          prefix: r.prefix,
          suffix: r.suffix,
          branch_card_id: r.branch_card_id,
          created_at: r.created_at,
        }
      : null;
  },
  create(input: {
    source_message_id: string;
    source_message_version: number;
    card_id: string;
    conversation_id: string;
    selected_text: string;
    start_offset: number;
    end_offset: number;
    prefix: string;
    suffix: string;
  }): SelectionAnchor {
    const id = ulid();
    const now = new Date().toISOString();
    getDb()
      .prepare(
        "INSERT INTO selection_anchor (id,source_message_id,source_message_version,card_id,conversation_id,selected_text,start_offset,end_offset,prefix,suffix,branch_card_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?)",
      )
      .run(id, input.source_message_id, input.source_message_version, input.card_id, input.conversation_id, input.selected_text, input.start_offset, input.end_offset, input.prefix, input.suffix, now);
    return this.get(id)!;
  },
  setBranch(anchorId: string, branchCardId: string): void {
    getDb().prepare("UPDATE selection_anchor SET branch_card_id=? WHERE id=?").run(branchCardId, anchorId);
  },
  forMessage(messageId: string): SelectionAnchor[] {
    return getDb()
      .prepare("SELECT * FROM selection_anchor WHERE source_message_id=? ORDER BY start_offset")
      .all(messageId)
      .map((r: any) => this.get(r.id)!);
  },
};

export const quotes = {
  link(messageId: string, anchorId: string): void {
    getDb()
      .prepare("INSERT OR IGNORE INTO message_quote (message_id,anchor_id) VALUES (?,?)")
      .run(messageId, anchorId);
  },
};

export const snapshots = {
  create(input: {
    card_id: string;
    conversation_id: string;
    message_refs: string[];
    fork_boundary_message_id: string | null;
    summary_version?: number | null;
  }): ContextSnapshot {
    const id = ulid();
    const now = new Date().toISOString();
    getDb()
      .prepare(
        "INSERT INTO context_snapshot (id,card_id,conversation_id,message_refs,fork_boundary_message_id,summary_version,created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(id, input.card_id, input.conversation_id, JSON.stringify(input.message_refs), input.fork_boundary_message_id, input.summary_version ?? null, now);
    return {
      id,
      card_id: input.card_id,
      conversation_id: input.conversation_id,
      message_refs: input.message_refs,
      fork_boundary_message_id: input.fork_boundary_message_id,
      summary_version: input.summary_version ?? null,
      created_at: now,
    };
  },
  get(id: string): ContextSnapshot | null {
    const r = getDb().prepare("SELECT * FROM context_snapshot WHERE id=?").get(id) as Row | undefined;
    return r
      ? {
          id: r.id,
          card_id: r.card_id,
          conversation_id: r.conversation_id,
          message_refs: JSON.parse(r.message_refs),
          fork_boundary_message_id: r.fork_boundary_message_id,
          summary_version: r.summary_version,
          created_at: r.created_at,
        }
      : null;
  },
};

function rowToRun(r: any): Run {
  return {
    id: r.id,
    conversation_id: r.conversation_id,
    card_id: r.card_id,
    message_id: r.message_id,
    purpose: r.purpose,
    status: r.status,
    model: r.model,
    provider_type: r.provider_type,
    provider_config_version: r.provider_config_version,
    web_mode: r.web_mode,
    think_mode: r.think_mode,
    usage: r.usage ? JSON.parse(r.usage) : null,
    error: r.error,
    idempotency_key: r.idempotency_key,
    sources: JSON.parse(r.sources || "[]"),
    created_at: r.created_at,
    finished_at: r.finished_at,
  };
}

export const runs = {
  create(input: {
    conversation_id: string;
    card_id: string;
    message_id: string | null;
    purpose: RunPurpose;
    model: string;
    provider_type: ProviderType;
    provider_config_version: number;
    web_mode: WebMode;
    think_mode: ThinkMode;
    idempotency_key: string;
  }): Run {
    const now = new Date().toISOString();
    const id = ulid();
    getDb()
      .prepare(
        "INSERT INTO run (id,conversation_id,card_id,message_id,purpose,status,model,provider_type,provider_config_version,web_mode,think_mode,usage,error,idempotency_key,sources,created_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'[]',?,NULL)",
      )
      .run(id, input.conversation_id, input.card_id, input.message_id, input.purpose, "queued", input.model, input.provider_type, input.provider_config_version, input.web_mode, input.think_mode, null, null, input.idempotency_key, now);
    return this.get(id)!;
  },
  get(id: string): Run | null {
    const r = getDb().prepare("SELECT * FROM run WHERE id=?").get(id) as Row | undefined;
    return r ? rowToRun(r) : null;
  },
  getByIdem(key: string): Run | null {
    const r = getDb().prepare("SELECT * FROM run WHERE idempotency_key=?").get(key) as Row | undefined;
    return r ? rowToRun(r) : null;
  },
  update(id: string, patch: Partial<{ status: RunStatus; error: string | null; usage: any; finished_at: string; sources: string[]; message_id: string }>): void {
    const sets: string[] = [];
    const vals: any[] = [];
    if (patch.status !== undefined) {
      sets.push("status=?");
      vals.push(patch.status);
    }
    if (patch.error !== undefined) {
      sets.push("error=?");
      vals.push(patch.error);
    }
    if (patch.usage !== undefined) {
      sets.push("usage=?");
      vals.push(JSON.stringify(patch.usage));
    }
    if (patch.sources !== undefined) {
      sets.push("sources=?");
      vals.push(JSON.stringify(patch.sources));
    }
    if (patch.message_id !== undefined) {
      sets.push("message_id=?");
      vals.push(patch.message_id);
    }
    if (patch.finished_at !== undefined) {
      sets.push("finished_at=?");
      vals.push(patch.finished_at);
    }
    if (!sets.length) return;
    vals.push(id);
    getDb().prepare(`UPDATE run SET ${sets.join(",")} WHERE id=?`).run(...vals);
  },
};

export const sources = {
  create(input: {
    run_id: string;
    conversation_id: string;
    url: string;
    title: string;
    snippet: string;
    content_kind: "full" | "snippet" | "search_summary";
    citation_message_id?: string | null;
  }): Source {
    const id = ulid();
    const now = new Date().toISOString();
    getDb()
      .prepare(
        "INSERT INTO source (id,run_id,conversation_id,url,title,retrieved_at,snippet,content_kind,citation_message_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(id, input.run_id, input.conversation_id, input.url, input.title, now, input.snippet, input.content_kind, input.citation_message_id ?? null, now);
    return {
      id,
      run_id: input.run_id,
      conversation_id: input.conversation_id,
      url: input.url,
      title: input.title,
      retrieved_at: now,
      snippet: input.snippet,
      content_kind: input.content_kind,
      citation_message_id: input.citation_message_id ?? null,
    };
  },
  forRun(runId: string): Source[] {
    return getDb().prepare("SELECT * FROM source WHERE run_id=? ORDER BY created_at").all(runId).map((r: any) => ({
      id: r.id,
      run_id: r.run_id,
      conversation_id: r.conversation_id,
      url: r.url,
      title: r.title,
      retrieved_at: r.retrieved_at,
      snippet: r.snippet,
      content_kind: r.content_kind,
      citation_message_id: r.citation_message_id,
    }));
  },
};

export const drafts = {
  get(cardId: string): Draft | null {
    const r = getDb().prepare("SELECT * FROM draft WHERE card_id=?").get(cardId) as Row | undefined;
    return r ? { card_id: r.card_id, text: r.text, pending_quote_anchor_id: r.pending_quote_anchor_id, updated_at: r.updated_at } : null;
  },
  upsert(cardId: string, text: string, quoteAnchorId: string | null): void {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        "INSERT INTO draft (card_id,text,pending_quote_anchor_id,updated_at) VALUES (?,?,?,?) ON CONFLICT(card_id) DO UPDATE SET text=excluded.text,pending_quote_anchor_id=excluded.pending_quote_anchor_id,updated_at=excluded.updated_at",
      )
      .run(cardId, text, quoteAnchorId, now);
  },
  clearQuote(cardId: string): void {
    const now = new Date().toISOString();
    getDb().prepare("UPDATE draft SET pending_quote_anchor_id=NULL, updated_at=? WHERE card_id=?").run(now, cardId);
  },
};

export const viewState = {
  get(conversationId: string): ViewState | null {
    const r = getDb().prepare("SELECT * FROM view_state WHERE conversation_id=?").get(conversationId) as Row | undefined;
    return r ? { conversation_id: r.conversation_id, current_card_id: r.current_card_id, scroll_position: r.scroll_position, updated_at: r.updated_at } : null;
  },
  upsert(conversationId: string, currentCardId: string | null, scrollPosition: number): void {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        "INSERT INTO view_state (conversation_id,current_card_id,scroll_position,updated_at) VALUES (?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET current_card_id=excluded.current_card_id,scroll_position=excluded.scroll_position,updated_at=excluded.updated_at",
      )
      .run(conversationId, currentCardId, scrollPosition, now);
  },
};

export const summaries = {
  listForCard(cardId: string): SummaryRecord[] {
    return getDb()
      .prepare("SELECT * FROM summary_record WHERE card_id=? ORDER BY version DESC")
      .all(cardId)
      .map((r: any) => ({
        id: r.id,
        card_id: r.card_id,
        conversation_id: r.conversation_id,
        summary_message_id: r.summary_message_id,
        covered_message_ids: JSON.parse(r.covered_message_ids || "[]"),
        version: r.version,
        usage: r.usage ? JSON.parse(r.usage) : null,
        created_at: r.created_at,
      }));
  },
  create(input: {
    card_id: string;
    conversation_id: string;
    summary_message_id: string | null;
    covered_message_ids: string[];
    version: number;
    usage?: any;
  }): SummaryRecord {
    const id = ulid();
    const now = new Date().toISOString();
    getDb()
      .prepare(
        "INSERT INTO summary_record (id,card_id,conversation_id,summary_message_id,covered_message_ids,version,usage,created_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(id, input.card_id, input.conversation_id, input.summary_message_id, JSON.stringify(input.covered_message_ids), input.version, input.usage ? JSON.stringify(input.usage) : null, now);
    return {
      id,
      card_id: input.card_id,
      conversation_id: input.conversation_id,
      summary_message_id: input.summary_message_id,
      covered_message_ids: input.covered_message_ids,
      version: input.version,
      usage: input.usage ?? null,
      created_at: now,
    };
  },
};

export const assistant = {
  list(conversationId: string): KnowledgeAssistantMessage[] {
    return getDb()
      .prepare("SELECT * FROM knowledge_assistant_message WHERE conversation_id=? ORDER BY created_at")
      .all(conversationId)
      .map((r: any) => ({
        id: r.id,
        conversation_id: r.conversation_id,
        role: r.role,
        content: r.content,
        evidence: JSON.parse(r.evidence || "[]"),
        run_id: r.run_id,
        created_at: r.created_at,
      }));
  },
  add(input: {
    conversation_id: string;
    role: "user" | "assistant";
    content: string;
    evidence: { card_id: string; message_id: string; anchor_id?: string }[];
    run_id?: string | null;
  }): KnowledgeAssistantMessage {
    const id = ulid();
    const now = new Date().toISOString();
    getDb()
      .prepare(
        "INSERT INTO knowledge_assistant_message (id,conversation_id,role,content,evidence,run_id,created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(id, input.conversation_id, input.role, input.content, JSON.stringify(input.evidence), input.run_id ?? null, now);
    return {
      id,
      conversation_id: input.conversation_id,
      role: input.role,
      content: input.content,
      evidence: input.evidence,
      run_id: input.run_id ?? null,
      created_at: now,
    };
  },
};

export function transaction<T>(fn: () => T): T {
  getDb().exec("BEGIN");
  try {
    const r = fn();
    getDb().exec("COMMIT");
    return r;
  } catch (e) {
    getDb().exec("ROLLBACK");
    throw e;
  }
}
