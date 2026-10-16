# Live deployment and onboarding

Orderly uses Cloudflare Workers Static Assets for the dashboard and Supabase Edge Functions for its Hono API and job workers. Supabase Postgres stores companies, orders, encrypted credentials and durable jobs; Supabase Cron recovers unfinished work. No Vercel, Railway or n8n subscription is required. Check [account setup status](SETUP-STATUS.md) for completed cloud steps, and keep the restaurant bot paused until the final delivery test passes.

## 1. Supabase

Create one Supabase project for the platform. The existing Orderly project is in Sydney. Companies are isolated within it using `company_id`, membership checks and RLS. See `SETUP-STATUS.md` before applying migrations to an existing project.

For a new installation, apply every file in `supabase/migrations` in filename order. The existing Orderly project already has migrations through `202610180001_spam_protection.sql` (applied by hand in the SQL editor). Earlier SQL-editor/management-API execution did not populate complete CLI migration history; reconcile it before using `supabase db push`, and do not reapply existing migrations blindly. All application tables use RLS; mutation RPCs and secrets are server-only.

Use the [exact launch guide](ORDERLY-LAUNCH-STEPS-2026-09-18.md) for current client setup and the [audit closure](ORDERLY-AUDIT-CLOSURE-2026-09-18.md) for verified status.

Create the founder’s email/password user in Supabase Authentication, then grant platform administration in SQL. Replace the placeholder with that user’s actual UUID:

```sql
insert into public.platform_admins(user_id)
values ('FOUNDER_AUTH_USER_UUID');
```

After signing into Orderly, the founder can create the first company. The founder then manages every restaurant’s owners and staff on the **People** page, which only platform admins see: add someone by email (an existing account is added straight away, anyone else gets an invitation), change a role, remove someone from a business, or delete an account. Deleting an account is permanent and needs the founder’s authenticator protection, which is set up in **Security & privacy**. Every business keeps at least one owner, so add the new owner before removing the old one. Owners can also add people by email in their own **Security & privacy** page. Platform admins are still granted only in SQL, as above.

As an emergency fallback only, when the People page can’t be used, an existing Auth user can be assigned by ID:

```sql
insert into public.company_memberships(company_id, user_id, role)
values ('COMPANY_ID_FROM_SETTINGS', 'EXISTING_AUTH_USER_UUID', 'owner')
on conflict(company_id, user_id) do update set role=excluded.role;
```

Use `staff` for employees who only handle orders and conversations. Owners can manage their own menu and connections. Only the founder creates companies. There are no Orderly-owned model keys: each business connects and pays for its own. Use Orderly’s Security page for MFA, and its password-recovery flow. Configure production Auth SMTP before client invitations.

## 2. Supabase backend and Cloudflare frontend

Use Node 24 and `npm ci`. `npm run build:edge` bundles the server into the ignored `supabase/functions/orderly/index.js`, without embedding environment variables. `npm run test:edge-runtime` starts that actual bundle in Deno with fictional credentials. The deployment below uses server-side bundling and does not require Docker.

Save server environment variables in an ignored file, such as `.local/supabase.env`. Supabase automatically provides `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` inside hosted functions; omit those reserved names when uploading function secrets. They may remain in the local file used by the scheduler-configuration helper.

| Variable                                                | Value                                                                             |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `APP_MODE`                                              | `live`                                                                            |
| `APP_URL`                                               | Exact public origin, e.g. `https://your-domain.example`, without a trailing slash |
| `SUPABASE_URL`                                          | Project URL                                                                       |
| `SUPABASE_ANON_KEY`                                     | Public project key used for Auth                                                  |
| `SUPABASE_SERVICE_ROLE_KEY`                             | Server service-role key                                                           |
| `CREDENTIAL_ENCRYPTION_KEY`                             | Base64 encoding of 32 cryptographically random bytes                              |
| `CRON_SECRET`                                           | A long random secret shared by the worker and Supabase Vault                      |
| `META_GRAPH_VERSION`                                    | Supported version selected in your Meta app                                       |
| `META_APP_ID`, `META_APP_SECRET`                        | Your platform Meta app credentials                                                |
| `META_VERIFY_TOKEN`                                     | Random secret you will also enter in Meta’s webhook setup                         |
| `META_EMBEDDED_SIGNUP_CONFIG_ID`                        | Your Facebook Login for Business / Embedded Signup v4 configuration               |
| `PROMPT_CACHE` (optional)                               | `off` stops reusing the AI instructions from Anthropic's cache (see §3)           |
| `MENU_LINK_SECRET` (optional)                           | Base64 of 32+ random bytes; otherwise derived from the encryption key (see §6)    |

Reuse the existing encryption key when migrating. Generate one only for a new installation:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Keep a secure backup. Changing this key without re-encrypting stored credentials makes the existing credentials unreadable. Nothing prefixed `VITE_` should contain a secret.

Deploy the backend after uploading the non-reserved variables through Supabase Secrets or `supabase secrets set --env-file <filtered-ignored-file> --project-ref <project-ref>`:

```powershell
npx supabase login
npm run build:edge
npx supabase functions deploy orderly --project-ref zygsuxgqkeedgcbjhfzx --use-api
```

`supabase/config.toml` disables only gateway JWT verification, since Meta cannot send a Supabase JWT. The API still verifies user tokens and company membership, Meta webhook signatures, and the private worker bearer token on their respective routes. Never replace these checks with a public worker endpoint.

Build and deploy the frontend separately, and only after the backend for the same commit is live (the **Deploy Supabase backend** run is green): a newer dashboard calls routes an older backend does not have. Roll back in the reverse order, frontend first.

```powershell
$env:VITE_API_BASE_URL = 'https://zygsuxgqkeedgcbjhfzx.supabase.co/functions/v1/orderly'
npm run build:cloudflare
npx wrangler login
npx wrangler deploy
```

Alternatively upload the contents of `dist` through Cloudflare's static-site upload flow. `wrangler.jsonc` defines a static-only app with SPA routing. Set the backend's `APP_URL` to the resulting exact HTTPS frontend origin, without a trailing slash. Add that frontend origin to Supabase Auth's site/redirect configuration. Public preview origins are not automatically allowed. Do not put a service-role or provider key in `VITE_*` variables.

After the new SQL migration and backend are deployed, configure Vault using the existing server environment file:

```powershell
node scripts/configure-scheduler.mjs .local/supabase.env
```

The helper sends the worker URL and `CRON_SECRET` to a service-role-only RPC and prints readiness flags, never keys. The scheduler checks due jobs in Postgres every minute and dispatches at most 20; idle checks invoke no Edge Functions. Incoming messages dispatch immediately, and completion notifies the next message from the same customer. Sheet catalogs use a 60-second cache on bot turns and refresh on the owner’s sync action, avoiding idle sweeps of every restaurant.

Inspect `/functions/v1/orderly/api/health`, sign-in, first-company creation and a demo order after deployment. Confirm worker requests return 202, jobs finish, a temporary integration failure retries, and a stale fifth attempt is held for staff. Job and conversation leases are 480 seconds, covering the supported paid-worker lifetime with headroom. These are bounded workers, not continuously running servers. [Supabase deployment](https://supabase.com/docs/guides/functions/deploy), [runtime limits](https://supabase.com/docs/guides/functions/limits).

## 3. Models

In **Settings**, choose a provider and model. Default suggestions are OpenAI `gpt-5.4-mini`, Anthropic `claude-haiku-5-5` (recommended: fast and low-cost for chat), or Gemini `gemini-3.5-flash-lite`. Paste the business’s own API key on the same card and click **Connect and test**; Orderly never supplies a key. The card reports whether the key is saved and tested.

The key test checks provider account access; it does not establish model availability or language quality. Test a natural-language order in **Test your bot** afterward. This incurs normal provider usage if a live model is selected, even in local demo mode.

Unknown model IDs require `MODEL_PRICING_JSON`, keyed by exact model ID, with `[input USD per million tokens, output USD per million tokens]`. Update prices when providers change them. Context and model output are bounded; API calls have a 25-second deadline and no automatic SDK retries. Tool actions are validated regardless of provider.

Budget reservations are conservative and use paid token rates even when the provider grants free usage. A $0 application allowance blocks model calls, including free-tier calls. Gemini 3.5 Flash-Lite uses a fallback estimate of $0.30 per million input tokens and $2.50 per million output tokens; verify project eligibility for free usage separately. [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing). A timed-out call is charged at its reserved estimate if actual usage is unavailable. A call the provider refused before answering (for example HTTP 429 or 529) is recorded at $0, and a reply in the wrong shape is charged at the usage the provider reported. If the whole worker dies before settlement, the unresolved hold continues counting against that month’s allowance. The founder should reconcile such rows in `budget_reservations` against provider usage, rather than automatically deleting them. Pricing differences, taxes, provider credits and provider-side adjustments mean this is an application estimate, not a billing invoice.

Anthropic replies reuse the fixed instructions (safety rules, reply format and bot settings) from Anthropic’s 5-minute prompt cache. The words sent are unchanged; only a cache marker is added. Orderly records the reused and newly cached tokens on each usage row and prices them at 0.1× and 1.25× of the input rate for the listed Claude Haiku models; other Claude models, and businesses with prices typed in Bot settings, count reused tokens at full price. OpenAI and Gemini pricing is unchanged. In an emergency, set the Edge Function secret `PROMPT_CACHE=off` (Supabase dashboard → Edge Functions → Secrets) to send the plain instructions again; if running workers do not pick it up, revert the commit and redeploy. The Batch API is not used, because WhatsApp replies must arrive within seconds.

Spam protection sits on top of the monthly allowance. Bot settings set the AI replies per clock hour for the whole restaurant (default 300) and per customer per hour (default 30); only live WhatsApp chats count, never Test your bot. A chat that reaches any limit gets one short notice an hour, waits under **Needs staff**, and goes back to the bot on the customer’s next message once the limit resets or is raised, unless staff wrote in the meantime. Reached monthly and hourly limits appear in the bell and in opt-in email alerts. Staff can block a number from its chat; its messages are then dropped before they are saved, on both the Meta and linked-phone routes.

## 4. WhatsApp

WhatsApp uses internet messages between WhatsApp accounts, not carrier SMS. The company’s Cloud API number identifies the business. Customers see bot and staff API replies in that same chat. The dashboard also keeps an inbox.

For initial testing, create a WhatsApp-enabled Meta app and use its test phone number, token and approved test recipients. Save **phone number ID**, **WABA ID** and **access token** in Integrations. A test number is separate from your personal WhatsApp number. Use a second approved recipient account for the conversation.

Configure the app webhook at:

```text
https://YOUR_PROJECT_REF.supabase.co/functions/v1/orderly/api/webhooks/whatsapp
```

Use the same `META_VERIFY_TOKEN` as on the server. Subscribe to the `messages` webhook field. Meta POST requests must include a valid `X-Hub-Signature-256` calculated with your app secret. Map each restaurant’s phone number ID to exactly one company.

The WABA must subscribe to your app. Embedded Signup does this automatically. Manual credential saves also validate ownership and subscribe the WABA before persistence. Failed validation does not save a connection. Initial test credentials may be temporary; use the appropriate production business/system-user access token and permissions before operating for customers.

### Client onboarding

Build a v4 Embedded Signup configuration in your Meta app. Add the app domain and appropriate Facebook Login settings for your deployed origin. Complete the Meta verification, permissions, App Review and Tech Provider requirements applicable to onboarding other businesses. The code cannot obtain or approve these on your behalf. [Official implementation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation).

The **Continue with Facebook** button collects the signup code and account/phone IDs. The server exchanges the code, checks that the token can access the selected WABA and phone, encrypts the token, and subscribes the WABA. For a standard new Cloud API number, supply the optional six-digit registration PIN in the UI, or register it through authenticated `POST /api/whatsapp/register` with `{ "pin": "YOUR_6_DIGIT_PIN" }`. Keep the PIN securely; Orderly does not store it.

For an existing **WhatsApp Business app** number, select **Keep using the WhatsApp Business mobile app**. This requests Meta’s coexistence onboarding. Eligibility is determined by Meta; standard Cloud API registration alone does not keep the mobile app working. Do not register a coexistence number again through the standard registration endpoint. [Business App onboarding](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users).

Subscribe to `smb_message_echoes` for coexistence. New mobile staff messages pause that conversation’s bot and appear as staff messages in the dashboard. The implementation records edit/delete notices and media placeholders. It does not backfill `history` or synchronize contacts from `smb_app_state_sync` yet. [Official echo payload](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes).

### Reply window and templates

Normal replies are sent only inside the customer’s 24-hour service window. Outside it, order updates require an approved template. Set the template name and language, then use **Submit status template** to request approval for the two-body-parameter order status template. Submission does not imply approval. Check WhatsApp Manager, then test it with a permitted recipient. [Meta messaging](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages).

An incoming message delayed over ten minutes is handed to staff rather than automatically placing an old order. Unsupported customer media also goes to staff. Check the live inbox and activity after connection; verifying a token alone does not verify inbound and outbound delivery.

Incoming work follows database arrival order for each company/customer. A retrying or failed message blocks later messages in that stream, so a confirmation cannot overtake a previously received cart edit. Other customers continue processing. Fix failed connections and use **Retry failed jobs** to recover blocked streams. The one-minute recovery cron picks up work whose earlier queue callback arrived before its predecessor finished. Automatic replies already queued are suppressed when the company pauses its bot or staff take over.

## 5. Google Sheets

Create a Google Cloud project, enable the Google Sheets API, and create a service account with a key. Share the restaurant’s specific spreadsheet with that service account email as **Editor**. In Orderly, enter the spreadsheet ID, service account email, PEM private key and tab names. The ID is the value between `/d/` and `/edit` in its URL.

Use separate `Menu` and `Orders` tabs. The orders tab must be empty or begin with the app’s `Order ID` header. The writer stores thirteen columns and uses `RAW` values to avoid interpreting customer content as spreadsheet formulas. Do not edit the ID column or sort only part of the range; sort entire rows if needed. Keep one writer per orders tab. Different businesses should use different spreadsheets.

Orderly rejects an orders tab already assigned to another company, including the default `Orders` tab and differences only in letter case. Separate tabs are supported, but separate spreadsheets provide clearer sharing permissions for different businesses.

For the menu, use these columns in this exact order:

```text
id,name,description,category,price,available,emoji,aliases,variants,modifiers
```

Use the supplied [`public/examples/menu.csv`](../public/examples/menu.csv). Prices in imports are **rupees**; internal prices are integer paisa. Variant prices are the full replacement item price. Extras add to the selected item price. Aliases use `|`; variants/modifiers use JSON arrays with `id`, `name`, and `price`.

Keep stable IDs when editing a menu. Non-UUID source IDs are converted into stable company-specific UUIDs. Imports replace the entire company catalog and reject invalid files without partially applying rows. Limits: 500 KB CSV, 500 products. Google Sheets must contain the same columns; use **Settings → Menu source → Connected Google Sheet** to make it authoritative. Bot turns refresh the menu before modifying an order; owners can also sync it manually. If it cannot be read, the cart is retained and staff take over.

Orders first commit to Postgres, then synchronize in the background. Sheet downtime never erases the saved order. Writes use a company lock and look up the order ID before appending. An ambiguous append can temporarily duplicate a row; a retry reconciles duplicates without deleting unrelated rows. If synchronization fails repeatedly, correct the connection and use **Retry failed jobs**. [Google Sheets API](https://developers.google.com/workspace/sheets/api/guides/concepts).

## 6. Menu page

Each business can switch on a public menu page at `/m/<slug>` (**Your menu → Menu page**). The slug is copied from the business once and never changes, so printed QR codes keep working after a rename. The bot adds the link to menu replies, and owners can write `{menu_link}` in the greeting, handoff message, knowledge answers or rule responses; while the page is off only the placeholder (and a separator such as `:` before it) is left out. A reply sent to a customer carries their own one-tap link (`#t=…`, signed for that send, valid for 2 hours and one order); the stored message, the inbox and the AI only ever see the public link. Customers from Instagram or a QR code type their WhatsApp number and get an order code (`OM-XXXX-XXXX`, 30 minutes); the order is placed only when they send that code from their own WhatsApp, without any AI call. Every menu-page order is pending, with a **Menu page** badge in Orders.

Photos are optional `https://` links: the menu editor's **Photo link** field, or an `image` (also `image_url` or `photo`) column in a CSV import or after column J in the menu Sheet. A bad link is skipped, never failing a sync. Photos are never sent to the AI.

Apply the SQL by hand in the Supabase SQL editor, in order, **before** pushing the backend that uses it:

1. `202610190001_menu_page.sql` (the link table and `set_menu_link`).
2. `202610190002_menu_ordering.sql` (`menu_link_uses`, `menu_drafts`, `create_menu_draft`, `place_web_order`, `purge_menu_ordering`).
3. `202610190003_menu_purge_schedule.sql` (pg_cron: purges expired drafts every 10 minutes).

All three are additive and safe to rerun; existing functions and triggers are unchanged. Until they are applied the backend treats every menu page as off (one warning in the function logs) and the owner's switch asks for the migration. Check afterwards that `has_function_privilege('anon','public.place_web_order(text,jsonb,integer,jsonb,jsonb,jsonb)','execute')` is false and that `select jobname from cron.job where jobname='orderly-menu-purge'` returns one row.

No new secret is required: the link, order-code and rate-limit keys are derived from `CREDENTIAL_ENCRYPTION_KEY`. An optional `MENU_LINK_SECRET` (base64 of at least 32 random bytes, set in Supabase → Edge Functions → Secrets) overrides that base; changing either ends personal links sent in the last 2 hours and codes from the last 30 minutes. The frontend build writes `dist/menu.html`, the `/m/* /menu 200` rewrite and `noindex` headers for `/m/*`; after the first frontend deploy, open a menu link to confirm the rewrite works.

To roll back, first turn the menu page off for each business and remove every `{menu_link}` placeholder (greeting, handoff message, knowledge answers and rule responses, then publish the bot settings), because older code would send it literally. This must return no rows before you continue:

```sql
select id, data->>'name' from public.companies where data::text like '%{menu_link}%';
```

Then `npx wrangler rollback` the frontend, and only after that revert and push the backend. The tables can stay. Only if you want the objects gone (the same statements are kept in `.local/backups/rollback-menu-page.sql`; run the `cron.unschedule` line on its own, since it errors when the job is absent):

```sql
select cron.unschedule('orderly-menu-purge');
drop function if exists public.purge_menu_ordering(), public.place_web_order(text,jsonb,integer,jsonb,jsonb,jsonb),
  public.create_menu_draft(jsonb,integer,integer), public.set_menu_link(text,boolean,text);
drop table if exists public.menu_link_uses, public.menu_drafts, public.menu_links;
```

## Activation test before a restaurant pilot

Use a dedicated test company, recipient and Sheet. Verify:

- A real inbound WhatsApp message reaches the correct company and produces a reply from its number.
- Each configured model understands pickup, delivery, Urdu/Roman Urdu, variants, edits and explicit confirmation.
- A price or availability change after review prevents stale confirmation.
- Repeated delivery of a webhook creates one order; staff accept/reject and receive consistent status updates.
- The Sheet receives one order and later status updates. Disconnect access, confirm the order survives in Postgres, then restore access and retry.
- Staff takeover stops queued bot replies. If using coexistence, a mobile staff reply also pauses automation.
- Outside-window template delivery works after Meta approval.
- An owner/staff session cannot access another company or expose secrets, including through direct API calls.
- Budget exhaustion produces staff handoff, scheduled recovery runs, and backups can be restored.

Then enable automatic replies for the pilot restaurant. Agree on data retention, customer-facing bot/privacy wording and which staff monitor handoffs before accepting real customer traffic.
