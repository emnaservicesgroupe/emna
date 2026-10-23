-- Task 13 fix round 1: sender display name kept apart from the normalized address; bounce/auto-reply
-- markers on inbound messages. Additive + idempotent.
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS from_name text;
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS message_kind text;

-- at most one live (tentative/confirmed) interview per application unless an additional round is allowed
ALTER TABLE js_appointments ADD COLUMN IF NOT EXISTS additional_round boolean NOT NULL DEFAULT false;
ALTER TABLE js_appointments ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE js_messages ADD COLUMN IF NOT EXISTS sending_at timestamptz;
CREATE INDEX IF NOT EXISTS js_messages_sending_idx ON js_messages (sending_at) WHERE direction = 'out' AND status = 'sending';
