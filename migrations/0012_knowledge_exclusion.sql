ALTER TABLE message ADD COLUMN knowledge_excluded INTEGER NOT NULL DEFAULT 0 CHECK(knowledge_excluded IN (0,1));
ALTER TABLE knowledge_assistant_message ADD COLUMN context_valid INTEGER NOT NULL DEFAULT 1;
CREATE TRIGGER knowledge_exclusion_update AFTER UPDATE OF knowledge_excluded ON message
WHEN old.knowledge_excluded <> new.knowledge_excluded BEGIN
  INSERT INTO knowledge_index_state(conversation_id,dirty) VALUES(new.conversation_id,1)
    ON CONFLICT(conversation_id) DO UPDATE SET dirty=1,revision=revision+1;
  -- Prior assistant turns may indirectly repeat an excluded source, even without citations.
  UPDATE knowledge_assistant_message SET context_valid=0 WHERE conversation_id=new.conversation_id;
END;
