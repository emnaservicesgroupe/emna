-- FIND WAY core schema (Phase 1). All ids are UUIDs so they never collide with the
-- integer ids of trust-crm. Times are timestamptz (UTC). See docs/DATA_MODEL.md.

-- ───────────────────────── identity & access ─────────────────────────
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  email_norm      text NOT NULL UNIQUE,
  password_hash   text NOT NULL,
  role            text NOT NULL CHECK (role IN ('super_admin','admin','staff','employer_owner','employer_member','agency','candidate','guest')),
  full_name       text NOT NULL,
  locale          text NOT NULL DEFAULT 'en' CHECK (locale IN ('en','ar','sq','fr')),
  timezone        text NOT NULL DEFAULT 'UTC',
  -- four independent states (see docs/ARCHITECTURE.md §6): email verification, profile completion
  -- (computed), identity/company review (organizations / candidates), administrator approval.
  email_verified_at timestamptz,
  approval_status text NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending','approved','rejected')),
  approval_note   text,
  approval_decided_by uuid REFERENCES users(id),
  approval_decided_at timestamptz,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  suspended_reason text,
  suspended_at    timestamptz,
  failed_logins   int NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  mfa_secret_enc  text,
  mfa_enrolled_at timestamptz,
  mfa_last_step   bigint,
  mfa_recovery    jsonb NOT NULL DEFAULT '[]',
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  mfa_verified boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  ip           text,
  user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE otp_challenges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_norm   text NOT NULL,
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  purpose      text NOT NULL CHECK (purpose IN ('verify_email','recover_password','mfa_pending')),
  code_hmac    text NOT NULL,
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  consumed_at  timestamptz,
  locked_at    timestamptz
);
CREATE INDEX otp_lookup_idx ON otp_challenges (email_norm, purpose, created_at DESC);

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── organizations ─────────────────────────
CREATE TABLE organizations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type             text NOT NULL CHECK (type IN ('employer','agency','internal')),
  name             text NOT NULL,
  name_norm        text NOT NULL,
  legal_name       text,
  registration_number text,
  registration_norm text,
  website          text,
  domain           text,
  country          text,
  city             text,
  industry         text,
  description      text,
  contact_email    text,
  contact_phone    text,
  -- identity/company review is independent of the owner's account approval
  verification_status text NOT NULL DEFAULT 'unsubmitted'
    CHECK (verification_status IN ('unsubmitted','submitted','verified','rejected','changes_requested')),
  verification_note text,
  verified_by      uuid REFERENCES users(id),
  verified_at      timestamptz,
  recruitment_mode text NOT NULL DEFAULT 'managed' CHECK (recruitment_mode IN ('direct','managed')),
  public_profile   boolean NOT NULL DEFAULT false,
  claimed          boolean NOT NULL DEFAULT true,          -- false = discovered by staff, no employer account yet
  source           text,                                    -- how we found the company
  introduced_by    uuid REFERENCES users(id),               -- immutable attribution
  owner_user_id    uuid REFERENCES users(id),               -- current staff owner (reassignable, audited)
  potential_duplicate_of uuid REFERENCES organizations(id),
  last_contact_at  timestamptz,
  next_action      text,
  next_action_at   timestamptz,
  relationship_status text NOT NULL DEFAULT 'new',
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          int NOT NULL DEFAULT 1
);
CREATE INDEX organizations_name_idx ON organizations (name_norm);
CREATE INDEX organizations_reg_idx ON organizations (registration_norm) WHERE registration_norm IS NOT NULL;
CREATE INDEX organizations_domain_idx ON organizations (domain) WHERE domain IS NOT NULL;

CREATE TABLE memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner','member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, org_id)
);

CREATE TABLE org_verification_submissions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  submitted_by uuid NOT NULL REFERENCES users(id),
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','verified','rejected','changes_requested')),
  reviewed_by  uuid REFERENCES users(id),
  reviewed_at  timestamptz,
  review_note  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── candidates (canonical person) ─────────────────────────
CREATE TABLE candidates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid UNIQUE REFERENCES users(id),
  full_name      text NOT NULL,
  name_norm      text NOT NULL,
  email          text,
  email_norm     text,
  phone          text,
  phone_norm     text,
  date_of_birth  date,
  nationality    text,
  country        text,
  city           text,
  profession     text,
  profession_norm text,
  skills         text[] NOT NULL DEFAULT '{}',
  experience_years numeric(4,1),
  education      jsonb NOT NULL DEFAULT '[]',
  certifications jsonb NOT NULL DEFAULT '[]',
  languages      jsonb NOT NULL DEFAULT '[]',
  availability_date date,
  desired_destinations text[] NOT NULL DEFAULT '{}',
  salary_expectation_min numeric(12,2),
  salary_expectation_max numeric(12,2),
  salary_expectation_currency text,
  salary_expectation_period text,
  relocation_preference text,
  visibility     text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','staff_only','catalogue_requested')),
  identity_review_status text NOT NULL DEFAULT 'not_submitted'
    CHECK (identity_review_status IN ('not_submitted','pending','verified','rejected')),
  source         text NOT NULL DEFAULT 'self_registered',
  introduced_by  uuid REFERENCES users(id),
  owner_user_id  uuid REFERENCES users(id),
  merged_into    uuid REFERENCES candidates(id),
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        int NOT NULL DEFAULT 1
);
-- DB-level duplicate prevention: one live person per normalized email.
CREATE UNIQUE INDEX candidates_email_uidx ON candidates (email_norm) WHERE merged_into IS NULL AND email_norm IS NOT NULL;
CREATE INDEX candidates_phone_idx ON candidates (phone_norm) WHERE phone_norm IS NOT NULL;
CREATE INDEX candidates_name_idx ON candidates (name_norm);
CREATE INDEX candidates_owner_idx ON candidates (owner_user_id);

CREATE TABLE candidate_identity_refs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id  uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('passport','national_id')),
  value_enc     text NOT NULL,                 -- AES-256-GCM
  value_hash    text NOT NULL,                 -- HMAC for equality / duplicate detection only
  issuing_country text,
  issue_date    date,
  expiry_date   date,
  recorded_by   uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, value_hash)
);

CREATE TABLE consents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN ('terms','privacy','data_processing','marketing','media_sharing','ai_processing')),
  version      text NOT NULL,
  granted_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  ip           text
);
CREATE UNIQUE INDEX consents_active_uidx ON consents (user_id, type) WHERE revoked_at IS NULL;

CREATE TABLE data_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  type        text NOT NULL CHECK (type IN ('export','deletion')),
  status      text NOT NULL DEFAULT 'received' CHECK (status IN ('received','in_review','completed','rejected')),
  note        text,
  handled_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── jobs ─────────────────────────
CREATE SEQUENCE job_ref_seq START 1000;
CREATE SEQUENCE lead_ref_seq START 1000;
CREATE SEQUENCE application_ref_seq START 1000;
CREATE SEQUENCE case_ref_seq START 1000;

CREATE TABLE jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_no    text NOT NULL UNIQUE DEFAULT ('FW-J-' || nextval('job_ref_seq')),
  org_id          uuid NOT NULL REFERENCES organizations(id),
  created_by      uuid NOT NULL REFERENCES users(id),
  title           text NOT NULL,
  profession      text,
  profession_norm text,
  category        text,
  vacancies       int NOT NULL DEFAULT 1 CHECK (vacancies > 0),
  country         text,
  city            text,
  address         text,
  latitude        numeric(9,6),
  longitude       numeric(9,6),
  description     text,
  responsibilities text,
  requirements    text,
  experience_min_years numeric(4,1),
  skills          text[] NOT NULL DEFAULT '{}',
  languages       jsonb NOT NULL DEFAULT '[]',
  salary_specified boolean NOT NULL DEFAULT false,
  salary_min      numeric(12,2),
  salary_max      numeric(12,2),
  salary_currency text,
  salary_period   text CHECK (salary_period IN ('hour','day','week','month','year')),
  salary_basis    text NOT NULL DEFAULT 'unspecified' CHECK (salary_basis IN ('gross','net','unspecified')),
  hours_per_day   numeric(4,1),
  days_per_week   numeric(3,1),
  shifts          text,
  overtime_terms  text,
  contract_months int,
  probation_months int,
  employment_type text CHECK (employment_type IN ('full_time','part_time','contract','seasonal','temporary')),
  work_mode       text NOT NULL DEFAULT 'onsite' CHECK (work_mode IN ('onsite','remote','hybrid')),
  accommodation   text NOT NULL DEFAULT 'unspecified' CHECK (accommodation IN ('provided','allowance','not_provided','unspecified')),
  food            text NOT NULL DEFAULT 'unspecified' CHECK (food IN ('provided','allowance','not_provided','unspecified')),
  transport       text NOT NULL DEFAULT 'unspecified' CHECK (transport IN ('provided','allowance','not_provided','unspecified')),
  insurance       text NOT NULL DEFAULT 'unspecified' CHECK (insurance IN ('provided','not_provided','unspecified')),
  other_benefits  text,
  relocation_support boolean,                 -- NULL = not specified
  international_recruitment boolean,          -- NULL = not specified; never inferred
  employer_confirmed_visa_support boolean,    -- NULL = not specified; never inferred
  accepted_formats text[] NOT NULL DEFAULT '{cv}',
  deadline        date,
  allow_reapplication boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_approval','changes_requested','rejected','published','paused','closed')),
  status_reason   text,
  version         int NOT NULL DEFAULT 1,            -- optimistic concurrency token
  published_version int NOT NULL DEFAULT 0,          -- last approved/published content version
  published_at    timestamptz,
  last_verified_at timestamptz,
  closed_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_public_idx ON jobs (status, country, profession_norm);
CREATE INDEX jobs_org_idx ON jobs (org_id);
CREATE INDEX jobs_skills_idx ON jobs USING GIN (skills);

CREATE TABLE job_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  version      int NOT NULL,
  snapshot     jsonb NOT NULL,
  material_changes jsonb NOT NULL DEFAULT '[]',
  approved_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, version)
);

CREATE TABLE job_status_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id     uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  from_status text,
  to_status  text NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── leads, applications, cases ─────────────────────────
CREATE TABLE leads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_no  text NOT NULL UNIQUE DEFAULT ('FW-L-' || nextval('lead_ref_seq')),
  source        text NOT NULL CHECK (source IN ('application','website_inquiry','agency','manual')),
  status        text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','under_review','missing_information','rejected','qualified')),
  status_reason text,
  application_id uuid,
  candidate_id  uuid REFERENCES candidates(id),
  submitted_by_user uuid REFERENCES users(id),
  snapshot      jsonb NOT NULL,                       -- applicant details as submitted
  email_norm    text,
  phone_norm    text,
  assigned_to   uuid REFERENCES users(id),
  first_response_at timestamptz,
  qualified_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1
);
CREATE INDEX leads_queue_idx ON leads (status, assigned_to);

CREATE TABLE applications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_no  text NOT NULL UNIQUE DEFAULT ('FW-A-' || nextval('application_ref_seq')),
  job_id        uuid NOT NULL REFERENCES jobs(id),
  candidate_id  uuid NOT NULL REFERENCES candidates(id),
  submitted_by_user uuid REFERENCES users(id),
  source        text NOT NULL DEFAULT 'web' CHECK (source IN ('web','agency','ai_assisted','staff')),
  stage         text NOT NULL DEFAULT 'submitted'
    CHECK (stage IN ('submitted','under_review','missing_information','shortlisted','interview_requested',
                     'interview_scheduled','selected','rejected','withdrawn','position_closed')),
  stage_reason  text,
  cover_note    text,
  profile_snapshot jsonb NOT NULL,                    -- frozen at submission
  job_version   int NOT NULL,
  idempotency_key text,
  released_to_employer boolean NOT NULL DEFAULT false,
  contact_disclosed boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1
);
-- one active submission per candidate/job
CREATE UNIQUE INDEX applications_active_uidx ON applications (candidate_id, job_id)
  WHERE stage NOT IN ('rejected','withdrawn','position_closed');
CREATE UNIQUE INDEX applications_idem_uidx ON applications (submitted_by_user, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX applications_job_idx ON applications (job_id, stage);
CREATE INDEX applications_candidate_idx ON applications (candidate_id);
ALTER TABLE leads ADD CONSTRAINT leads_application_fk FOREIGN KEY (application_id) REFERENCES applications(id);
CREATE UNIQUE INDEX leads_application_uidx ON leads (application_id) WHERE application_id IS NOT NULL;

CREATE TABLE application_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_stage    text,
  to_stage      text NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  actor_role    text,
  reason        text,
  message       text,
  visibility    text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','internal')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX application_events_idx ON application_events (application_id, created_at);

CREATE TABLE internal_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type IN ('application','lead','candidate','organization')),
  entity_id   uuid NOT NULL,
  author_id   uuid NOT NULL REFERENCES users(id),
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX internal_notes_idx ON internal_notes (entity_type, entity_id);

CREATE TABLE employer_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  org_id         uuid NOT NULL REFERENCES organizations(id),
  type           text NOT NULL CHECK (type IN ('shortlist','interview','selection')),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','cancelled')),
  requested_by   uuid NOT NULL REFERENCES users(id),
  note           text,
  decided_by     uuid REFERENCES users(id),
  decided_at     timestamptz,
  decision_note  text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX employer_requests_pending_uidx ON employer_requests (application_id, type) WHERE status = 'pending';

CREATE TABLE duplicate_reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       uuid REFERENCES leads(id),
  candidate_id  uuid NOT NULL REFERENCES candidates(id),      -- the person under review
  matched_candidate_id uuid NOT NULL REFERENCES candidates(id),
  reasons       text[] NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','merged','kept_separate')),
  resolved_by   uuid REFERENCES users(id),
  resolved_at   timestamptz,
  resolution_note text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX duplicate_reviews_open_uidx ON duplicate_reviews (candidate_id, matched_candidate_id) WHERE status = 'open';

CREATE TABLE recruitment_cases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_no  text NOT NULL UNIQUE DEFAULT ('FW-C-' || nextval('case_ref_seq')),
  application_id uuid NOT NULL UNIQUE REFERENCES applications(id),
  candidate_id  uuid NOT NULL REFERENCES candidates(id),
  job_id        uuid NOT NULL REFERENCES jobs(id),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  stage         text NOT NULL DEFAULT 'offer'
    CHECK (stage IN ('offer','documents','contract','work_permit','visa_appointment','visa_result','travel','arrival','started_work','follow_up','closed')),
  stage_reason  text,
  owner_user_id uuid REFERENCES users(id),
  opened_by     uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1
);

CREATE TABLE case_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  from_stage  text,
  to_stage    text NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  origin      text NOT NULL DEFAULT 'findway',
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job_change_acks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  job_version    int NOT NULL,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  candidate_id   uuid NOT NULL REFERENCES candidates(id),
  changes        jsonb NOT NULL,
  notified_at    timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  UNIQUE (application_id, job_version)
);

CREATE TABLE ownership_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type IN ('candidate','organization','lead','case')),
  entity_id   uuid NOT NULL,
  from_user   uuid REFERENCES users(id),
  to_user     uuid REFERENCES users(id),
  changed_by  uuid NOT NULL REFERENCES users(id),
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── notifications & messages ─────────────────────────
CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  dedupe_key text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX notifications_dedupe_uidx ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

-- Honest delivery states: never 'delivered' unless a provider receipt says so.
CREATE TABLE outbound_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel      text NOT NULL DEFAULT 'email' CHECK (channel IN ('email','push','whatsapp')),
  kind         text NOT NULL CHECK (kind IN ('transactional','outreach_draft')),
  template     text NOT NULL,
  to_user_id   uuid REFERENCES users(id),
  to_address   text NOT NULL,
  locale       text NOT NULL DEFAULT 'en',
  subject      text NOT NULL,
  body_text    text NOT NULL,                     -- '[redacted]' for messages carrying one-time codes
  status       text NOT NULL CHECK (status IN ('prepared','approved','queued','provider_accepted','delivered','failed','replied')),
  provider     text,
  provider_message_id text,
  attempts     int NOT NULL DEFAULT 0,
  last_error   text,
  approved_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  queued_at    timestamptz,
  accepted_at  timestamptz,
  delivered_at timestamptz,
  failed_at    timestamptz
);

-- ───────────────────────── integration infrastructure ─────────────────────────
CREATE TABLE integration_connections (
  key             text PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('adapter')),
  display_name    text NOT NULL,
  enabled         boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'not_configured'
    CHECK (status IN ('not_configured','configured_untested','connected','auth_failed','unreachable','disabled')),
  base_url        text,
  last_tested_at  timestamptz,
  last_test_error text,
  last_success_at timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq            bigserial UNIQUE,
  type           text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id   uuid NOT NULL,
  aggregate_version int NOT NULL DEFAULT 0,
  origin         text NOT NULL DEFAULT 'findway',
  correlation_id text,
  data           jsonb NOT NULL DEFAULT '{}',        -- ids + changed field names only; adapters re-read current state
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_agg_idx ON outbox_events (aggregate_type, aggregate_id, seq);

CREATE TABLE webhook_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url         text NOT NULL,
  events      text[] NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  description text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sync_deliveries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES outbox_events(id) ON DELETE CASCADE,
  target_key    text NOT NULL,                       -- 'trustcrm' | 'webhook:<subscription id>'
  status        text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','retry','succeeded','skipped','blocked','dead')),
  attempts      int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  completed_at  timestamptz,
  last_error    text,
  detail        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, target_key)
);
CREATE INDEX sync_deliveries_due_idx ON sync_deliveries (next_attempt_at) WHERE status IN ('pending','retry');

CREATE TABLE dead_letters (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES sync_deliveries(id) ON DELETE CASCADE,
  target_key  text NOT NULL,
  event_type  text NOT NULL,
  error       text,
  attempts    int NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  replayed_at timestamptz,
  replayed_by uuid REFERENCES users(id)
);

CREATE TABLE external_mappings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system           text NOT NULL,
  entity_type      text NOT NULL,
  canonical_id     uuid NOT NULL,
  external_id      text NOT NULL,
  canonical_version int NOT NULL DEFAULT 0,        -- canonical version last reflected in the external system
  last_event_at    timestamptz,                    -- occurred_at of the newest inbound event applied
  last_synced_at   timestamptz,
  sync_origin      text,
  content_hash     text,                           -- hash of last payload sent/received (no-op + loop detection)
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (system, entity_type, canonical_id),
  UNIQUE (system, entity_type, external_id)
);

CREATE TABLE webhook_secrets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope      text NOT NULL,                        -- 'inbound:trustcrm' | 'outbound:<subscription id>'
  kid        text NOT NULL,
  secret_enc text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,                          -- set when rotated: old secret stays valid until then
  revoked_at timestamptz,
  UNIQUE (scope, kid)
);

CREATE TABLE inbound_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source       text NOT NULL,
  event_id     text NOT NULL,
  type         text NOT NULL,
  occurred_at  timestamptz,
  received_at  timestamptz NOT NULL DEFAULT now(),
  kid          text,
  status       text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','applied','stale_ignored','conflict','failed','ignored')),
  payload      jsonb NOT NULL,
  error        text,
  processed_at timestamptz,
  UNIQUE (source, event_id)
);

CREATE TABLE sync_conflicts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system         text NOT NULL,
  entity_type    text NOT NULL,
  canonical_id   uuid NOT NULL,
  field          text NOT NULL,
  local_value    jsonb,
  remote_value   jsonb,
  remote_event_at timestamptz,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved_local','resolved_remote','dismissed')),
  resolved_by    uuid REFERENCES users(id),
  resolved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sync_conflicts_open_uidx ON sync_conflicts (system, entity_type, canonical_id, field) WHERE status = 'open';

-- ───────────────────────── audit (append-only) ─────────────────────────
CREATE TABLE audit_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq            bigserial UNIQUE,
  at             timestamptz NOT NULL DEFAULT now(),
  actor_user_id  uuid,
  actor_role     text,
  via            text NOT NULL DEFAULT 'web',      -- web | api | mcp | system | worker
  client         text,
  action         text NOT NULL,
  entity_type    text,
  entity_id      text,
  details        jsonb NOT NULL DEFAULT '{}',
  correlation_id text,
  ip             text
);
CREATE INDEX audit_entity_idx ON audit_events (entity_type, entity_id);
CREATE INDEX audit_actor_idx ON audit_events (actor_user_id, at DESC);

CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: table is append-only', TG_OP, TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER application_events_immutable BEFORE UPDATE OR DELETE ON application_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER job_versions_immutable BEFORE UPDATE OR DELETE ON job_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER case_events_immutable BEFORE UPDATE OR DELETE ON case_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ownership_history_immutable BEFORE UPDATE OR DELETE ON ownership_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Attribution columns are write-once.
CREATE FUNCTION forbid_attribution_change() RETURNS trigger AS $$
BEGIN
  IF NEW.introduced_by IS DISTINCT FROM OLD.introduced_by THEN
    RAISE EXCEPTION 'introduced_by is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER organizations_attribution BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION forbid_attribution_change();
CREATE TRIGGER candidates_attribution BEFORE UPDATE ON candidates
  FOR EACH ROW EXECUTE FUNCTION forbid_attribution_change();

INSERT INTO integration_connections (key, kind, display_name) VALUES ('trustcrm', 'adapter', 'EMNA trust-crm (visa / case CRM)');
INSERT INTO settings (key, value) VALUES
  ('policy.candidate_approval', '"auto"'),
  ('policy.employer_job_requires_verified_org', 'true'),
  ('policy.otp', '{"ttl_minutes":10,"max_attempts":5,"resend_cooldown_seconds":30,"max_sends_per_hour":3}'),
  ('policy.sync_retry', '{"max_attempts":6,"base_seconds":30,"max_seconds":3600}'),
  ('crm.case_stage_map', '{"offer":"Offer","documents":"Documents","contract":"Contract","work_permit":"Work Permit","visa_appointment":"Visa Appointment","visa_result":"Visa Result","travel":"Travel","arrival":"Arrival","started_work":"Started Work","follow_up":"Follow-up","closed":"Closed"}');
