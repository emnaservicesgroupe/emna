-- Stage 6 review round 1: defence in depth for the chat message immutability trigger. Additive and idempotent (CREATE OR REPLACE).
--
-- 021 let any UPDATE move chat_messages.sender_user_id to NULL, because the foreign key's ON DELETE SET NULL action is an UPDATE too.
-- That also allowed a direct "UPDATE ... SET sender_user_id = NULL" to erase who wrote a message. The FK action runs from inside the
-- referential-integrity trigger, i.e. one trigger level deeper than a statement issued by a client or by the service code:
-- pg_trigger_depth() > 1. Only then may sender_user_id become NULL. Everything else is unchanged from 021.
CREATE OR REPLACE FUNCTION chat_messages_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chat messages are immutable: delete is not allowed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
       OR NEW.sender_role IS DISTINCT FROM OLD.sender_role
       OR NEW.body IS DISTINCT FROM OLD.body
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR (NEW.sender_user_id IS DISTINCT FROM OLD.sender_user_id AND NOT (NEW.sender_user_id IS NULL AND pg_trigger_depth() > 1)) THEN
      RAISE EXCEPTION 'chat messages are immutable: only hidden_at, hidden_by and hidden_reason may change' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW.hidden_at IS NOT NULL AND char_length(btrim(COALESCE(NEW.hidden_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'hidden_reason is required when a message is hidden' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Replay overlap (modules/chat/hub.js): "created_at >= created_at(last seen message) - 2 minutes" must not scan the whole table.
CREATE INDEX IF NOT EXISTS chat_messages_created_idx ON chat_messages (created_at);
