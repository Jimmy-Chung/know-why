-- 助手提问的作用域：用户可用 @ 指定若干卡片，检索只在这些卡范围内进行。
-- 仅 user 消息写入（JSON 数组 of card_id），assistant 消息留 NULL（evidence 已隐含反映作用域）。
ALTER TABLE knowledge_assistant_message ADD COLUMN scope_card_ids TEXT;
