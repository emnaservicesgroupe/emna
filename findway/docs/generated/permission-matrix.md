# Permission matrix (generated)

_Generated from `src/permissions.js` by `scripts/gen-docs.js` — do not edit by hand._

Legend: **✓** granted once the account is email-verified, approved and (for internal roles) MFA-verified · **○** available while awaiting approval (onboarding only) · **✓\*** Super Admin holds the wildcard `*`.

| Permission | super_admin | admin | staff | employer_owner | employer_member | agency | candidate | guest |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `agency:self` | ✓* |  |  |  |  | ✓ |  |  |
| `applications:apply` | ✓* |  |  |  |  |  | ✓ |  |
| `applications:own` | ✓* |  |  |  |  |  | ✓ |  |
| `applications:view_all` | ✓* | ✓ |  |  |  |  |  |  |
| `applications:work` | ✓* | ✓ | ✓ |  |  |  |  |  |
| `assignments:manage` | ✓* | ✓ |  |  |  |  |  |  |
| `audit:read` | ✓* | ✓ |  |  |  |  |  |  |
| `candidate:self` | ✓* |  |  |  |  |  | ✓ |  |
| `candidates:view_all` | ✓* | ✓ |  |  |  |  |  |  |
| `candidates:view_assigned` | ✓* | ✓ | ✓ |  |  |  |  |  |
| `candidates:write_all` | ✓* | ✓ |  |  |  |  |  |  |
| `candidates:write_assigned` | ✓* | ✓ | ✓ |  |  |  |  |  |
| `cases:view_all` | ✓* | ✓ |  |  |  |  |  |  |
| `cases:work` | ✓* | ✓ | ✓ |  |  |  |  |  |
| `employer:applicants` | ✓* |  |  | ✓ | ✓ |  |  |  |
| `employer:jobs` | ✓* |  |  | ✓ | ✓ |  |  |  |
| `employer:org_manage` | ✓* |  |  | ✓ |  |  |  |  |
| `employer:requests` | ✓* |  |  | ✓ |  |  |  |  |
| `integrations:manage` | ✓* | ✓ |  |  |  |  |  |  |
| `integrations:view` | ✓* | ✓ | ✓ |  |  |  |  |  |
| `jobs:review` | ✓* | ✓ |  |  |  |  |  |  |
| `jobs:view_all` | ✓* | ✓ | ✓ |  |  |  |  |  |
| `leads:view_all` | ✓* | ✓ |  |  |  |  |  |  |
| `leads:work` | ✓* | ✓ | ✓ |  |  |  |  |  |
| `onboard:candidate_profile` | ✓* |  |  |  |  |  | ○ |  |
| `onboard:org` | ✓* |  |  | ○ |  | ○ |  |  |
| `orgs:create` | ✓* | ✓ | ✓ |  |  |  |  |  |
| `orgs:verify` | ✓* | ✓ | ✓ |  |  |  |  |  |
| `orgs:view_all` | ✓* | ✓ |  |  |  |  |  |  |
| `orgs:view_assigned` | ✓* | ✓ | ✓ |  |  |  |  |  |
| `requests:resolve` | ✓* | ✓ | ✓ |  |  |  |  |  |
| `users:approve` | ✓* | ✓ |  |  |  |  |  |  |
| `users:create_staff` | ✓* | ✓ |  |  |  |  |  |  |
| `users:suspend` | ✓* | ✓ |  |  |  |  |  |  |

## Always available (any signed-in account)

`self:read`, `session:manage`; `self:verify` until the email is verified; `self:onboard`/`self:mfa` once verified (`self:mfa` is the only capability of a privileged session that has not completed MFA).

## Privileged roles

Roles that must complete MFA before any permission applies: `super_admin`, `admin`, `staff`.
