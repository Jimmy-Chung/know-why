-- Know Know 1.0 初始 schema
-- 单机 SQLite，外键开启，WAL 模式。所有主键为 ULID（TEXT）。

PRAGMA foreign_keys = ON;

-- Provider 配置。密钥不存此处，仅存引用与非敏感连接信息。
CREATE TABLE provider_config (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                    -- openai | deepseek | custom
  name TEXT NOT NULL,
  api_base TEXT NOT NULL DEFAULT '',
  default_model TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  config_version INTEGER NOT NULL DEFAULT 1,
  capabilities TEXT NOT NULL DEFAULT '{}', -- JSON: ProviderCapabilities
  secret_ref TEXT NOT NULL DEFAULT '',     -- 系统凭据存储的键名
  has_secret INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 独立搜索服务配置。凭据与聊天 Provider 分开管理。
CREATE TABLE search_config (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'tavily', -- tavily | none
  api_base TEXT NOT NULL DEFAULT '',
  config_version INTEGER NOT NULL DEFAULT 1,
  secret_ref TEXT NOT NULL DEFAULT '',
  has_secret INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE conversation (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '新会话',
  provider_id TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  provider_config_version INTEGER NOT NULL,
  model TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0,
  locked_at TEXT,
  web_mode TEXT NOT NULL DEFAULT 'off',     -- off | auto | force
  think_mode TEXT NOT NULL DEFAULT 'off',   -- off | standard | deep
  deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (provider_id) REFERENCES provider_config(id)
);

CREATE TABLE card (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  parent_card_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  source_anchor_id TEXT,
  initial_snapshot_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversation(id),
  FOREIGN KEY (parent_card_id) REFERENCES card(id),
  FOREIGN KEY (source_anchor_id) REFERENCES selection_anchor(id)
);

CREATE INDEX idx_card_conv ON card(conversation_id);
CREATE INDEX idx_card_parent ON card(parent_card_id);

-- 选区锚点：引用与探索共用。
CREATE TABLE selection_anchor (
  id TEXT PRIMARY KEY,
  source_message_id TEXT NOT NULL,
  source_message_version INTEGER NOT NULL,
  card_id TEXT NOT NULL,            -- 来源卡片
  conversation_id TEXT NOT NULL,
  selected_text TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  prefix TEXT NOT NULL DEFAULT '',
  suffix TEXT NOT NULL DEFAULT '',
  branch_card_id TEXT,              -- 由该选区创建的探索分支
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_message_id) REFERENCES message(id),
  FOREIGN KEY (card_id) REFERENCES card(id),
  FOREIGN KEY (conversation_id) REFERENCES conversation(id),
  FOREIGN KEY (branch_card_id) REFERENCES card(id)
);

CREATE INDEX idx_anchor_message ON selection_anchor(source_message_id);
CREATE INDEX idx_anchor_branch ON selection_anchor(branch_card_id);

CREATE TABLE message (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,                -- user | assistant | system
  content TEXT NOT NULL DEFAULT '', -- markdown
  plaintext TEXT NOT NULL DEFAULT '',-- 规范纯文本
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  seq INTEGER NOT NULL,
  run_id TEXT,
  model TEXT,
  provider_type TEXT,
  web_mode TEXT,
  think_mode TEXT,
  error TEXT,
  quote_anchor_id TEXT,             -- 用户消息引用的来源锚点
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (card_id) REFERENCES card(id),
  FOREIGN KEY (conversation_id) REFERENCES conversation(id),
  FOREIGN KEY (run_id) REFERENCES run(id),
  FOREIGN KEY (quote_anchor_id) REFERENCES selection_anchor(id)
);

CREATE INDEX idx_message_card ON message(card_id, seq);
CREATE INDEX idx_message_conv ON message(conversation_id);

CREATE TABLE message_quote (
  message_id TEXT NOT NULL,
  anchor_id TEXT NOT NULL,
  PRIMARY KEY (message_id, anchor_id),
  FOREIGN KEY (message_id) REFERENCES message(id),
  FOREIGN KEY (anchor_id) REFERENCES selection_anchor(id)
);

-- 分叉上下文快照：有序消息引用，可重建当时背景。
CREATE TABLE context_snapshot (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_refs TEXT NOT NULL,            -- JSON 数组
  fork_boundary_message_id TEXT,
  summary_version INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (card_id) REFERENCES card(id),
  FOREIGN KEY (conversation_id) REFERENCES conversation(id)
);

CREATE TABLE run (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  message_id TEXT,
  purpose TEXT NOT NULL,              -- chat | branch | summary | assistant | search_query
  status TEXT NOT NULL DEFAULT 'queued',
  model TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  provider_config_version INTEGER NOT NULL,
  web_mode TEXT NOT NULL,
  think_mode TEXT NOT NULL,
  usage TEXT,                          -- JSON
  error TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  sources TEXT NOT NULL DEFAULT '[]',  -- JSON 数组
  created_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversation(id),
  FOREIGN KEY (card_id) REFERENCES card(id),
  FOREIGN KEY (message_id) REFERENCES message(id)
);

CREATE INDEX idx_run_idem ON run(idempotency_key);
CREATE INDEX idx_run_conv ON run(conversation_id);

CREATE TABLE source (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  retrieved_at TEXT NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  content_kind TEXT NOT NULL DEFAULT 'snippet', -- full | snippet | search_summary
  citation_message_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES run(id),
  FOREIGN KEY (conversation_id) REFERENCES conversation(id)
);

CREATE INDEX idx_source_run ON source(run_id);

-- 知识助手历史（会话级，与探索卡片消息分开）
CREATE TABLE knowledge_assistant_message (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,            -- user | assistant
  content TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '[]', -- JSON: [{card_id,message_id,anchor_id?}]
  run_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversation(id),
  FOREIGN KEY (run_id) REFERENCES run(id)
);

CREATE INDEX idx_kam_conv ON knowledge_assistant_message(conversation_id, created_at);

-- 每卡片草稿与待发送引用
CREATE TABLE draft (
  card_id TEXT PRIMARY KEY,
  text TEXT NOT NULL DEFAULT '',
  pending_quote_anchor_id TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (card_id) REFERENCES card(id),
  FOREIGN KEY (pending_quote_anchor_id) REFERENCES selection_anchor(id)
);

-- 每会话视图状态（当前卡片、阅读位置）
CREATE TABLE view_state (
  conversation_id TEXT PRIMARY KEY,
  current_card_id TEXT,
  scroll_position INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversation(id),
  FOREIGN KEY (current_card_id) REFERENCES card(id)
);

-- 自动摘要记录：保留原文与摘要来源范围、版本、用量
CREATE TABLE summary_record (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  summary_message_id TEXT,         -- 摘要文本存为一条 system 性质 message
  covered_message_ids TEXT NOT NULL, -- JSON：被压缩的消息 ID 范围
  version INTEGER NOT NULL DEFAULT 1,
  usage TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (card_id) REFERENCES card(id),
  FOREIGN KEY (conversation_id) REFERENCES conversation(id)
);

-- schema_version 由迁移运行器统一创建，此处不再重复。
