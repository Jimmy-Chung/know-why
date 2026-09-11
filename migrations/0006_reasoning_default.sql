-- 旧版 off = 不发送推理参数；新设置用 default 表示该行为，none 才是显式关闭。
-- 只更新当前会话设置，保留消息和 run 的历史记录。
UPDATE conversation SET think_mode = CASE think_mode
  WHEN 'off' THEN 'default' WHEN 'standard' THEN 'medium' WHEN 'deep' THEN 'high'
  ELSE think_mode END;
