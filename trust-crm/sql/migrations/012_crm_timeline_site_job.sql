-- Allow staff-published site offers to carry insert-only timeline history (entity 'site_job').
ALTER TABLE crm_timeline DROP CONSTRAINT IF EXISTS crm_timeline_entity_check;
ALTER TABLE crm_timeline ADD CONSTRAINT crm_timeline_entity_check CHECK (entity IN ('lead','candidate','employer','site_job'));
