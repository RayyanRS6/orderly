# Live deployment and onboarding

All account-based steps below remain to be performed. Keep the restaurant bot paused until the final delivery test passes.

## 1. Supabase

Create one Supabase project for the platform. The current project is in Sydney, and Vercel functions target `syd1` to match it. Companies are isolated within this project using `company_id`, membership checks and RLS. See `SETUP-STATUS.md` before applying migrations to an existing project.

Run these files in order in the Supabase SQL editor:

1. `supabase/migrations/202609090001_initial.sql`
2. `supabase/migrations/202609090002_order_transitions.sql`

These are initial migrations for an empty project. Do not rerun them over existing tables. All mutating RPCs require the server service-role key. Browser users have tenant-scoped reads; they cannot call the write RPCs or read the secrets table.

Create the founder’s email/password user in Supabase Authentication, then grant platform administration in SQL. Replace the placeholder with that user’s actual UUID:

```sql
insert into public.platform_admins(user_id)
values ('FOUNDER_AUTH_USER_UUID');
```

After signing into Orderly, the founder can create the first company. For each restaurant, create its owner/staff users through Supabase Auth and assign their existing user IDs:

```sql
insert into public.company_memberships(company_id, user_id, role)
values ('COMPANY_ID_FROM_SETTINGS', 'EXISTING_AUTH_USER_UUID', 'owner')
on conflict(company_id, user_id) do update set role=excluded.role;
```

Use `staff` for employees who only handle orders and conversations. Owners can manage their own menu and connections. Only the founder creates companies, raises AI allowances, or grants access to platform-owned model keys. Manage passwords and account recovery in Supabase for this pilot.

## 2. Vercel

Connect the GitHub repository when it is available. The checked-in `vercel.json` selects Vite, publishes `dist`, builds two Node API functions and configures a one-minute recovery cron. Use a Pro project for the commercial pilot. Node 24 is recommended. No deployment is triggered by local `npm run build`.

Set server environment variables from `.env.example`:

| Variable                                                | Value                                                                             |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `APP_MODE`                                              | `live`                                                                            |
| `APP_URL`                                               | Exact public origin, e.g. `https://your-domain.example`, without a trailing slash |
| `SUPABASE_URL`                                          | Project URL                                                                       |
| `SUPABASE_ANON_KEY`                                     | Public project key used for Auth                                                  |
| `SUPABASE_SERVICE_ROLE_KEY`                             | Server service-role key                                                           |
| `CREDENTIAL_ENCRYPTION_KEY`                             | Base64 encoding of 32 cryptographically random bytes                              |
| `CRON_SECRET`                                           | A long random secret; Vercel uses it as the cron bearer token                     |
| `META_GRAPH_VERSION`                                    | Supported version selected in your Meta app                                       |
| `META_APP_ID`, `META_APP_SECRET`                        | Your platform Meta app credentials                                                |
| `META_VERIFY_TOKEN`                                     | Random secret you will also enter in Meta’s webhook setup                         |
| `META_EMBEDDED_SIGNUP_CONFIG_ID`                        | Your Facebook Login for Business / Embedded Signup v4 configuration               |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` | Optional platform model keys; company-owned keys are entered in Integrations      |

Generate the encryption key in your own terminal and put the output directly into Vercel environment settings:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Keep a secure backup. Changing this key without re-encrypting stored credentials makes the existing credentials unreadable. Nothing prefixed `VITE_` should contain a secret.

Enable/verify Vercel Queues access for this project and confirm the `orderly-jobs` topic trigger is attached to `api/queue.ts`. The SDK uses Vercel OIDC credentials. Queue availability, region support and billing need confirmation in the actual account because the service is beta. [Queue setup](https://vercel.com/docs/queues/quickstart).

After deployment, check `/api/health`, sign-in, the initial company screen, and a demo order. Confirm the cron appears and runs successfully. The cron recovers saved jobs and refreshes Sheet catalogs during opening hours. Its current catalog loop is intended for a small pilot; move catalog refreshes to individual jobs before onboarding enough companies to exceed a function’s 60-second limit.

## 3. Models

In **Settings**, choose a provider and model. Default suggestions are OpenAI `gpt-5.4-mini`, Anthropic `claude-haiku-4-5`, or Gemini `gemini-2.5-flash-lite`. Use **This business’s API key** for BYOK, then save the key in **Integrations**. Alternatively the founder can enable a platform key for that company.

The key test checks provider account access; it does not establish model availability or language quality. Test a natural-language order in **Test your bot** afterward. This incurs normal provider usage if a live model is selected, even in local demo mode.

Unknown model IDs require `MODEL_PRICING_JSON`, keyed by exact model ID, with `[input USD per million tokens, output USD per million tokens]`. Update prices when providers change them. Context and model output are bounded; API calls have a 25-second deadline and no automatic SDK retries. Tool actions are validated regardless of provider.

Budget reservations are conservative. A timed-out call is charged at its reserved estimate if actual usage is unavailable. If the whole worker dies before settlement, the unresolved hold continues counting against that month’s allowance. The founder should reconcile such rows in `budget_reservations` against provider usage, rather than automatically deleting them. Pricing differences, taxes, provider credits and provider-side adjustments mean this is an application estimate, not a billing invoice.

## 4. WhatsApp

WhatsApp uses internet messages between WhatsApp accounts, not carrier SMS. The company’s Cloud API number identifies the business. Customers see bot and staff API replies in that same chat. The dashboard also keeps an inbox.

For initial testing, create a WhatsApp-enabled Meta app and use its test phone number, token and approved test recipients. Save **phone number ID**, **WABA ID** and **access token** in Integrations. A test number is separate from your personal WhatsApp number. Use a second approved recipient account for the conversation.

Configure the app webhook at:

```text
https://YOUR_DOMAIN/api/webhooks/whatsapp
```

Use the same `META_VERIFY_TOKEN` as on the server. Subscribe to the `messages` webhook field. Meta POST requests must include a valid `X-Hub-Signature-256` calculated with your app secret. Map each restaurant’s phone number ID to exactly one company.

The WABA must subscribe to your app. Embedded Signup does this automatically. For a manually connected account, invoke the authenticated `POST /api/whatsapp/subscribe` endpoint after credentials are saved, or subscribe through the corresponding Meta account setup. Initial test credentials may be temporary; use the appropriate production business/system-user access token and permissions before operating for customers.

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

Keep stable IDs when editing a menu. Non-UUID source IDs are converted into stable company-specific UUIDs. Imports replace the entire company catalog and reject invalid files without partially applying rows. Limits: 500 KB CSV, 500 products. Google Sheets must contain the same columns; use **Settings → Menu source → Connected Google Sheet** to make it authoritative. The cron refreshes during opening hours; bot turns refresh it again before modifying an order. If it cannot be read, the cart is retained and staff take over.

Orders first commit to Postgres, then synchronize in the background. Sheet downtime never erases the saved order. Writes use a company lock and look up the order ID before appending. An ambiguous append can temporarily duplicate a row; a retry reconciles duplicates without deleting unrelated rows. If synchronization fails repeatedly, correct the connection and use **Retry failed jobs**. [Google Sheets API](https://developers.google.com/workspace/sheets/api/guides/concepts).

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
