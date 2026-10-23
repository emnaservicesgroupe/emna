# Permissions and data-access boundaries

The role × permission table is **generated from code**: [generated/permission-matrix.md](generated/permission-matrix.md) (a test fails if it drifts). This page states the rules around it.

## Layers (all must pass)
1. **Authentication** — valid, unexpired, unrevoked session; account not suspended.
2. **Account gates** — email verified → (privileged roles) MFA verified → administrator approval. Failing a gate returns a specific code: `email_verification_required`, `mfa_required`, `approval_required`, `account_suspended`.
3. **Role permission** — `permissions.js`.
4. **Resource scope** — in the service layer (below).
5. **Database constraints** — uniqueness, append-only, immutability.

## Resource scope by role (enforced and tested)
| Role | May access | Never |
|---|---|---|
| Candidate | own profile, consents, applications (public history only), own notifications, own case stage | other candidates; internal notes; staff/employer endpoints |
| Employer owner / member | own organisation, its jobs (any status), **released** applicants of those jobs in a minimised view; org management owner-only | other companies' jobs/applicants (404); candidate DOB, identity data, internal notes, agency pricing; contact details unless disclosed (direct mode or staff disclosure) |
| Partner agency | own organisation + status (Phase 1) | everything else; submissions arrive in Phase 2 with the same own-records rule |
| Staff | candidates/companies/cases they **own**, leads assigned to them + the unassigned queue, applications of those | unassigned/others' candidates, companies, cases (404); approvals; integrations management; audit log |
| Admin | all operational records; approvals; job review; integrations; audit read; staff creation; reassignment | creating/suspending administrators, MFA reset (Super Admin only) |
| Super Admin | everything (`*`) incl. pricing/destructive actions when they exist (Phase 2) | — |
| Restricted guest | only records explicitly included in a link (Phase 2) | everything else |

## Specific rules implemented
* Cross-company/candidate access returns **404**, not 403, so existence is not revealed.
* Staff cannot approve accounts, review jobs, manage integrations or read the audit log; an admin cannot approve themself.
* Employers **cannot approve their own jobs**; approving a job from an unverified employer needs an explicit recorded override.
* An employer's *selection request* never selects; only staff resolve it, and opening a recruitment case is a further explicit staff action.
* Reassignment (admin) is audited with a reason, preserves `introduced_by`/`created_by`, and moves access (old owner loses it, new owner gains it).
* Exports, file access and background tasks: no export or file features exist in Phase 1; the delivery worker runs as the `system` actor and only reads/writes what the adapter needs; payloads to webhooks contain identifiers only. The same-scope-as-screen rule for exports is a Phase 2 acceptance criterion.
* MCP tools (Phase 3) will call these same functions with a narrowed principal (MCP_DESIGN.md).

## Tests that prove it
`tests/auth.test.js` (gates, MFA, approval, suspension), `tests/recruitment.test.js` ("isolation" and "attribution" tests), `tests/jobs.test.js` (employer isolation), `tests/security.test.js` (no mass assignment, no leakage, identity masking).
