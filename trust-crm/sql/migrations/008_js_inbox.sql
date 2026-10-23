-- Task 13: inbound replies, review queue, drafts/follow-ups, interviews. Additive + idempotent.

-- js_messages: inbound metadata (references, auth verdicts, attachment METADATA only), the
-- deterministic classification proposal, candidate release flag, and outbound draft/send state.
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS refs jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS auth_results jsonb;
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS classification jsonb;
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS match_reason text;
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS submission_id int REFERENCES js_submissions(id) ON DELETE SET NULL;
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS received_at timestamptz;
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS shared_with_candidate boolean NOT NULL DEFAULT false;
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS shared_by int REFERENCES users(id);
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS shared_at timestamptz;
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS assigned_by int REFERENCES users(id);
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS assigned_at timestamptz;
-- outbound (direction='out') drafts and follow-ups
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS parent_message_id int REFERENCES js_messages(id) ON DELETE SET NULL;
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS body_text text;
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS draft_kind text;
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS lang text;
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS created_by int REFERENCES users(id);
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS sent_by text;
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS auto_sent boolean NOT NULL DEFAULT false;
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS provider_message_id text;
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS send_error text;
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS sent_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'js_messages_status_chk' AND conrelid = 'js_messages'::regclass) THEN
    ALTER TABLE js_messages ADD CONSTRAINT js_messages_status_chk
      CHECK (status IS NULL OR status IN ('draft','sending','sent','failed','outcome_unknown'));
  END IF;
END $$;

-- Replay protection: one stored inbound row per Message-ID.
CREATE UNIQUE INDEX IF NOT EXISTS js_messages_in_message_id_uq ON js_messages (message_id) WHERE direction = 'in';
CREATE INDEX IF NOT EXISTS js_messages_review_idx ON js_messages (review_state, id) WHERE direction = 'in';
CREATE INDEX IF NOT EXISTS js_messages_out_msgid_idx ON js_messages (message_id) WHERE direction = 'out';
CREATE INDEX IF NOT EXISTS js_messages_thread_idx ON js_messages (thread_ref, created_at);
CREATE INDEX IF NOT EXISTS js_submissions_provider_msgid_idx ON js_submissions (provider_message_id);
CREATE INDEX IF NOT EXISTS js_submissions_planned_msgid_idx ON js_submissions ((evidence->>'messageIdPlanned'));

-- Review tasks for unmatched replies are keyed by message (they have no application).
ALTER TABLE js_tasks ADD COLUMN IF NOT EXISTS message_id int REFERENCES js_messages(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS js_tasks_message_reason_uq ON js_tasks (message_id, reason) WHERE message_id IS NOT NULL;

-- Events: who the event is for. 'candidate' (default, existing rows) or 'staff' (user_id = recipient).
-- Candidate-facing streams must exclude audience = 'staff'.
ALTER TABLE js_events ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'candidate';
ALTER TABLE js_events ADD COLUMN IF NOT EXISTS user_id int REFERENCES users(id) ON DELETE SET NULL;

-- Candidate's preferred display timezone (IANA), optional.
ALTER TABLE js_preferences ADD COLUMN IF NOT EXISTS timezone text;
