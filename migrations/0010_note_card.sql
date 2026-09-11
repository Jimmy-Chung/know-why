-- 用户笔记卡片：每个会话下的可编辑笔记（标题 + markdown 正文）。
-- 会话有两个 Tab（对话卡片 / 笔记）；笔记由助手回答一键存入，也可在笔记 Tab 新建。

CREATE TABLE note_card (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content_markdown TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversation(id)
);
CREATE INDEX idx_note_card_conv ON note_card(conversation_id);