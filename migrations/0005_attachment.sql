-- 附件支持：用户消息可携带附件
-- message.attachments 存附件元数据 JSON 数组（引用 attachment 表的 id）
ALTER TABLE message ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';

-- 附件元数据表：文件本体存于数据目录 attachments/ 下，文件名 = id
CREATE TABLE attachment (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  name TEXT NOT NULL,       -- 原始文件名
  mime TEXT NOT NULL,       -- MIME 类型
  size INTEGER NOT NULL,    -- 字节数
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversation(id)
);
CREATE INDEX idx_attachment_conv ON attachment(conversation_id);
