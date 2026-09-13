# Free hosting plan

Researched September 11, 2026; approved, implemented and deployed September 11–13. Target: a small hosted test of Orderly with no paid hosting subscription. The runtime is live and passed hosted order, Sheets, tenant isolation and scheduler tests. Account rollout is tracked in [SETUP-STATUS.md](SETUP-STATUS.md).

## Decision

Use Cloudflare Workers Static Assets for the React/Vite frontend, and Supabase Edge Functions for the Hono API and job workers. Keep the existing Supabase Postgres database, Auth, tenant isolation and durable job records. Use Supabase Cron (`pg_cron` with `pg_net`) for recovery. The existing bot engine and provider adapters remain the application architecture; no n8n service is needed.

| Component          | Target                                                                    | Free allowance / constraint                                                                                                            |
| ------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Website            | Cloudflare Workers Static Assets                                          | Static asset requests are free and unlimited; use its supplied subdomain initially. Build and file limits still apply.                 |
| API and workers    | Supabase Edge Functions                                                   | 500,000 included invocations per billing period across the organization; these are function calls, not customers or WhatsApp messages. |
| Database and login | Existing Supabase Free project                                            | 500 MB database, 50,000 monthly active Auth users, 1 GB separate file storage and 5 GB uncached egress.                                |
| Recovery scheduler | Supabase Cron                                                             | Execute a small database check every minute; invoke a worker only when due work exists. No separate scheduler subscription.            |
| AI in tests        | A Gemini model with available free-tier quota, or the existing local mock | Verify the actual Google project's billing tier and quota first. Do not fall back to a paid provider automatically.                    |

Sources: [Cloudflare static asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/), [Supabase invocation billing](https://supabase.com/docs/guides/platform/manage-your-usage/edge-function-invocations), [Supabase pricing](https://supabase.com/pricing), [Supabase scheduling](https://supabase.com/docs/guides/functions/schedule-functions), [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing).

## Why not Railway or the current Vercel configuration?

Railway now has a recurring Free plan: $0 subscription with $1 of resource credit per month. The initial $5 / 30-day trial is separate. Its 0.5 GB RAM and 1 vCPU figures are maximum resources a free service may use, not a full month of those resources included for free. The next plan has a $5 monthly minimum. A tiny service that sleeps may fit the recurring credit, but we have not measured Orderly's usage and should not base a dependable zero-dollar backend on that assumption. [Railway plans](https://docs.railway.com/pricing/plans), [trial transition](https://docs.railway.com/pricing/free-trial).

Vercel Hobby restricts use to personal, non-commercial projects. Its cron frequency also does not support our current every-minute schedule. Calling a Vercel endpoint from an external scheduler would address scheduling, but would not change the commercial-use restriction. Vercel remains a paid deployment option; it is not the recommended path under the new zero-subscription requirement. [Hobby restrictions](https://vercel.com/docs/plans/hobby), [cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).

Cloudflare can run Hono too, but Workers Free provides 10 ms of CPU time per invocation. Supabase Edge Functions allow 2 seconds of actual CPU per request and a 150-second worker lifetime on Free. Waiting for network I/O does not count as CPU time. Supabase is therefore the more forgiving free target for our existing SDK, validation and cryptography work. This is an assessment of published limits, not a performance benchmark. Runtime compatibility has passed the hosted pilot; production CPU usage and load still need measurement. [Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/), [Supabase limits](https://supabase.com/docs/guides/functions/limits), [Hono routing on Supabase](https://supabase.com/docs/guides/functions/routing).

## Recovery behavior

1. Verify the incoming WhatsApp webhook and save each new message as a durable database job before acknowledging receipt.
2. Dispatch the saved job immediately through an authenticated worker request. Normal replies do not wait for the minute scheduler.
3. Save order, conversation and outgoing jobs transactionally. A successful order remains saved even if Sheets is unavailable.
4. On transient failure, record the retry time and attempt count. Each minute, a short database check dispatches eligible pending or expired jobs. It does not invoke the AI when there is no work.
5. Process bounded batches and preserve existing leases, per-customer arrival order, retry limits and staff takeover rules. Permanent or exhausted failures remain visible for staff instead of retrying forever.

Calling one recovery function unconditionally every minute would use 43,200 invocations in a 30-day month, before worker and API calls. Checking for due work in Postgres first avoids those empty function invocations. It still consumes some database resources and scheduler logs; retention must be bounded. Supabase documents `pg_cron` / `pg_net` scheduling and secure tokens in Vault. [Scheduling guide](https://supabase.com/docs/guides/functions/schedule-functions).

## Implementation work before deployment

- Adapt the Hono entry point to Supabase's Deno runtime; isolate local-only filesystem persistence and dotenv loading. Verify Node compatibility, model SDKs, signing/encryption and bundle size. Supabase supports npm packages and built-in Node APIs, but that does not prove every current dependency works unchanged. [Dependency support](https://supabase.com/docs/guides/functions/dependencies).
- Replace the Vercel queue dispatch adapter with authenticated Supabase worker dispatch, retaining the existing database outbox. Persist before dispatch; use supported background task lifetime handling and cron recovery after interruption. [Background tasks](https://supabase.com/docs/guides/functions/background-tasks).
- Add a frontend API base URL and exact-origin CORS handling for the separate hosts. Keep Supabase user-token validation, company membership checks, Meta signatures and worker authentication on their respective routes. Only public configuration belongs in the frontend.
- Add an incremental scheduler migration, with its invocation secret in Vault. Do not rerun the already-applied initial migrations. Refresh catalogs on bot turns and manual sync rather than sweeping idle restaurants.
- Add static-host deployment configuration. Carry existing server secrets and the same credential encryption key to Supabase; do not copy secrets into the frontend build.
- Validate login, tenant isolation, a natural-language order, immediate worker dispatch, failed Sheets recovery, duplicate delivery and processing order. Inspect deployed runtime limits before enabling a restaurant bot.

These code changes are deployed. Vercel files and its queue dependency have been removed. Sheet catalogs refresh before bot turns and on manual sync rather than through scheduled sweeps, so no catalog jobs are needed while idle. Hosted password login, tenant isolation, order persistence, Gemini interpretation, Sheet writes/status updates, pg_net dispatch, minute recovery and expired-lease recovery have passed. Actual WhatsApp phone delivery remains pending Meta account setup. Details are in [SETUP-STATUS.md](SETUP-STATUS.md).

## What zero dollars does and does not cover

The target hosting subscription cost is $0 while usage stays within the free plans. Free Supabase projects can pause after a week of inactivity and do not include automatic backups. This is suitable for initial testing with those limitations; it is not an uptime guarantee. Scheduler activity should not be treated as a guarantee against pausing. [Supabase pricing](https://supabase.com/pricing).

AI and WhatsApp are separate services. Gemini's selected free-tier models have quotas and different data-use terms from paid service; use fictional customer data for early tests and review data handling before sending real customer information. Meta pricing depends on message category, destination and current rules. Do not promise free WhatsApp messaging indefinitely or quote old service-window pricing as a permanent guarantee. [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), [Meta pricing](https://business.whatsapp.com/products/platform-pricing).

Use the providers' supplied domains initially. Do not enable paid plans, billable fallback models or add-ons to make a test pass. If a quota is exhausted, surface it and pause affected work. Before accepting clients, reassess usage, backups and delivery reliability; preserve the portable Hono API and existing database so a later paid deployment does not require replacing the brain.
