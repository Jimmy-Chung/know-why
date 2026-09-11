-- 会话知识助手多问答线程：给助手消息加 thread_id 分组。
-- thread_id 为 NULL 的旧消息归入「历史问答」默认线程（前端兼容）。
-- 线程无独立表——线程是消息的 thread_id 分组，避免过度建模。

ALTER TABLE knowledge_assistant_message ADD COLUMN thread_id TEXT;

CREATE INDEX idx_assistant_thread ON knowledge_assistant_message(conversation_id, thread_id);