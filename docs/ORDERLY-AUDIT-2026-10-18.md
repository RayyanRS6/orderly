# Orderly pre-launch audit and remediation, 18–19 October 2026

Scope: the whole repository (React dashboard and public pages, Hono API on the Supabase Edge Function,
Postgres migrations, the Railway linked-phone gateway, CI, docs), checked against the owner's brief for a
pre-launch technical, security, privacy and product audit. Work happened on the local branch
`audit/prelaunch-2026-10-18`. It was released to production on 19 October 2026 ([§10](#10-release-record-19-october-2026));
the sections below describe the state before that release.

Companion documents: [all audit findings](ORDERLY-AUDIT-2026-10-18-FINDINGS.md) (219 rows with status),
[compliance notes](COMPLIANCE-NOTES-2026-10-18.md) (rules, sources, dates),
[deployment guide §7–8](DEPLOYMENT.md) (release order, rollback, owner actions),
[incident runbook](INCIDENT-RUNBOOK.md), [backup and restore](BACKUP-AND-RESTORE.md).

## 1. Executive summary

**Verdict: ready only for a controlled pilot** (the friend's restaurant, with staff watching the dashboard)
**after** the owner actions in §6 and the release steps in [DEPLOYMENT.md §7](DEPLOYMENT.md). It is **not**
ready for unattended traffic or for more restaurants on the current Supabase Free plan.

What the audit found in the original code (commit `9316c89`):

- **The security and money core was sound.** No cross-tenant read or write was found. Supabase sessions are
  checked on the server for every request, every `:id` route is scoped to the caller's business in code
  and in SQL, row-level security is on for all 26 tables, and every database function is service-role
  only. Prices are integer paisa, re-checked in SQL when an order is saved. Duplicate orders are blocked by
  unique keys, and webhooks from Meta and the gateway are signature-checked in constant time.
- **The launch risks were elsewhere:**
  - **Conversations.** Everyday messages (a reaction, a location pin, a photo with a caption, "confirm
    karein", a returning customer, a provider hiccup) handed chats to staff permanently.
  - **Safety.** AI allergy reassurances went out unchecked, and Urdu claims that an order was placed got
    through.
  - **Linked phone.** The gateway gave up reconnecting after brief network errors, alerted nobody, and
    breaches WhatsApp's terms.
  - **Operations.** There was no pipeline monitoring and no backups, the free-plan call quota could run
    out from heartbeats and polling alone, and every push deployed the backend without running tests.
  - **Privacy.** The privacy text did not match what the software does.

What is true now on the branch:

- All 8 findings that verifiers rated high (P1) are fixed except backups, which are an owner action, with a
  script and a restore drill provided.
- 52 of 97 moderate (P2) findings are fixed, 8 partly; the rest are deferred with reasons (§8).
- The test suite grew from 725 to 2,135 passing tests. Typecheck, builds, the real Deno bundle smoke test,
  the gateway tests and three dependency audits are clean (§4).
- Three adversarial review passes and an independent fix verification found and corrected regressions
  along the way (§4.3).

Decisive remaining reasons the label is "controlled pilot" and not "production":

1. **Not live yet.** Nothing is deployed, and the fixes need the release steps, including SQL applied by
   hand.
2. **Not tested for real.** Nothing has been tested on real WhatsApp, real phones or real AI models; that
   needs your OK because it bills your keys.
3. **No backups yet.** Supabase Free has no backups until you set up the nightly script and do a restore
   drill.
4. **Legal text unfinished.** The privacy policy has owner placeholders, and the linked phone breaches
   WhatsApp's terms (your decision: admin approval only).
5. **Heuristic safety filters.** The allergy and payment-claim filters are pattern-based. They are
   heavily tested (every reviewed phrase is a test) but cannot be complete; an approved allergy answer per
   restaurant and staff supervision remain necessary.

## 2. Findings and severity

Severity is the one independent verifiers settled on. "Before" is the original code; "after" is the
branch tip. The full list of 219 audit findings with their status is in the
[findings appendix](ORDERLY-AUDIT-2026-10-18-FINDINGS.md).

### 2.1 High (P1) findings

| ID  | Finding                                                                                                                               | Area             | Risk                                 | Resolution                                                                                                                                           | Verification                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| F01 | Non-text messages (reaction, location, captioned photo, button, system event) became a permanent staff handoff and lost their content | WhatsApp ingress | Orders stall outside staff hours     | Reactions/system events ignored; captions, buttons and locations read as text on both routes; only audio, stickers and uncaptioned media go to staff | Fixed; tests on Meta and gateway paths                       |
| F02 | A stalled job pipeline (e.g. worker secret drift) was invisible                                                                       | Ops              | Silent outage                        | `orderly_pipeline_health()` + `GET /api/health/pipeline` (token-protected) for an external monitor                                                   | Fixed; SQL and route tests. Monitor setup is an owner action |
| F04 | Gateway stopped reconnecting after short failures, nobody alerted                                                                     | Gateway          | Linked restaurants offline for hours | Capped back-off with no attempt limit; abandoned pairings end; dead linked phones raise a staff alert                                                | Fixed; gateway and SQL tests                                 |
| F06 | Heartbeats + dashboard polling could exhaust the Free plan's 500k calls                                                               | Ops              | Platform-wide outage mid-month       | Heartbeat 15 s → 60 s; dashboard polls pause in hidden tabs and refresh only on change                                                               | Fixed; request-budget tests (idle Inbox ≈ 372 calls/hour)    |
| F08 | Wrong quantity after a "which one?" choice                                                                                            | Engine           | Wrong orders                         | Counts read only next to their dish; Half/Full and between-dish numbers handled                                                                      | Fixed; quantity tests (all reviewer phrases)                 |
| F09 | AI allergy/ingredient assurances reached customers                                                                                    | Engine/AI        | Customer harm                        | Allergy questions get the owner's approved answer, or a fixed notice + staff; AI reassurances are dropped                                            | Fixed with tests; heuristic, see §1                          |
| F10 | Dashboard signed every staff member out on any 401                                                                                    | Frontend         | Missed orders in background tabs     | Token from the session on each request, one shared refresh, sign-out only on a definite failure                                                      | Fixed; session tests                                         |
| F15 | No backups or restore drill on Supabase Free                                                                                          | Ops              | Data loss                            | `npm run backup:db`, nightly schedule, restore drill in [BACKUP-AND-RESTORE.md](BACKUP-AND-RESTORE.md)                                               | **Owner action**                                             |

Also high before verification, settled as P2 by the verifiers: the unofficial linked phone (F03, owner decision

- copy + admin approval + recorded consent), Sheet menu outages handing every chat to staff (G1.1, now
  serves the last good menu up to 12 h), and provider rate limits at rush time (G4.3, bounded retry then a
  10-minute auto-resume pause). All three are fixed or handled as described.

### 2.2 Most important moderate (P2) fixes

Order integrity:

- Confirmation is tied to the latest review (within 60 minutes), with wider but safe consent phrases.
- A returning customer is no longer locked out by an old order.
- Delivery is never offered without delivery areas.
- No confirmable review while the restaurant is closed.
- Late messages get a fresh review instead of a handoff.
- Order-status questions are answered without an AI call.
- Unaccepted orders get a customer reminder at 15 minutes.

Safety and honesty:

- Urdu and Roman Urdu "order placed" and price claims are filtered, as are "payment received" claims.
- Every chat starts with "<Restaurant>'s AI assistant. Type 'staff' anytime to talk to a person."
- Customer notices follow the customer's language.

Spam and cost (owner decision):

- One person sending 25 messages a minute is paused for 15 minutes; one person past 100 AI replies an
  hour is paused for 1 hour. Both pauses end on their own and affect only that person.
- The restaurant-wide safety net is 1,500 replies an hour, with an alert at 80%.
- Restaurants still on the old 300/30 defaults get the new ones.
- Staff test chats are rate limited.

Reliability:

- A failed incoming message no longer blocks later ones.
- Sends queued for an old phone end as "not sent".
- Worker leases fit Free's 150-second limit (`WORKER_LEASE_SECONDS`, default 180).
- An emergency stop (`ORDERLY_PAUSE_AUTOMATION`).

Security and privacy:

- Linked-phone pairing needs platform-admin approval and recorded consent.
- AI connect requires "paid plan, no training opt-in" confirmations.
- Server-managed settings can't be overwritten by a save.
- Stale settings saves are refused, except a pause, which always applies.
- Secrets and phone numbers are kept out of logs.
- Customer erasure and export match every number format and chats without a phone number.
- The phone number no longer survives erasure in job keys or delivery logs.
- Email alerts go to the right person.
- Old operational logs are purged.

Operations:

- Production deploys are gated on typecheck, tests and the Deno smoke test.
- Migrations refuse to be replayed out of order and record themselves in a ledger.
- Staff see alerts for a dead linked phone and a near-full hourly limit.

Product:

- Restaurants choose payment methods (cash, JazzCash, Easypaisa, bank transfer); customers are told to type
  "staff" for transfer details, and the AI hands those requests to staff.
- Staff can cancel an accepted order.
- A CSV import asks before replacing the menu.
- Cash-up CSV export with local times.
- New-order tab badge and optional sound.

### 2.3 Still open after remediation (moderate)

Deferred on purpose, with the reason; none blocks a supervised pilot:

- **WhatsApp:**
  - token expiry tracking (F18);
  - staff alert for failed Meta deliveries (F19; now logged, not alerted);
  - viewing customer media (F22);
  - a fuller order-status template (F23).
- **Gateway:** Baileys version strategy (F32); WhatsApp Business app greeting/away messages are not
  detected (F29, owner turns them off; documented).
- **Ordering:**
  - order IDs can repeat after erasure (F39);
  - one stored phone format (F40);
  - minimum order and caps (F41);
  - order editing, failed-delivery outcome, status history and a payment-received state (G3.x).
- **Admin and security:**
  - admin MFA is not enforced (F47; enrol first);
  - product IDs are global across tenants (F48);
  - add-by-email has no consent step (F51);
  - client-IP header trust needs one live request to check (F52).
- **Performance at scale:** public menu caching (F54), query and index work (F58–F61), and the delivery
  receipt lookup URL (F80).
- **Data rules:** retention never deletes chats left with staff (F70); credential-key rotation tooling
  (G6.2); auditing of reads (G6.5–G6.6).
- **Bot-off behaviour:** a bot switched off gives customers silence (G7.10, needs your wording).

Remaining known limits of the conversation filters, from the last fix round's own notes: some payment
wordings ("Payment done", "we have your payment") are still not caught, and a few true sentences ("staff
will confirm your payment once received") are handed to staff. Both fail toward staff, not toward a
false claim. With only the built-in rules (no AI), "karahi 4 naan" reads as 4 karahi; with the AI on, the
AI's reading wins.

## 3. Changes made

158 commits, 276 files, about 35,800 lines added, most of them tests. Grouped by area:

- **Engine** (`src/domain/*`): quantities, confirmation, allergy guard, outcome/price/payment filters,
  closed-hours notice, late messages, order status, AI-assistant notice (`disclosure.ts`), cancel and
  consent recognisers, localised refusals, payment-method wording.
  - _Why:_ each was a customer-facing failure reproduced offline.
  - _Verification:_ engine tests with stubbed AI actions; no real model was called.
- **Pipeline and AI** (`server/service.ts`, `server/integrations/models.ts`):
  - bounded retry of unbilled provider refusals inside the 25 s budget;
  - auto-resuming pauses; spam limits; Sheet-outage fallback;
  - order reminders, failed-job handling and the emergency stop;
  - OpenAI `store: false` and strict-schema compatibility;
  - prompt bytes unchanged for cash-only restaurants on default settings.
  - _Verification:_ the prompt snapshot tests pass unchanged, plus a test that explicit "cash only" sends
    identical words.
- **API and ingress** (`server/app.ts`, `server/whatsapp/*`, `server/integrations/*`):
  - Meta inbound mapping;
  - health route, admin linked-phone approval, consent and attestation checks;
  - stale-settings protection, privacy export/erase by chat, request IDs and scrubbed logs;
  - Sheets parsing by column name and real values.
- **Database** (`supabase/migrations/202610200001_prelaunch_fixes.sql`, `202610200002_order_followups.sql`):
  - every redefined function starts from its latest body; signatures and result shapes are unchanged;
  - part 1 is safe while the current backend runs;
  - a tested rollback restores every function byte-for-byte.
- **Gateway** (`gateway/**`): reconnect policy, heartbeat, dead-lettering, logout on disconnect, LID/phone
  mapping, captions and locations, stale-session self-clean, patched `sharp`/`music-metadata`.
- **Dashboard** (`src/components/*`, `src/lib/*`), including your UI/UX session's work (commit `a8af574`):
  - session refresh and request budget;
  - new alert kinds, emergency banner and spam fields;
  - AI confirmations, linked-phone consent and admin toggle, payment methods;
  - privacy actions in the Inbox, cancel after accept, cash-up export, tab badge and sound;
  - a build check that refuses to publish legal pages with placeholders.
- **CI and docs:**
  - the deploy is gated on tests; the release is one push with Railway "Wait for CI";
  - backup script and restore drill, incident runbook, compliance notes;
  - updated deployment and setup guides, and a privacy policy and terms that match the code.

**Behaviour changes to approve before deploying**, the customer- or staff-visible ones:

- **For customers:**
  - the AI-assistant line opens each chat;
  - allergy questions go to staff unless you add an approved answer;
  - a reminder after 15 minutes for an unaccepted order;
  - spam pauses;
  - a closed-hours notice in the first reply;
  - transfer customers are told to type "staff";
  - the menu page shows "from" prices for dishes with sizes.
- **For staff:**
  - Cancel order on accepted orders;
  - a CSV import confirmation;
  - new prices start empty;
  - linked-phone pairing needs admin approval;
  - AI connect asks two confirmations;
  - Bot settings warns before leaving with unsaved edits;
  - Agent flow shows the diagram only from 1280 px.

## 4. Test and scan results

### 4.1 Checks

| Check                                             | Before (`9316c89`)                          | After (`6c84489`)                                                                                   |
| ------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Typecheck `npx tsc --noEmit`                      | pass                                        | pass                                                                                                |
| Unit/integration `npx vitest run`                 | 725 passed, 33 files                        | **2,135 passed, 163 files**                                                                         |
| Gateway build + tests                             | build pass; 45 tests                        | build pass; **64/64**                                                                               |
| Production build `npm run build`                  | pass                                        | pass                                                                                                |
| Cloudflare build `build:cloudflare`               | pass                                        | refuses while legal placeholders remain (intended); passes with the override; writes `security.txt` |
| Real Deno edge bundle smoke                       | not run at baseline                         | pass (health, auth refusal, public menu)                                                            |
| `npm audit --omit=dev` (app)                      | 0                                           | 0                                                                                                   |
| `npm audit` (app incl. dev tools)                 | 7 (2 critical, 4 high, 1 moderate)          | **0** (Wrangler pinned to 4.147.0, a two-week-old release; `sharp` override)                        |
| `npm audit` (gateway)                             | 2 (`sharp` high, `music-metadata` moderate) | **0**                                                                                               |
| PGlite: full migration chain incl. both new files | n/a                                         | pass                                                                                                |
| Rollback check (apply 0001+0002, then rollback)   | n/a                                         | pass: every function restored exactly, second run unchanged, queued reminders ended, 0 failures     |
| `wrangler deploy --dry-run`                       | n/a                                         | pass                                                                                                |
| Docker build of the gateway                       | not run (no Docker here; CI builds it)      | not run locally                                                                                     |

### 4.2 Local preview (demo mode, in-memory data, no AI, no WhatsApp)

Checked in the built-in browser:

- Overview, with the new readiness row.
- An accepted order: the Cancel button, and "cash or transfer at pickup" with the staff note.
- Settings: the payment methods.
- Bot settings: the three spam limits at 1,500 / 100 / 25.
- The privacy page: 11 sections, with placeholders visible.
- The customer menu page at 320 px: no sideways overflow, and the transfer sentence shown in a screenshot.

No console errors. Not visually checked: the Inbox pause label (its seeded chats did not appear in the demo
store; the wording is unit-tested), live-only screens (login, MFA, pairing), and real phones.

### 4.3 Reviews

| Pass             | Scope                                         | Findings                               | Outcome                                |
| ---------------- | --------------------------------------------- | -------------------------------------- | -------------------------------------- |
| Audit            | whole repo, 12 areas + gap sweep (176 agents) | 143 merged + 75 gap                    | basis of this report                   |
| Review 1         | backend, gateway, wording, docs, tests        | 62 (27 confirmed)                      | fixed in fix round 1                   |
| Review 2         | migrations + frontend                         | 18 (6 confirmed)                       | fixed in rounds 3–4                    |
| Review 3         | all changes since review 1                    | 56 (15 confirmed, incl. 2 regressions) | fixed in rounds 3–4                    |
| Fix verification | 21 confirmed items, re-tested offline         | 10 resolved, 6 partly, 5 regressed     | all remaining fixes applied in round 4 |

Round 4's own fixes were checked by tests covering every example phrase from the reviews in both
directions (must-catch and must-allow). They were **not** put through another independent review pass.

### 4.4 Not run, and why

- **Live WhatsApp, live AI, real devices:** these would message real people or bill your AI keys. A small
  paid check (a few Urdu, allergy and transfer messages, about $0.002 each) needs your OK; see §7.
- **Restore drill and load test:** these need a second Supabase project and your access.

## 5. Privacy and compliance

**Data collected:**

- From customers: name, WhatsApp number or ID, delivery address and area, order details, chat text.
- Captions and shared locations are saved as text; photos, video, documents and voice notes are not stored.
- From staff: their email.
- Technical: one-way-hashed rate-limit keys.

**Who receives it:**

- Supabase: database in Sydney, Australia.
- Cloudflare: the website.
- Meta: official-route messages.
- Railway: linked-phone messages, decrypted on the gateway.
- The restaurant's AI provider (OpenAI, Anthropic or Google): the current message, recent chat and the menu.
- Google Sheets, if the restaurant connects one.
- Resend: staff emails only, with no customer data.

**How long it is kept:**

- Chats and orders: until the restaurant deletes them or turns on automatic deletion (30–3,650 days).
- Activity logs and unlinked receipts: purged after 90 days.
- Finished job contents: cleared after 14 days.
- Unused menu-page codes: wiped within about an hour.
- Backups: the period is for you to confirm; the docs suggest 14 days.

**Policy changes:**

- The privacy policy, terms and deletion page now describe this: the restaurant is the controller and
  Orderly its processor.
- They state the AI disclosure and that Orderly takes no payment details.
- They add a breach-notice commitment.
- Workspace deletion is done on request, with a documented procedure.
- They contain `[OWNER TO CONFIRM]` placeholders, and the dashboard build refuses to publish until these
  are filled.

Material conclusions (checked 2026-10-18; sources and certainty in the
[compliance notes](COMPLIANCE-NOTES-2026-10-18.md)):

- **WhatsApp Business App terms (effective 23 Sept 2026) forbid apps that interact with the service without
  WhatsApp's written consent.** The linked phone breaches them, with high certainty; WhatsApp can ban the number.
  Meta's Business Platform terms allow a restaurant ordering bot with an AI provider as a Solution Provider,
  but forbid using WhatsApp data to train models. _Source:_ facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform.
- **Anthropic's Usage Policy requires telling customers they are talking to AI at the start of each chat.**
  This is now implemented for every provider. _Source:_ anthropic.com/legal/aup.
- **Gemini's unpaid tier may use data to improve Google products and allows human review**, so the terms
  forbid free Gemini keys with real customers. _Source:_ ai.google.dev/gemini-api/terms.
- **Pakistan's Personal Data Protection Bill is not law** (drafts only), so there are no statutory DPO,
  registration or localisation duties today. _Source:_ moitt.gov.pk/Legislations (medium–high certainty).
- **Open questions for a lawyer:**
  - **PECA 2016 (and its 2025 amendment):** whether Orderly counts as a "service provider" with
    traffic-data retention duties (low certainty).
  - **Sales tax:** Punjab is 16% on cash and 8% on digital payments from July 2026, per PRA notification
    PRA/Member Legal/816/26 (seen only in news reports); Islamabad is 15%/5% under FBR. The open question
    is how tax should appear on WhatsApp order totals and fiscal invoices.
  - **Consumer acts:** the receipt rules in the Punjab 2005 and Islamabad 1995 acts.
  - **Data roles:** a data-processing agreement with each restaurant.

No claim of legal compliance is made; see the seven lawyer questions in the compliance notes.

## 6. Unfinished work and owner actions

| Priority              | Item                                                                | Next step                                                                                                                                                                    | What is needed                                    |
| --------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Before release        | Approve the behaviour changes (§3)                                  | Read the list; say which to keep                                                                                                                                             | Your decision                                     |
| Before release        | Legal placeholders                                                  | Fill `[OWNER TO CONFIRM]` in `src/components/Legal.tsx` (operator's legal name and address, backup period)                                                                   | Legal identity                                    |
| Before release        | Backups                                                             | `npm run backup:db`, nightly task, encrypted off-laptop copy, one restore drill                                                                                              | Database connection string (never in chat or Git) |
| Before release        | Secrets escrow                                                      | Put `CREDENTIAL_ENCRYPTION_KEY`, `MENU_LINK_SECRET`, gateway, Meta and DB secrets in a password manager                                                                      | Your accounts                                     |
| Before release        | Supabase Usage                                                      | Check this month's Edge Function calls                                                                                                                                       | Supabase dashboard                                |
| Before release        | Railway "Wait for CI" on; GitHub `production` environment main-only | Console settings ([DEPLOYMENT.md §8](DEPLOYMENT.md))                                                                                                                         | Railway/GitHub access                             |
| Before release        | Linked-phone decisions                                              | Approve or revoke each legacy linked-phone business ([DEPLOYMENT.md §4](DEPLOYMENT.md))                                                                                      | Your decision                                     |
| Before release        | Retired secrets                                                     | Delete the old Vercel project and old Cloudflare worker; rotate if exposed                                                                                                   | Account access                                    |
| Release               | SQL part 1, one push, dashboard, SQL part 2                         | [DEPLOYMENT.md §7](DEPLOYMENT.md), each step with your OK                                                                                                                    | Your OK per step                                  |
| Before real customers | Pilot acceptance test                                               | Section 7 list on the test business, then the friend's restaurant                                                                                                            | WhatsApp access; small AI cost with OK            |
| Before real customers | Per restaurant                                                      | Approved allergy answer; payment methods; menu prices include tax; turn off WhatsApp Business greeting/away messages on a linked phone; paid AI plan with no training opt-in | Restaurant owner                                  |
| Before real customers | External monitor                                                    | Set `HEALTH_CHECK_TOKEN`; point a free uptime monitor at `/api/health/pipeline`; alert after 2 failures                                                                      | Monitor account                                   |
| Before real customers | Admin MFA                                                           | Enrol an authenticator on the platform-admin account                                                                                                                         | Your phone                                        |
| Soon                  | Lawyer                                                              | The seven questions in the compliance notes, incl. WhatsApp terms, PECA, PRA/FBR display, DPA with restaurants                                                               | A Pakistani lawyer                                |
| Soon                  | Supabase Pro                                                        | Move before a third restaurant, the first paying one, or above ~60% of the call quota                                                                                        | $25/month                                         |
| Soon                  | Cloud API                                                           | Move linked-phone restaurants to the official Cloud API with coexistence                                                                                                     | Meta account access                               |

Never paste production secrets into chat or commit them; the scripts read them from environment variables.

## 7. Go-live checklist

Already verified in this audit: [x] code fixes and tests on the branch · [x] migrations and rollback in PGlite ·
[x] builds and Deno smoke · [x] dependency audits clean · [x] local preview of key screens.

Needs your action or approval:

1. **Production environment and secrets**
   - [ ] Supabase Usage checked.
   - [ ] Secrets escrowed in a password manager.
   - [ ] `WORKER_LEASE_SECONDS=180` set.
   - [ ] `HEALTH_CHECK_TOKEN` set if you use a monitor.
   - [ ] `ORDERLY_PAUSE_AUTOMATION` unset.
   - [ ] Retired Vercel and Cloudflare copies removed.
2. **HTTPS and infrastructure**
   - [ ] Railway "Wait for CI" on.
   - [ ] GitHub `production` environment main-only.
   - [ ] 2FA on Supabase, GitHub, Railway, Cloudflare and Meta.
3. **Database**
   - [ ] Backup taken and copied off the laptop.
   - [ ] SQL part 1 applied (SHA-256 below; function md5s before and after).
   - [ ] Ledger lists it.
   - [ ] After the dashboard deploy: SQL part 2 applied.
4. **WhatsApp**
   - [ ] Legacy linked-phone businesses approved or revoked.
   - [ ] Greeting/away messages off on linked phones.
   - [ ] Plan the move to Cloud API with coexistence.
   - [ ] Fuller utility template submitted.
5. **Payments**
   - [ ] Each restaurant's payment methods set.
   - [ ] Staff know transfer customers will type "staff".
   - [ ] Staff check transfers in their own app.
6. **Privacy and terms**
   - [ ] Placeholders filled.
   - [ ] Lawyer review scheduled.
   - [ ] Old plain backups removed from `.local\backups` (only `db-*` kept), as the policy says.
7. **Security**
   - [ ] Admin MFA enrolled.
   - [ ] New deploy token with expiry.
   - [ ] Paid AI plan with no training opt-in confirmed per business.
8. **Monitoring and incidents**
   - [ ] Uptime monitor on `/api/health/pipeline`.
   - [ ] Staff email alerts opted in.
   - [ ] Runbook read (emergency stop, rotation, breach).
9. **Staging smoke test, on the test business**, from the activation list in
   [DEPLOYMENT.md](DEPLOYMENT.md):
   - [ ] a real inbound message gets a reply;
   - [ ] menu, then an order in Urdu or Roman Urdu, then the review, then "confirm karein", gives exactly one order;
   - [ ] staff accept, then cancel;
   - [ ] an allergy question gets the approved answer or staff;
   - [ ] a transfer question goes to staff;
   - [ ] the 15-minute reminder arrives;
   - [ ] the emergency stop works;
   - [ ] a duplicate webhook still gives one order.
         With your OK this costs a few AI messages, about $0.002 each.
10. **Controlled launch**
    - [ ] Friend's restaurant only.
    - [ ] Staff watch the dashboard for the first days.
    - [ ] Spam limits left at the defaults.
11. **Rollback ready, and watch after launch**
    - [ ] Rollback file available, and [DEPLOYMENT.md §7 rollback](DEPLOYMENT.md) understood.
    - [ ] Daily look at failed jobs, handoffs and Supabase Usage for the first week.

Final checksums (LF / CRLF working copy):

- `202610200001_prelaunch_fixes.sql`: `5755fedeb1e825d1db242fcbf07ca59fb25378bd529440445fd05eefdd81eaf3` / `177edece3faead980963358c15890d8a4f618db43737ac6ce9715825b1831d90`.
- `202610200002_order_followups.sql`: `df8677bf6e419a51ba58b0daf00be5a72b57a211720741c8a99e412d498235e5` / `e2ca5b22d9623b7a0807b57be9a5a7049bc6a455494012ad06cb18790db7ec10`.
- Rollback file (`.local/backups/rollback-prelaunch-2026-10-20.sql`, not in Git): 21,821 bytes, `4f6fb30dfad9143e2bc5cba371a968df5b7045fadb91f72c816ec245f18f5e83`.

## 8. Recommended roadmap

- **Before launch:** the owner actions in §6, the release and the pilot acceptance test.
- **Shortly after launch (first month):**
  - Meta token-expiry and failed-delivery alerts (F18, F19).
  - Staff media viewing (F22).
  - Admin MFA enforcement (F47).
  - Tenant-scoped product IDs (F48).
  - Client-IP header check (F52).
  - Order editing, a failed-delivery outcome and status history (G3.x).
  - A "payment received" marker for transfers.
  - A minimum order (F41).
  - An away message when the bot is off (G7.10).
  - Supabase Pro.
- **Optional, later:**
  - Query and index work for scale (F58–F61).
  - Public menu caching (F54).
  - Credential-key rotation tooling (G6.2).
  - Read auditing (G6.5–G6.6).
  - Realtime instead of polling.
  - Media transcription.
  - Self-service workspace deletion.

## 9. Final launch verdict

1. **Most serious problems found:**
   - permanent staff handoffs from everyday messages and provider hiccups;
   - unchecked AI allergy and Urdu outcome claims;
   - a linked-phone gateway that gave up and breaches WhatsApp's terms;
   - no monitoring and no backups;
   - a quota that polling alone could exhaust;
   - ungated deploys;
   - privacy text that did not match the code.
2. **Fixed and verified in code:** all of those except backups (owner action) and the WhatsApp-terms
   question (owner decision, now with admin approval and consent). Verification is by 2,135 tests,
   builds, the Deno smoke test, PGlite migration and rollback runs, and three review passes. It is not
   verified on live systems.
3. **Single most important remaining blocker:** none of this is deployed, and there are no backups. Take
   the backup and do the restore drill, then release with [DEPLOYMENT.md §7](DEPLOYMENT.md).
4. **Steps before accepting real orders:**
   - the §6 "before release" actions;
   - the one-push release;
   - the pilot acceptance test on the test business;
   - an approved allergy answer and payment methods for the friend's restaurant;
   - staff watching the dashboard.
5. **Is it responsible to go live now?** Not with the code as it is in production today. With this branch
   released as documented, the backup in place and the acceptance test passed, a supervised pilot with one
   friend's restaurant is a reasonable, evidence-based step. Wider launch should wait for Supabase Pro, the
   lawyer's review, and a move off the linked phone.

## 10. Release record, 19 October 2026

Released at the 23:00 quiet hour (Pakistan time), following [DEPLOYMENT.md §7](DEPLOYMENT.md) except that
the dashboard waited for the owner's facts, so SQL part 2 ran before it and again after it:

- A JSON export of every table was taken first (`.local/backups/pre-prelaunch-20261019-222929`).
- SQL part 1 was applied at 23:01. All 23 changed functions matched their expected md5, the ledger lists it,
  52 old job keys were hashed and pipeline health was `ok`.
- Railway **Wait for CI** was turned on, then `7253079` was pushed to `main`. The backend `verify` and
  `deploy` jobs and the gateway check passed. Railway held the gateway until CI was green, then deployed
  it, and the linked phone reconnected.
- SQL part 2 was applied at 23:05; the ledger lists both parts.
- The owner's facts followed: Orderly is run by the owner as a sole proprietor in Islamabad (no registered
  company or postal address; the support email is the contact). The owner also chose to keep **no regular
  backups** for now, and the policy says so; a one-off copy taken before a database update is deleted
  within 30 days. The two copies on the laptop are due for deletion by 14 November
  (`pre-gateway-migration-20261015-221311`) and 18 November 2026 (`pre-prelaunch-20261019-222929`).
- The commit with those facts is pushed on its own; the dashboard is then deployed from it and SQL part 2
  is run again (Cloudflare's deployment list records when).

What changes in this report: the "Backups" and "Legal placeholders" rows of §6 and the matching items of
§7 are settled as above, except that **without backups a lost or damaged database cannot be restored**.
That is the largest remaining risk of the pilot. Nightly backups ([BACKUP-AND-RESTORE.md](BACKUP-AND-RESTORE.md))
or Supabase Pro (daily backups, 7 days) remove it. The other owner actions in §6 and the acceptance test
in §7 are still open.
