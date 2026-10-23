-- 'linked_existing': we attached to a record that already existed in the external system and must never overwrite its fields.
-- 'managed': FIND WAY created the external record and may keep it in sync.
ALTER TABLE external_mappings ADD COLUMN link_mode text NOT NULL DEFAULT 'managed' CHECK (link_mode IN ('managed','linked_existing'));
