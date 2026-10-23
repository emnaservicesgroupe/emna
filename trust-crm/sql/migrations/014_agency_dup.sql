-- Stage 3 (agency portal): staff-only duplicate flags on agency-registered leads. Additive and idempotent.
-- duplicate_of / duplicate_candidate_id point at the existing lead / candidate that matched on email, phone or
-- passport; passport_norm is the normalised passport (upper-case letters and digits) used only for that matching.
-- None of these columns is ever exposed to portal users.
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS duplicate_of bigint;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS duplicate_candidate_id int;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS passport_norm text;
CREATE INDEX IF NOT EXISTS crm_leads_passport_idx ON crm_leads (passport_norm) WHERE passport_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_leads_phone_digits_idx ON crm_leads ((regexp_replace(coalesce(phone, ''), '\D', '', 'g'))) WHERE phone IS NOT NULL;
