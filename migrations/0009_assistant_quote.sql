-- 会话知识助手：用户提问可携带引用原文（选中助手回答片段后引用）。
-- 引用只存文本，随用户消息落库；较 SelectionAnchor 体系更轻，无需 card_id/plaintext/offset。

ALTER TABLE knowledge_assistant_message ADD COLUMN quote TEXT;