-- Enable RLS (for Supabase/Postgres deployments that use authenticated JWT claims)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE visa_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Example policies. Adapt claim path based on your JWT setup.
CREATE POLICY users_self_read ON users
FOR SELECT USING (id = (auth.jwt() ->> 'id')::int);

CREATE POLICY users_admin_write ON users
FOR ALL USING ((auth.jwt() ->> 'role') IN ('SuperAdmin', 'Admin'))
WITH CHECK ((auth.jwt() ->> 'role') IN ('SuperAdmin', 'Admin'));

CREATE POLICY candidates_role_read ON candidates
FOR SELECT USING ((auth.jwt() ->> 'role') IN ('SuperAdmin', 'Admin', 'Manager', 'Receptionist', 'Accountant', 'HR', 'Agent'));

CREATE POLICY candidates_owner_or_admin_write ON candidates
FOR ALL USING (
  (auth.jwt() ->> 'role') IN ('SuperAdmin', 'Admin', 'Manager')
  OR assigned_to = (auth.jwt() ->> 'id')::int
)
WITH CHECK (
  (auth.jwt() ->> 'role') IN ('SuperAdmin', 'Admin', 'Manager')
  OR assigned_to = (auth.jwt() ->> 'id')::int
);

CREATE POLICY finance_accounting_policy ON invoices
FOR ALL USING ((auth.jwt() ->> 'role') IN ('SuperAdmin', 'Admin', 'Accountant'))
WITH CHECK ((auth.jwt() ->> 'role') IN ('SuperAdmin', 'Admin', 'Accountant'));

CREATE POLICY payments_accounting_policy ON payments
FOR ALL USING ((auth.jwt() ->> 'role') IN ('SuperAdmin', 'Admin', 'Accountant'))
WITH CHECK ((auth.jwt() ->> 'role') IN ('SuperAdmin', 'Admin', 'Accountant'));
