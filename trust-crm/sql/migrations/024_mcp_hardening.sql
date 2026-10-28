-- Stage 7 review round 1: bind personal access tokens (api_tokens) to the owner's account lifecycle. Additive and idempotent.
--
--  1. api_tokens.owner_token_version: the owner's users.token_version at creation. authenticate() requires it to still equal
--     users.token_version, so every session revocation (logout everywhere, suspension, password reset: all bump token_version)
--     also kills the owner's tokens. Existing rows are backfilled ONCE (when the column is added) from the current value.
--  2. A trigger on users: when an account is deactivated, or its role is changed to one without mcp:use (anything but Admin /
--     Manager / SuperAdmin: keep in step with PERMISSIONS in middleware/role.js), every non-revoked token of that user is
--     revoked (revoked_at = now(), revoked_by stays NULL = "revoked by the system"). Reactivating or promoting back therefore
--     does NOT revive a token that may have leaked in the meantime.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'api_tokens' AND column_name = 'owner_token_version') THEN
    ALTER TABLE api_tokens ADD COLUMN owner_token_version int NOT NULL DEFAULT 0;
    UPDATE api_tokens t SET owner_token_version = u.token_version FROM users u WHERE u.id = t.user_id;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION api_tokens_revoke_on_account_change() RETURNS trigger AS $$
BEGIN
  IF (OLD.is_active AND NOT NEW.is_active)
     OR (NEW.role IS DISTINCT FROM OLD.role AND NEW.role NOT IN ('Admin', 'Manager', 'SuperAdmin')) THEN
    UPDATE api_tokens SET revoked_at = now(), revoked_by = NULL WHERE user_id = NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS api_tokens_revoke_on_account_change ON users;
CREATE TRIGGER api_tokens_revoke_on_account_change
  AFTER UPDATE OF is_active, role ON users
  FOR EACH ROW EXECUTE FUNCTION api_tokens_revoke_on_account_change();
