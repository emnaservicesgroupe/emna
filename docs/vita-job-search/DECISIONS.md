# Decisions taken on the owner's behalf

You asked for the work to be finished without check-ins, so these decisions were made during the build.
Each one says what was decided, why, and what it costs if it turns out to be wrong.
Anything here can be reversed; tell us which and it will be changed.

## Product and safety rules

| # | Decision | Why | Cost if wrong |
|---|----------|-----|---------------|
| 1 | The employer-support label read from an advertisement ("stated in ad", "unavailable"…) is **informational only**. It is always shown with its quoted evidence and "verify with the employer". Automatic sending for a candidate who needs employer support is allowed only when staff recorded a **confirmed** label. | Reading free text for immigration-relevant claims proved impossible to make watertight: five review rounds each found new wrong positives. | Some genuine automatic applications wait for a human click. |
| 2 | **Acknowledgement evidence is staff-confirmed by default** (`INBOUND_AUTO_ACK_EVIDENCE=false`). A reply that looks like an acknowledgement opens a staff task; staff click to confirm. The automatic mode exists as an opt-in that accepts a small false-positive risk. | Same reason as 1. "Never show success without evidence" outranks convenience. | More manual clicks for staff. |
| 3 | `delivery_receipt` evidence can only come from the system (a signed provider report), never from a person typing it. Staff use `manual_confirmation` (note of ≥10 characters) or `employer_acknowledgement`. | A typed "receipt" proves nothing. | None. |
| 4 | Pausing the module, a source or a candidate **holds** queued applications (they go back to "approved" and are re-queued on resume). Withdrawing consent, suspending an account or deleting a candidate **cancels** them for good. | Pauses are operational; consent is a legal right. | None. |
| 5 | Automatic sending goes only to the employer's **verified contact address or an address at its verified domain**. A person-approved send may use an address named in the advertisement and the approver sees where the CV goes. | Advertisement text is untrusted. | One extra staff step per new employer. |
| 6 | Sensitive documents (passport, IDs, police certificate, medical, civil status…) are **deny-by-default**: only a short list of known-safe types is shared freely; everything else needs a candidate-granted, application-specific authorization with a stated need. | Free-text document names cannot be trusted. | Some ordinary documents ask for the candidate's authorization. |
| 7 | CVs that were never scanned for malware are **not attached** unless `ALLOW_UNSCANNED_ATTACHMENTS=true`. The start-up check refuses real mail with unscanned attachments and no ClamAV. | Safer default. | On a real server, applications stay in "preparing" until ClamAV is connected or the setting is deliberately changed. |
| 8 | Send caps default to **0** (no automatic sends) until an admin sets them. | Nothing sends by accident. | An admin must set caps before automatic mode does anything. |
| 9 | Only Admin/SuperAdmin can reassign or delete a candidate (a pre-existing route was changed). Staff can no longer take another staff member's candidate. | The old route defeated the data-isolation rule. | Staff who used to reassign candidates must ask an admin. |
| 10 | Only Admin/SuperAdmin can change an employer's verified domain/contact or rename it. | It decides where automatic sends go. | Managers must ask an admin. |
| 11 | Candidates see fixed reason codes in their timeline, never staff free text. | Privacy. | Less detail for candidates. |
| 12 | Staff login now has a rate limit and one generic error message; staff tokens carry a version (revocable) and last 12 h by default. | The login was open to the internet in the deployment kit. | A staff member can be locked for 15 minutes by someone guessing their email; a restart clears it. |
| 13 | The first-admin endpoint is closed to the internet (proxy rule + loopback-only + atomic). | Anyone could have created the first SuperAdmin on a fresh server. | `create-admin.sh` is the only way. |
| 14 | `trust-crm/.env` was removed from git tracking. | It held development credentials. | **Its values remain in git history; rotate anything used outside local development.** |

## Engineering choices

- Extra migrations 003–010 were added where a table or column was really needed (all additive, idempotent, verified on existing data by `scripts/verify-migrations.js`).
- Search retries, replies and sends run through a database-backed queue with advisory locks; locks are namespaced by schema so tests cannot interfere.
- The app connects to Postgres as an unprivileged role in the deployment kit.
- Restore replaces the database only after the restored copy and the uploads archive validated.
- A few small fixes (a one-line pass-through for rate-limit back-off, the seed-script guards, the third deployment re-review) were accepted without a further independent review round because their tests fail on the old code; the final whole-branch review and the later targeted reviews cover them.

## Not done on purpose
- No real job source, mailbox, ClamAV, WhatsApp/Meta channel or external calendar sync is connected.
- The rest of the original platform brief (public website, employer/agency portals, accounting, attendance, chat, MCP) has not been started.
