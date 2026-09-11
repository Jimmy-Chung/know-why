-- Derived indexes only. Existing conversation/message records remain unchanged.
CREATE TABLE knowledge_index_state (
  conversation_id TEXT PRIMARY KEY REFERENCES conversation(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0,
  vector_revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE knowledge_index_message (
  message_id TEXT PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL
);
CREATE INDEX idx_knowledge_index_message_conv ON knowledge_index_message(conversation_id);
CREATE TABLE knowledge_passage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES card(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  text TEXT NOT NULL,
  question TEXT NOT NULL,
  card_title TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  tokens TEXT NOT NULL,
  UNIQUE(message_id, ordinal)
);
CREATE INDEX idx_knowledge_passage_conv ON knowledge_passage(conversation_id);
CREATE VIRTUAL TABLE knowledge_passage_fts USING fts5(tokens, content='knowledge_passage', content_rowid='id');
CREATE TRIGGER knowledge_passage_ai AFTER INSERT ON knowledge_passage BEGIN
  INSERT INTO knowledge_passage_fts(rowid,tokens) VALUES(new.id,new.tokens);
END;
CREATE TRIGGER knowledge_passage_ad AFTER DELETE ON knowledge_passage BEGIN
  INSERT INTO knowledge_passage_fts(knowledge_passage_fts,rowid,tokens) VALUES('delete',old.id,old.tokens);
  UPDATE knowledge_index_state SET revision=revision+1 WHERE conversation_id=old.conversation_id;
END;
CREATE TABLE knowledge_passage_vector (
  passage_id INTEGER NOT NULL REFERENCES knowledge_passage(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  embedding BLOB NOT NULL,
  dim INTEGER NOT NULL,
  PRIMARY KEY(passage_id, model)
);
CREATE TABLE knowledge_rag_metrics (
  run_id TEXT PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  retrieval_ms REAL NOT NULL,
  first_token_ms REAL,
  total_ms REAL NOT NULL,
  candidate_count INTEGER NOT NULL,
  evidence_count INTEGER NOT NULL,
  estimated_input_tokens INTEGER NOT NULL,
  evidence_tokens INTEGER NOT NULL,
  cache_hit INTEGER NOT NULL,
  semantic_ready INTEGER NOT NULL
);
ALTER TABLE knowledge_assistant_message ADD COLUMN status TEXT NOT NULL DEFAULT 'complete';
