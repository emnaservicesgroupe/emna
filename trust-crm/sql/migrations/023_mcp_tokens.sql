-- Stage 7: personal access tokens (PAT) for the read-only MCP server. Additive and idempotent: one new table and its indexes,
-- nothing existing is touched, so running it again (or on a fresh database) changes nothing.
--
-- The secret ("vita_pat_" + 43 url-safe characters) is shown ONCE at creation and never stored: only its sha256 (hex) is kept in
-- token_hash. "prefix" is the first 8 characters of the random part, kept so an owner can tell their tokens apart (it is not a secret
-- worth anything: 8 of 43 characters). Deleting a user deletes their tokens. Who may create a token is decided in code (mcp:use).
CREATE TABLE IF NOT EXISTS api_tokens (
  id bigserial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND char_length(btrim(name)) >= 1),
  prefix text NOT NULL CHECK (char_length(prefix) = 8),
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] NOT NULL DEFAULT ARRAY['read']::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  last_used_ip_hash text,
  revoked_at timestamptz,
  revoked_by int REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT api_tokens_token_hash_uq UNIQUE (token_hash),
  CONSTRAINT api_tokens_expiry_check CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS api_tokens_user_idx ON api_tokens (user_id);
CREATE INDEX IF NOT EXISTS api_tokens_prefix_idx ON api_tokens (prefix);
