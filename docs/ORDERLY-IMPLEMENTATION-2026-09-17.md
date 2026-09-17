# Orderly implementation and launch handover

Updated 17 September 2026. This supplements the point-in-time [audit](ORDERLY-AUDIT-2026-09-16.md) and [Pakistan budget](ORDERLY-BUDGET-2026-09-16.md). The original findings describe the app before these changes.

## Deployed result

- Frontend and public website: https://orderly.waytogalaxy999.workers.dev
- Verified Cloudflare deployment: `b12769bb-e647-41c3-8296-ab678ca64681`. The live app bundle matches the final local production build.
- Backend, authentication and database: existing Supabase project `zygsuxgqkeedgcbjhfzx`.
- Laziza's bot page: https://orderly.waytogalaxy999.workers.dev/app/laziza-22d292/bot
- Laziza remains **paused**, with no WhatsApp, AI or Sheet integrations connected and no live orders. No subscription or domain was purchased.
- The `Claude-UI-Rayyan` visual changes at `21c3169` were brought into the current `feat-UI-Rayyan` working tree using a three-way content merge. Warm colors, typography, cards and the dark sidebar are preserved; accessibility and responsive fixes were added. The named source branch was not overwritten.

## What changed

| Area                | Result                                                                                                                                                                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URLs                | Workspace, page, order and inbox detail URLs; refresh and browser navigation retain context. Public unknown URLs return HTTP 404. Changing workspace URLs does not display the previous workspace while loading.                                                                       |
| Public website      | Landing, contact, privacy, terms and deletion pages; public information is rendered into HTML and can be read without JavaScript. Operator is Orderly; contact is `waytogalaxy999@gmail.com`.                                                                                          |
| Bot settings        | Separate name, personality, language, goal, instructions, approved Q&A, greeting, handoff message, question order and fulfillment controls. Drafts, publishing, saved revisions and restoring a previous published version. Publishing does not enable automation.                     |
| Models              | Key-scoped OpenAI, Gemini and Anthropic model discovery; hourly cache and explicit refresh; exact selected model displayed; generation verification; token-price and monthly budget controls. Changing provider requires fresh data-use approval in the UI.                            |
| Readiness           | Published configuration, available menu, exact model generation test, data-use approval, owned WhatsApp number and tested Sheet are required before live activation. The checklist also instructs an actual inbound-message/staff-reply test.                                          |
| Sandbox             | Runs while live automation is paused; local rules are free. Optional selected-model testing is explicitly billable and uses fictional input. Sandbox orders never send WhatsApp messages or write to Sheets.                                                                           |
| Restaurant workflow | Customer confirmation creates a pending order. When call confirmation is enabled, staff must record a confirmed call and verify a delivery address before accepting. Enforcement exists in both the API and database. Calls themselves are made by staff.                              |
| Operations          | Paginated/searchable order and conversation lists, full matching CSV export, archived message history, live/sandbox filters, aggregated totals, scoped polling, visible refresh failures, activity/error view and failed-job retries.                                                  |
| Message delivery    | Accepted/sent/delivered/read/failed receipts associated with messages; out-of-order callbacks cannot downgrade a read receipt. Accepted Meta IDs are checkpointed so bookkeeping retries do not resend an already accepted message.                                                    |
| WhatsApp connection | Validates that the selected phone belongs to the authorized WhatsApp Business account before replacing local credentials; subscription must succeed first. Local disconnect pauses automation and cancels relevant local work.                                                         |
| Privacy operations  | Owner-only customer export/deletion, paused-processing guard, job cleanup, webhook deduplication tombstones and explicit handling of external copies. There is no automatic expiry enabled; retention cleanup is a manual operational responsibility.                                  |
| Account security    | MFA enrollment and challenge, opt-in MFA enforcement in the API and database reads, password recovery, password change, global sign-out, staff invitations/access management, last-owner protection, distributed API rate limits and immutable actor-attributed administrative events. |
| Hosting security    | CSP, frame restrictions, nosniff, referrer policy, HSTS and permissions restrictions; private app pages marked noindex. API secrets remain on the backend.                                                                                                                             |
| Worker safety       | Eight-minute leases cover the documented paid Supabase runtime; database and provider calls have deadlines. Sandbox work is isolated from external delivery jobs.                                                                                                                      |
| Responsive UI       | Removed phone overflow, mobile order cards, focused mobile inbox detail/back navigation, scrollable sidebar, larger touch targets, readable input sizes, reduced-motion handling and a shorter phone tester panel.                                                                     |

## Your Laziza workflow

1. You create a separate business workspace and configure its real menu, prices, opening hours, delivery areas and Sheet.
2. In **Bot settings**, define the goal, personality, question order and approved business knowledge. Save and test the draft, then publish it.
3. Laziza supplies/authorizes its WhatsApp Business assets and its own AI account/key. Select and test the exact model. Review that provider's billing tier and customer-data terms.
4. A customer sends a **WhatsApp message**, not an SMS. Meta delivers it to Orderly's Supabase webhook. The backend verifies the signature, resolves the business number and queues the message.
5. The AI interprets natural language into validated actions. The ordering engine uses the real menu prices and requires missing name, fulfillment and delivery details. It shows the total and asks the customer to confirm.
6. Confirmation saves the pending order in Supabase and queues the connected Google Sheet update and WhatsApp reply. The WhatsApp number comes from the incoming message; the customer supplies their name and address.
7. Laziza sees the pending order in its dashboard and Sheet, calls the customer, records the outcome in Orderly, accepts and dispatches. Status changes and integration failures remain visible.

**Facebook login alone does not connect a personal WhatsApp inbox.** It authorizes eligible business assets through Meta. A business portfolio, WhatsApp Business account, eligible phone number, permissions and the appropriate Meta app setup are still required. Business-app coexistence depends on Meta eligibility. Manual onboarding is supported; self-service Embedded Signup depends on your approved Meta setup.

These are configurable restaurant ordering steps, not a general-purpose GHL visual automation builder. Instructions cannot override prices, confirmation, required fields or tenant permissions. Unsupported requests hand off to staff.

## Models and future releases

The dropdown refreshes from the provider using the configured key, so newly available candidate models can appear without editing a hardcoded dropdown. A model name appearing is not proof of supported structured output, account access or affordable pricing. Unknown prices must be configured and the exact selected model must pass generation testing before activation.

Orderly keeps the chosen model pinned. It does not silently replace a retired model or route a difficult request to an expensive model. Provider errors are surfaced and ordering hands off rather than inventing a fallback. Future model/API families may still require an SDK or integration update. Model names shown in coding products are not guaranteed to be public API model IDs.

## Hosting, domains and budget

**Supabase plus Cloudflare is enough for this deployment.** Supabase runs the backend functions, database and authentication; Cloudflare serves the frontend and public pages. Supabase Pro is a hosting-capacity/backup upgrade, not a substitute for configuration and testing. Hostinger hosting and Vercel are unnecessary here.

The dashboard is still a single-page application: it changes screens without downloading a complete HTML document each time. It now also updates real URLs. This is normal application behavior; slugs and browser history do not require separate hosting.

The existing Workers address remains in use. Workers' normal hostname is `<worker>.<account-subdomain>.workers.dev`; renaming the worker cannot produce the bare `orderly.workers.dev`. A purchased `.com` can later be connected to the same Cloudflare frontend. No availability claim is made for `orderly.vercel.app` or any `.com`.

Planning example from the researched [budget](ORDERLY-BUDGET-2026-09-16.md), using **PKR 280/USD**, excluding tax, exchange fees, overages and your labour:

| Who pays                                                        |                      Planning amount |
| --------------------------------------------------------------- | -----------------------------------: |
| You: Supabase Pro + Cloudflare static hosting + $20/year domain | About **PKR 7,467/month equivalent** |
| Client: proposed Orderly setup fee                              |                  **PKR 20,000 once** |
| Client: proposed Orderly service fee                            |                 **PKR 12,000/month** |
| Client: illustrative OpenAI usage for 1,000 conversations       |            About **PKR 5,775/month** |
| Client: 200 chargeable Pakistan utility messages                |              About **PKR 560/month** |
| Client: combined recurring example                              |           About **PKR 18,335/month** |

The AI assumption is five calls per conversation, 4,000 input and 250 output tokens per call, at the budget report's Mini rates. Actual bills depend on model and usage. Normal WhatsApp service replies inside the customer-service window can have zero Meta message charges; late utility templates and marketing have different rates. The report includes formulas, alternatives, source links and the [interactive calculator](orderly-cost-calculator.html).

Infrastructure is shared across your clients. The first client's service fee would leave only about PKR 4,533 after this shared hosting baseline, before your time and other expenses. Set support limits and price onboarding separately.

## Verification completed

- **178 automated tests across 11 files passed**, including PostgreSQL migration/transaction tests, cross-business isolation, MFA reads, archival history, phone confirmation, sandbox isolation, model discovery, credential-change approval and receipt retry handling.
- TypeScript production build passed. The actual Supabase bundle started in Deno, answered health checks and rejected anonymous access.
- Dependency audit returned **zero known vulnerabilities** at the time checked; this is not a proof that the application has no vulnerabilities.
- Both launch migrations applied atomically to the existing Supabase project. All **17 application tables have row-level security enabled**. Existing replaced function definitions were saved in ignored local deployment records.
- Live repository reads verified summaries, pagination and integration state. The scheduler reports configured credentials and scheduled recovery.
- Live HTTP checks: landing/contact/legal pages and dashboard deep links return 200; an unknown public route returns 404; public pages carry CSP; backend health reports live mode; anonymous bootstrap returns 401.
- The existing authenticated browser session loaded Laziza's live bot settings and readiness checks successfully.
- Browser checks covered 320px layouts for orders, inbox, settings, security, integrations, catalog and landing; 390px chat layouts; 768px inbox; and desktop layout. Sampled pages had no document-level horizontal overflow. In the local 390×844 tester, the input was within the viewport after the final adjustment.
- The local browser ordering exercise created a fictional pending order, rejected acceptance before a recorded call, then accepted it after a fictional call outcome. No real message or invitation was sent.

Desktop viewport emulation does not prove every physical phone, on-screen keyboard, assistive technology or network condition. Live Meta sends, client-paid AI billing, password-recovery email delivery, MFA enrollment and a real Laziza Sheet round trip were not performed during this implementation pass.

## Before accepting real customers

1. **Resolve the Meta account/setup prerequisites.** The earlier setup record reports a Facebook business-portfolio restriction; this code deployment cannot remove Meta's restriction or grant app approval. Complete the business/number onboarding with authorized accounts.
2. Configure Laziza's actual menu, delivery rules, Sheet, API key and data-use approval. Publish the bot and pass the exact model test. Leave it paused until these are complete.
3. With your own test WhatsApp number, demonstrate one real order, a delivered reply, a Sheet row, a staff takeover, the confirmation call, dispatch and a retry/recovery case. Do not infer readiness from credential checks alone.
4. Choose appropriate Supabase capacity and backup retention, configure production Auth email delivery, enable operator MFA, and run a restore drill. Paid subscriptions were not purchased here.
5. Assign a staff member to watch the inbox during ordering hours. There is no outbound email/push escalation service configured. The in-app handoff and failure views require an operator to monitor them.
6. Set a written customer-data retention schedule and perform authorized cleanup. Export/deletion affects the active Orderly database; separately handle Sheet copies, WhatsApp, AI providers, downloads and backup expiry. Local disconnect does not revoke a shared provider token for other apps; revoke access in the provider when appropriate.

An external send can remain ambiguous if a process dies after Meta accepts it but before the provider ID is durably saved. Check the provider/inbox before manually replaying uncertain sends; the implementation does not claim exactly-once external delivery. Published model prices and usage estimates are not provider invoices. Automatic retention, external staff alerts, a general-purpose flow builder and multi-model task routing remain separate product extensions.

## Deployment maintenance

Use `npm run build:cloudflare` with `VITE_API_BASE_URL` set to the Supabase function base, then `wrangler deploy`. The hosted build generates the public HTML, headers and app-route rewrites. Do not deploy a plain Vite build with the production 404 routing configuration.

Use `npm run build:edge` before deploying the Supabase function. Apply SQL migrations before code that uses their RPCs. Earlier migrations were applied through the SQL editor/management API and do not have complete Supabase CLI migration-history records; reconcile that history before a future blanket `supabase db push`. Keep `.env`, `.local` and service-role/provider credentials out of source control.
