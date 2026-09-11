-- 术语全会话关联：会话级"术语 → 首次探索卡片"稳定映射。
-- 普通点击术语统一跳 first_card_id；Shift+点击重新探索再从当前出处建新探索。
-- 与 selection_anchor（位置记录）、knowledge_topic（RAG 知识主题）职责分离。

CREATE TABLE term_link (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  term_key TEXT NOT NULL,            -- 规范匹配键：NFC + trim + 小写
  term_text TEXT NOT NULL,           -- 原始术语文本（展示用）
  first_card_id TEXT NOT NULL,       -- 首次探索卡片（默认导航目标），无 FK：卡片删除后由 deleteStale 清理
  first_anchor_id TEXT,              -- 首次源锚点（失效判断用），无 FK
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversation(id)
);

CREATE UNIQUE INDEX idx_term_link_key ON term_link(conversation_id, term_key);
CREATE INDEX idx_term_link_conv ON term_link(conversation_id);

-- 历史回填：按 (conversation_id, 规范term) 分组，取最早创建且分支卡片仍存在的
-- 探索锚点为首次目标；时间相同按 branch_card_id 稳定排序。保留所有原卡与锚点。
INSERT OR IGNORE INTO term_link (id, conversation_id, term_key, term_text, first_card_id, first_anchor_id, created_at)
SELECT id, conversation_id, term_key, term_text, first_card_id, first_anchor_id, created_at
FROM (
  SELECT
    lower(hex(randomblob(16))) AS id,
    a.conversation_id,
    lower(trim(a.selected_text)) AS term_key,
    trim(a.selected_text) AS term_text,
    a.branch_card_id AS first_card_id,
    a.id AS first_anchor_id,
    a.created_at,
    ROW_NUMBER() OVER (
      PARTITION BY a.conversation_id, lower(trim(a.selected_text))
      ORDER BY a.created_at ASC, a.branch_card_id ASC
    ) AS rn
  FROM selection_anchor a
  WHERE a.branch_card_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM card c WHERE c.id = a.branch_card_id)
) t
WHERE t.rn = 1;
