-- 知识助手检索：FTS5 + 中文词项预处理。
-- externalcontent 模式，正文存于 message 表，避免重复存储。

CREATE VIRTUAL TABLE knowledge_chunk USING fts5(
  conversation_id UNINDEXED,
  message_id UNINDEXED,
  card_id UNINDEXED,
  role UNINDEXED,
  text,                      -- 经中文分词处理后的文本（空格分隔词项）
  raw_text,                  -- 原文，用于证据回显
  tokenize = 'unicode61 remove_diacritics 2',
  index_version UNINDEXED
);

-- 标题/别名精确与子串匹配（独立表，便于短词与中文子串）
CREATE TABLE knowledge_topic (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  title TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',  -- JSON
  card_ids TEXT NOT NULL DEFAULT '[]',  -- JSON
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversation(id)
);

CREATE INDEX idx_topic_conv ON knowledge_topic(conversation_id);
