-- Skip source scans when only assistant chat or UI state changed.
ALTER TABLE knowledge_index_state ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1;
CREATE TRIGGER knowledge_source_insert AFTER INSERT ON message BEGIN
  INSERT INTO knowledge_index_state(conversation_id,dirty) VALUES(new.conversation_id,1)
    ON CONFLICT(conversation_id) DO UPDATE SET dirty=1;
END;
CREATE TRIGGER knowledge_source_update AFTER UPDATE OF content,plaintext,status,version ON message BEGIN
  INSERT INTO knowledge_index_state(conversation_id,dirty) VALUES(new.conversation_id,1)
    ON CONFLICT(conversation_id) DO UPDATE SET dirty=1;
END;
CREATE TRIGGER knowledge_source_delete AFTER DELETE ON message BEGIN
  UPDATE knowledge_index_state SET dirty=1,revision=revision+1 WHERE conversation_id=old.conversation_id;
END;
CREATE TRIGGER knowledge_card_update AFTER UPDATE OF title,parent_card_id ON card BEGIN
  UPDATE knowledge_index_state SET dirty=1 WHERE conversation_id=new.conversation_id;
END;
CREATE TRIGGER knowledge_topic_insert AFTER INSERT ON knowledge_topic BEGIN
  UPDATE knowledge_index_state SET revision=revision+1 WHERE conversation_id=new.conversation_id;
END;
CREATE TRIGGER knowledge_topic_update AFTER UPDATE ON knowledge_topic BEGIN
  UPDATE knowledge_index_state SET revision=revision+1 WHERE conversation_id=new.conversation_id;
END;
CREATE TRIGGER knowledge_topic_delete AFTER DELETE ON knowledge_topic BEGIN
  UPDATE knowledge_index_state SET revision=revision+1 WHERE conversation_id=old.conversation_id;
END;
