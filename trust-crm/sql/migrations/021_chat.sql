-- Stage 6: messaging. Additive and idempotent: only new objects, nothing existing is rewritten, so running it again (or on a
-- fresh database) changes nothing.
--
-- Text only. A message is immutable: its text, sender, conversation and time never change; the only editable columns are the
-- three "hidden_*" moderation columns. Deleting a user never fails: "who did it" columns are SET NULL (the message text and
-- the stored sender_role stay), personal rows (participants, prefs, nudges) are removed with the user.
-- Who may read or write a conversation is decided in service code (modules/chat/scope.js), never here.

-- 1. Conversations -----------------------------------------------------------------------------------------------------
-- subject_type: candidate (staff <-> that candidate), employer_request / agency (staff <-> that organisation's users),
-- staff (internal room, participants only; subject_id optional). subject_id is the candidate id or organisation id.
CREATE TABLE IF NOT EXISTS chat_conversations (
  id bigserial PRIMARY KEY,
  subject_type text NOT NULL CHECK (subject_type IN ('candidate','employer_request','agency','staff')),
  subject_id bigint,
  title text CHECK (char_length(title) <= 200),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_by int REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz,
  last_message_id bigint,                                   -- denormalised pointer, maintained by the service; no FK on purpose
  CONSTRAINT chat_conversations_subject_check CHECK (subject_type = 'staff' OR subject_id IS NOT NULL)
);

-- One conversation per subject for the non-staff types (idempotent "open"); staff rooms may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS chat_conversations_subject_uq ON chat_conversations (subject_type, subject_id) WHERE subject_type <> 'staff';
-- Conversation list ordering.
CREATE INDEX IF NOT EXISTS chat_conversations_recent_idx ON chat_conversations (last_message_at DESC NULLS LAST, id DESC);

-- 2. Participants (explicit; external users are implicit via organisation / candidate link and get a row lazily) ----------
CREATE TABLE IF NOT EXISTS chat_participants (
  conversation_id bigint NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by int REFERENCES users(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  last_read_message_id bigint,
  muted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS chat_participants_user_idx ON chat_participants (user_id, conversation_id);

-- 3. Messages ----------------------------------------------------------------------------------------------------------
-- A NUL character cannot be stored in a PostgreSQL text value at all (the insert fails with 22021), so no extra CHECK is needed.
-- Length is counted in characters, not bytes.
CREATE TABLE IF NOT EXISTS chat_messages (
  id bigserial PRIMARY KEY,
  conversation_id bigint NOT NULL REFERENCES chat_conversations(id),
  sender_user_id int REFERENCES users(id) ON DELETE SET NULL,
  sender_role text NOT NULL CHECK (char_length(sender_role) BETWEEN 1 AND 40),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  hidden_at timestamptz,
  hidden_by int REFERENCES users(id) ON DELETE SET NULL,
  hidden_reason text CHECK (char_length(hidden_reason) <= 500),
  CONSTRAINT chat_messages_hidden_needs_reason_check CHECK (hidden_at IS NULL OR char_length(btrim(hidden_reason)) >= 1)
);

-- Thread pagination (newest first), unread counts over visible messages, per-sender rate limiting.
CREATE INDEX IF NOT EXISTS chat_messages_conv_idx ON chat_messages (conversation_id, id DESC);
CREATE INDEX IF NOT EXISTS chat_messages_visible_idx ON chat_messages (conversation_id, id) WHERE hidden_at IS NULL;
CREATE INDEX IF NOT EXISTS chat_messages_sender_idx ON chat_messages (sender_user_id, created_at DESC);

-- Immutability: no DELETE, and an UPDATE may change only hidden_at / hidden_by / hidden_reason (plus the foreign-key action
-- that sets sender_user_id to NULL when the sender's user row is deleted). Hiding needs a non-empty reason.
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
       OR (NEW.sender_user_id IS DISTINCT FROM OLD.sender_user_id AND NEW.sender_user_id IS NOT NULL) THEN
      RAISE EXCEPTION 'chat messages are immutable: only hidden_at, hidden_by and hidden_reason may change' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW.hidden_at IS NOT NULL AND char_length(btrim(COALESCE(NEW.hidden_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'hidden_reason is required when a message is hidden' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chat_messages_immutable_trg ON chat_messages;
CREATE TRIGGER chat_messages_immutable_trg BEFORE INSERT OR UPDATE OR DELETE ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION chat_messages_immutable();

-- 4. Preferences, e-mail nudge cooldown, channel outbox ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_prefs (
  user_id int PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_nudges boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS chat_nudges (
  conversation_id bigint NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

-- Written by the channel adapters. WhatsApp has no real provider: its sandbox adapter records 'requires_setup'.
CREATE TABLE IF NOT EXISTS chat_channel_outbox (
  id bigserial PRIMARY KEY,
  message_id bigint NOT NULL REFERENCES chat_messages(id),
  channel text NOT NULL CHECK (channel IN ('whatsapp','email')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','requires_setup')),
  detail text CHECK (char_length(detail) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_channel_outbox_message_idx ON chat_channel_outbox (message_id);
