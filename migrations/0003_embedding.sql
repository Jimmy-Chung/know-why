-- 会话知识助手语义检索：每条消息一个 embedding 向量。
-- 与 knowledge_chunk / knowledge_topic 并列，会话级隔离（强制 conversation_id 限定）。
-- 向量以 BLOB 存储（little-endian float32 数组，已 L2 归一化，故 cosine 退化为点积）。

CREATE TABLE knowledge_embedding (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  role TEXT NOT NULL,
  embedding BLOB NOT NULL,        -- 归一化后的 float32 数组
  dim INTEGER NOT NULL,           -- 向量维度，便于校验/迁移
  model TEXT NOT NULL,            -- 生成该向量的模型，换模型时整体重建
  index_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversation(id)
);

CREATE INDEX idx_embedding_conv ON knowledge_embedding(conversation_id);
CREATE INDEX idx_embedding_message ON knowledge_embedding(message_id);
