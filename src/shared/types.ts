// 跨前后端共享的类型定义。前后端使用同一套类型，避免接口与实现脱节。

export type ProviderType = "openai" | "deepseek" | "custom";
export type RunPurpose = "chat" | "branch" | "summary" | "assistant" | "search_query";

export type WebMode = "off" | "auto" | "force";
export type ThinkMode = "off" | "standard" | "deep";

export type MessageRole = "user" | "assistant" | "system";
export type MessageStatus =
  | "pending" // 已落盘待处理
  | "streaming" // 流式生成中
  | "complete" // 完成
  | "stopped" // 用户中止
  | "failed"; // 失败

export type RunStatus =
  | "queued"
  | "running"
  | "searching"
  | "reading"
  | "completed"
  | "stopped"
  | "failed";

export interface ProviderConfig {
  id: string;
  type: ProviderType;
  name: string;
  api_base: string; // 自定义接口地址；OpenAI/DeepSeek 可留空走默认
  default_model: string;
  is_default: boolean;
  config_version: number; // 连接配置版本，锁定会话时记录
  capabilities: ProviderCapabilities;
  created_at: string;
  updated_at: string;
  has_secret: boolean; // 是否已配置 Key（仅返回掩码状态）
  secret_ref: string; // 系统凭据存储键（内部，不返回明文）
}

export interface ProviderCapabilities {
  web_search: boolean; // 原生搜索
  thinking: boolean; // 推理
  tool_calls: boolean; // 工具调用
  force_search: boolean; // 是否支持强制搜索（接口层保证）
  models: string[]; // 已知可用模型列表（可选）
  context_window: number; // 估算上下文窗口（token）
}

export interface SearchConfig {
  id: string;
  provider: "tavily" | "none";
  api_base: string;
  config_version: number;
  has_secret: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  secret_ref: string;
}

export interface Conversation {
  id: string;
  title: string;
  provider_id: string;
  provider_type: ProviderType;
  provider_config_version: number;
  model: string;
  locked: boolean;
  locked_at: string | null;
  web_mode: WebMode;
  think_mode: ThinkMode;
  deleted: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Card {
  id: string;
  conversation_id: string;
  parent_card_id: string | null;
  title: string;
  source_anchor_id: string | null; // 探索来源选区；主卡片为 null
  initial_snapshot_id: string | null; // 分叉时上下文快照
  created_at: string;
}

export interface SelectionAnchor {
  id: string;
  source_message_id: string;
  source_message_version: number; // 消息内容版本
  card_id: string; // 来源卡片
  conversation_id: string;
  selected_text: string;
  // 规范文本区间：用于精确还原位置
  start_offset: number; // 在消息规范 plaintext 中的起始偏移
  end_offset: number;
  prefix: string; // 选区前邻近文本（校验用）
  suffix: string; // 选区后邻近文本
  branch_card_id: string | null; // 由该选区创建的探索分支卡片
  created_at: string;
}

export interface Message {
  id: string;
  card_id: string;
  conversation_id: string;
  role: MessageRole;
  content: string; // markdown
  plaintext: string; // 规范纯文本，用于选区锚点
  version: number; // 内容版本，改动生成新版本不破坏旧锚点
  status: MessageStatus;
  seq: number; // 卡片内消息顺序
  run_id: string | null;
  model: string | null; // 生成时的模型
  provider_type: ProviderType | null;
  web_mode: WebMode | null;
  think_mode: ThinkMode | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  quote_anchor_id: string | null; // 用户消息引用的来源锚点
}

export interface MessageQuote {
  message_id: string; // 用户消息
  anchor_id: string; // 来源选区
}

export interface ContextSnapshot {
  id: string;
  card_id: string; // 该快照所属卡片
  conversation_id: string;
  message_refs: string[]; // 有序消息 ID（JSON）
  fork_boundary_message_id: string | null; // 分叉边界（源消息）
  summary_version: number | null; // 若使用摘要后的版本
  created_at: string;
}

export interface SummaryRecord {
  id: string;
  card_id: string;
  conversation_id: string;
  summary_message_id: string | null; // 摘要文本存为一条 system message
  covered_message_ids: string[]; // 被压缩的消息 ID 范围（JSON）
  version: number;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  created_at: string;
}

export interface Run {
  id: string;
  conversation_id: string;
  card_id: string;
  message_id: string | null;
  purpose: RunPurpose;
  status: RunStatus;
  model: string;
  provider_type: ProviderType;
  provider_config_version: number;
  web_mode: WebMode;
  think_mode: ThinkMode;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  error: string | null;
  idempotency_key: string;
  sources: string[]; // 来源 ID 列表
  created_at: string;
  finished_at: string | null;
}

export interface Source {
  id: string;
  run_id: string;
  conversation_id: string;
  url: string;
  title: string;
  retrieved_at: string;
  snippet: string; // 证据片段
  content_kind: "full" | "snippet" | "search_summary"; // 正文/片段/仅搜索摘要
  citation_message_id: string | null; // 回答中的引用位置
}

export interface KnowledgeAssistantMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  evidence: { card_id: string; message_id: string; anchor_id?: string }[];
  run_id: string | null;
  created_at: string;
}

export interface Draft {
  card_id: string;
  text: string;
  pending_quote_anchor_id: string | null;
  updated_at: string;
}

export interface ViewState {
  conversation_id: string;
  current_card_id: string | null;
  scroll_position: number;
  updated_at: string;
}

// SSE 事件
export type SSEEvent =
  | { type: "run"; run: Run }
  | { type: "delta"; message_id: string; text: string }
  | { type: "status"; run_id: string; status: RunStatus; detail?: string }
  | { type: "sources"; run_id: string; sources: Source[] }
  | { type: "message"; message: Message }
  | { type: "searching"; run_id: string; queries: string[]; service: string }
  | { type: "reading"; run_id: string; url: string }
  | { type: "done"; run_id: string; message: Message; run: Run }
  | { type: "error"; run_id: string; message: string; run?: Run }
  | { type: "summary"; run_id: string; detail: string };
