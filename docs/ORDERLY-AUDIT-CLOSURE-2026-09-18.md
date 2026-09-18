# Orderly audit closure

Implementation deployed September 18; final verification/hand-off September 19, 2026. This updates the [September 16 audit](ORDERLY-AUDIT-2026-09-16.md). Follow the [exact launch guide](ORDERLY-LAUNCH-STEPS-2026-09-18.md) for all operator/client steps.

## Status

The prioritized software fixes are implemented. The application is ready for client configuration and a controlled pilot test. It is **not yet verified for unattended customer traffic**. The user has deferred WhatsApp onboarding until the client is present and reports their Meta account is ready. Laziza remains paused and disconnected.

| Audit finding | Implemented result | Remaining launch dependency |
|---|---|---|
| P1-01 Sandbox safety | Sandbox orders cannot dispatch WhatsApp/Sheet jobs; stale deleted conversation snapshots cannot resurrect erased records | Test real client workflow separately |
| P1-02 WhatsApp connection | Validate business/phone access and subscribe before saving; failed validation does not persist credentials | Client number verification, permissions and real delivery |
| P1-03 AI customer-data approval | Approval and readiness checks tied to configuration/credentials, exact model tests | Client provider account, billing and consent |
| P1-04 Operational readiness | Readiness panel, job/delivery visibility, in-app/browser alerts, overdue handoffs and opt-in email escalation | Configure verified mail sender; conduct live WhatsApp acceptance tests |
| P1-05 Privacy lifecycle | Public policies/contact/deletion instructions, exports, manual erasure, disconnect and opt-in scheduled retention | Agree retention with client; manage external copies and backup expiry |
| P1-06 Worker leases | 480-second leases and bounded requests; durable recovery | Monitor real plan/traffic and provider limits |
| P2-01 Routing | Public pages, business/page URLs, deep-link refresh and public 404 | Optional custom domain |
| P2-02 Responsive UI | Claude UI retained; mobile navigation/chat/layout fixes and scrollable dialogs | Physical-device/keyboard testing remains advisable |
| P2-03 Data/query scale | Bounded lists, history/archive paging, aggregate metrics, scoped polling and catalog caching | Provider/hosted load qualification at actual traffic |
| P2-04 Security/operations | Tenant checks/RLS, security headers, MFA/recovery/team controls, rate limits and administrative audit events | Operator MFA enrollment, production Auth SMTP and restore drill |
| P2-05 Models and budgets | Refreshable provider model choices, pinned selection, generation test, pricing/usage estimates, 80% warnings and shared platform-key cap | Provider price reconciliation and explicit replacement-model testing |
| P2-06 Product clarity | Bot goals/personality/flow/knowledge, drafts/publish/rollback, staff phone-confirmation gate, onboarding help, public pricing explanation and exact runbook | Restaurant-specific data and staff sign-off |

## Added in this completion pass

- Automatic retention: off by default; owner preview/confirmation, 24-hour grace after enabling/changing, active-work protection, bounded hourly batches and audited cleanup. Third-party Sheets/provider/backups are outside this deletion.
- Header staff alerts: pending live orders, unresolved WhatsApp handoffs, failed jobs and budget warnings. A staff reply resolves the handoff reminder condition. Optional generic browser notifications require permission.
- Email escalation: each verified staff account opts in for itself; membership/opt-in/work status are checked again before send. No arbitrary recipient entry. Requests use a stable idempotency key and frozen payload, with retries bounded within the mail provider's dedupe period. Acceptance is not represented as delivery.
- Platform-funded budget: administrator-only shared ceiling, initially $100/month; workspace caps still apply. Client-owned keys are accounted separately. Reservations and settlement retain funding classification. This limit is not a charge or subscription.
- Public `/pricing` explains setup, service and provider charges without publishing an unapproved fixed tariff.
- Local concurrency rehearsal and operator/client setup, privacy, failure recovery and restore instructions.

## Verification evidence

- **194 automated tests in 12 files passed**, including PostgreSQL transaction/RLS tests, retention protections, email opt-in/recipient checks/retry behavior, budget separation and authorization.
- TypeScript check, Cloudflare production build and actual bundled Deno runtime smoke passed. Dependency audit of production dependencies reported zero known vulnerabilities at check time; this is not a guarantee of no security defects.
- New migrations applied atomically in each deployment stage. **20/20 application tables have RLS enabled.** Recovery, retention and staff-alert schedules are active. No staff email subscriptions exist; retention remains disabled for every workspace.
- Live repository checks confirm Laziza has no connections and remains paused. Public pages/deep links return 200, an unknown public route returns 404, public CSP is present and anonymous bootstrap returns 401.
- The authenticated live mobile alert dialog was checked at 320px: no document-level horizontal overflow. An expired session displayed an error; refreshing restored the authenticated checks. Earlier implementation checks cover the core pages at 320px, chat at 390px, inbox at 768px and desktop.
- [Local concurrency artifact](audit-assets-2026-09-18/local-pilot-rehearsal.json): 100 fictional customers, 500 turns, 100 orders, 100 duplicate confirmations ignored, zero external requests/jobs/AI usage. This uses the in-memory repository and is **not** a hosted database, Meta or provider capacity benchmark.
- Cloudflare deployment: `36bf2967-dd9c-414f-827e-15fc4fd498b8`; client entry asset `index-TeDWqNU1.js`. Supabase function deployed from the tested edge bundle.

## Deferred by setup or client availability

1. Client Meta/number onboarding, approved outside-window template where used, real inbound/outbound delivery, handoff and full order-to-Sheet test.
2. Client menu/rules/key/billing/provider approval and published, tested bot configuration.
3. Verified email sender/Resend secrets for optional staff escalation; production Auth SMTP and actual invitation/recovery delivery checks.
4. Operator MFA enrollment, chosen paid capacity/backup plan and an isolated restore rehearsal.
5. Written privacy/retention agreement, staff coverage and final pilot sign-off.

No client messages, email alerts, paid subscriptions or domains were purchased/sent as part of this pass. The application must remain paused for an unconfigured client.

## Explicit limits

The initial restaurant pilot does not include a general-purpose GHL workflow builder, automatic multi-model task routing, native mobile push, payment processing, inventory quantities, rider tracking, media interpretation, two-way Sheet status edits or self-service subscription billing. These are future product extensions, not completed audit fixes. Model lists can refresh, but model retirement never silently changes a client's selected model. Unknown/changed pricing must be maintained; application budgets are estimates rather than provider invoices. Ambiguous external sends still require inspection before manual replay; exactly-once third-party delivery is not promised.
