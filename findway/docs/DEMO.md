# End-to-end demonstration (synthetic data only)

Run it yourself: `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm run test:e2e` (or point it at any Chromium). It boots the app against a throw-away database, seeds fictional users, and drives the real UI. Screenshots land in `e2e-artifacts/`; six are kept in [screenshots/](screenshots/).

## What the 21 steps prove (all passed on 2026-10-23)
| # | Step |
|---|---|
| a1 | Home renders live jobs; no fabricated statistics |
| a2 | Register candidate → OTP from dev mail (wrong code rejected first) → verify → login |
| a3–a4 | Cannot apply before the profile is complete (missing fields listed); phone format validated; profile saved |
| a5–a6 | Job search with URL-synced filters → details → apply; applying twice is blocked with a clear message |
| a7 | Revoked session → login page with a "session expired" notice |
| b1–b3 | Staff login with TOTP → lead queue → qualify without creating a duplicate person; unauthorised staff area shows an explanation, not data |
| c1–c4 | Admin approves an account, reviews and approves a job (needs verified employer), integrations page never says "Connected" without a real test, audit log shows the actions |
| d1–d4 | **Arabic, 390×844 mobile:** `dir=rtl lang=ar`, no horizontal overflow on home/jobs/job detail/login/register/profile/applications/application detail; Arabic user-entered titles use `dir=auto`; keyboard-operable menu; live language switch ar→sq→fr→en with correct direction |
| d5 | Service worker registers; manifest served |
| e1–e2 | Zero console/page errors; zero CSP violations |

## Not exercised in the browser (implemented, covered by API tests)
Employer applicant actions, the full job-editor field set, the lead duplicate-merge panel, webhook-subscription forms. **Not measured:** colour contrast, screen-reader behaviour.

## Try it manually
```bash
npm run seed:demo        # prints synthetic accounts; internal accounts need a TOTP code: node scripts/totp.js <secret>
npm start                # open http://localhost:4000 ; switch language in the header
```
