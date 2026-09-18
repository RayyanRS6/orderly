# Orderly: exact launch and client onboarding steps

Updated September 18, 2026. Operator: **Orderly**. Support/privacy: **waytogalaxy999@gmail.com**.

You reported that your Meta account is ready for onboarding. This is not independently verified. You will connect the client later, while they are present. **Laziza remains paused and disconnected.** Software tests do not replace the live checks below.

## 1. Understand the connections

```text
Customer's WhatsApp → Meta Cloud API → Orderly API on Supabase
                                      ├─ client's selected AI model
                                      ├─ Supabase orders and inbox
                                      └─ client's Google Sheet
Restaurant staff → Orderly dashboard on Cloudflare → confirmation/status updates
```

Cloudflare hosts the website. Supabase hosts the API, database, authentication and scheduled jobs. You do not need Hostinger or Vercel for this setup. Buying Supabase Pro does not configure client integrations, approve Meta permissions or purchase AI usage.

- Website: <https://orderly.waytogalaxy999.workers.dev>
- Public pages: `/pricing`, `/privacy`, `/terms`, `/contact`, `/data-deletion`.
- Dashboard: `/app`; each workspace has its own `/app/<business-slug>/<page>` URL. React changes the visible page without downloading the entire site again; direct links and refreshes are supported.
- API: `https://zygsuxgqkeedgcbjhfzx.supabase.co/functions/v1/orderly`.

Facebook sign-in grants access to business assets during onboarding. It does **not** automatically connect any personal WhatsApp account or enable carrier SMS. The client must select/verify a supported WhatsApp business number, grant permissions and complete Meta's requirements.

## 2. Prepare your operator account

1. Sign in with your own Orderly founder account. Never share this password with clients.
2. Open a workspace's **Security** page. Set up authenticator MFA, complete the verification challenge and store recovery information securely.
3. Confirm sign-out/sign-in and recovery work before inviting clients.
4. Configure production authentication email: Supabase dashboard → **Authentication → Email/SMTP settings** → enable custom SMTP → enter your mail provider's host, port, username, password and verified sender → save. Dashboard wording may vary.
5. Send a recovery/invitation test to an address you control and verify arrival and return to the correct Orderly URL. Do not invite a client until this passes.

Supabase's default email service is restricted and is unsuitable for normal production invitations. Custom SMTP is separate from Orderly's staff-alert API configuration. See [Supabase SMTP](https://supabase.com/docs/guides/auth/auth-smtp).

## 3. Optional domain and mail sender

The current `workers.dev` address can run the app. A domain improves branding and lets you verify a mail sender. `orderly.workers.dev` and `orderly.vercel.app` are not guaranteed available names; moving hosts does not reserve either.

1. Buy an available domain through a registrar of your choice; keep renewal and account access under your control.
2. Add it to your Cloudflare account and complete the DNS/nameserver setup shown there.
3. Cloudflare → **Workers & Pages → orderly → Settings → Domains & Routes → Add → Custom domain**. Choose your hostname and wait for HTTPS activation. Inspect existing DNS before replacing anything. See [Cloudflare custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).
4. Set the Supabase Edge Function secret `APP_URL` to that exact HTTPS origin, without a trailing slash. Update Supabase Auth Site URL and allowed redirect URLs, and the Meta app's allowed domains/login URLs.
5. Rebuild/deploy the frontend if any public origin/configuration changes. Keep `VITE_API_BASE_URL` pointing to the existing Supabase function. Never put private keys in `VITE_*` settings.
6. Test login, password recovery, deep links, public policies and Facebook onboarding on the new hostname before advertising it.

### Optional staff email alerts

1. Create a Resend account, add your sending domain and publish the exact DNS records Resend provides. Wait until verified; do not use an unverified Gmail address as the sender. Your public support address can remain Gmail.
2. Create a sending API key. Supabase → **Edge Functions → Secrets**: set `RESEND_API_KEY` and `ALERT_FROM_EMAIL` (for example, `Orderly <alerts@your-domain.com>`). Keep both server-side.
3. In Orderly, sign in with a verified account email, open the header **Staff alerts** bell and enable your own email alerts. Choose the delay (5–120 minutes). Each staff member opts in separately.
4. Test a controlled unresolved task and confirm receipt. Inspect the Activity/job outcome if it fails; an `email.accepted` event means provider acceptance, not inbox delivery.
5. To stop alerts, disable them in the same dialog. Removing workspace membership also prevents future delivery.

The scheduler checks subscriptions every five minutes, queues at most one reminder per hour per subscribed user/business while work remains, and uses the existing job worker. Alerts contain a sign-in link and no customer/order details. Browser notifications are optional and require that browser's permission. Until mail credentials are configured, email opt-in remains unavailable. [Resend domains](https://resend.com/docs/dashboard/domains/introduction), [idempotent sending](https://resend.com/docs/dashboard/emails/idempotency-keys).

## 4. Create the client's workspace and access

1. From **Businesses**, create/select **Laziza Foods**. Keep **Bot enabled** off.
2. In business settings enter the real name, contact details, pickup address, hours, currency and delivery areas/fees.
3. Open **Security/team** and invite the client's owner using their own email. Invite employees as staff. Confirm each invitation is received and accepted.
4. Check that the client sees only their workspace. Keep founder/platform-admin access for yourself.
5. Agree who monitors the inbox, calls customers, confirms orders, dispatches food and responds to failed jobs.

## 5. Add the real menu

1. Choose an authoritative menu source: Orderly's catalog or the connected Google Sheet.
2. Add real products, prices, aliases, availability, variants and extras. Set stable IDs; do not recycle an old ID for a different product.
3. For CSV/Sheet imports use `public/examples/menu.csv` and this exact header order:

   ```text
   id,name,description,category,price,available,emoji,aliases,variants,modifiers
   ```

4. Prices are rupees in imports; variants contain full replacement prices and modifiers add to the item price. Aliases use `|`; variants/modifiers use JSON arrays. Imports replace the entire catalog, so review the file first.
5. Test chicken pulao, cold drink and zarda only if those exact products exist and are available. Test a missing/out-of-stock item and an ambiguous request too.

## 6. Connect the client's Google Sheet

1. Google Cloud console → select/create a project → enable **Google Sheets API**.
2. **IAM & Admin → Service Accounts** → create/select a service account → create its JSON key. Store it privately, never in Git or a shared chat.
3. Create a separate spreadsheet for this restaurant. Add `Menu` and `Orders` tabs. Leave `Orders` empty for the application to initialize.
4. Share only this spreadsheet with the service account email as **Editor**.
5. In Orderly **Integrations → Google Sheets**, enter the spreadsheet ID (between `/d/` and `/edit` in its URL), service account email, PEM private key and exact tab names. Save and test.
6. If using Sheet menus, populate the header above, select **Connected Google Sheet** as the menu source and sync it. Bot turns use a short catalog cache; use manual sync for an immediate change.
7. During the live test, confirm one order row appears and that Orderly status changes update that same row.

Supabase is the order record of truth. Sheets is a synchronized view: **editing an order status in the spreadsheet does not update Orderly**. Staff must confirm/dispatch orders in Orderly. Do not edit Order IDs or sort only part of the columns. Failed Sheet writes can be retried without losing the database order.

## 7. Connect the client's AI key and choose the model

1. The client creates an API account with their chosen provider, enables billing/credit and sets provider-side usage limits. A consumer ChatGPT subscription is not an API balance.
2. In **Integrations**, save their OpenAI, Gemini or Anthropic API key and test access.
3. Open **Bot settings**. Select the provider and **This business's API key**. Refresh the model list and select the exact model ID.
4. Review the provider's data-processing terms with the client and record the required approval in the app. Set the monthly application allowance. Unknown model prices must be supplied before use.
5. Save the draft, inspect its instructions and run the selected-model test. Live model tests incur provider usage; the free simulator does not establish real model quality.
6. Publish the reviewed configuration. Changing credentials/model resets the relevant approval/readiness checks; repeat them before re-enabling the bot.

Model discovery can refresh available choices. It does **not** silently replace a retired model or prove that every listed model supports Orderly. Choose and test a replacement explicitly. Model names in the Codex app are not promises of public API availability. Application prices and token budgets are estimates; the provider invoice is authoritative. At 80% usage the staff bell warns; configured email alerts can escalate it. The founder's Businesses page also controls a shared cap for platform-funded keys, initially $100/month. This is a safety ceiling, not a charge. Client-funded keys have their own workspace allowance.

## 8. Configure Laziza's bot

1. **Bot settings** → edit goal, personality, workflow and additional information.
2. Suggested goal: “Help customers order from Laziza's current menu. Collect the customer's name, WhatsApp contact, items, quantities, pickup/delivery choice and delivery address. Show the priced summary and require explicit confirmation before saving. Explain that staff will call to confirm before dispatch.”
3. Specify language/tone, opening hours, delivery limits and escalation rules. Keep instructions consistent with the actual menu and fees.
4. Keep staff phone confirmation required. The bot should not promise dispatch before staff confirm.
5. Run sandbox cases for English, Urdu/Roman Urdu, item changes, cancellation, missing address, unavailable products and requests for a human. Inspect the activity/actions and draft prompt.
6. Publish only after review. Use rollback to restore a known published configuration if needed.

This is a configurable restaurant-ordering assistant. Arbitrary GHL-style workflow nodes, payment processing, rider tracking and interpreting customer audio/images are separate extensions. Unsupported media goes to staff.

## 9. Prepare Meta before meeting the client

1. In your Meta developer app, configure WhatsApp and Facebook Login for Business/Embedded Signup. Complete the business verification, app mode, permission access, App Review and Tech Provider requirements shown for onboarding other businesses. Account access alone does not prove these are approved.
2. Configure the Embedded Signup v4 configuration and allowed Orderly origin.
3. Supply these server secrets in Supabase: `META_APP_ID`, `META_APP_SECRET`, `META_EMBEDDED_SIGNUP_CONFIG_ID`, `META_GRAPH_VERSION` and `META_VERIFY_TOKEN`. Use the supported Graph version selected for the app.
4. Set the webhook callback to:

   ```text
   https://zygsuxgqkeedgcbjhfzx.supabase.co/functions/v1/orderly/api/webhooks/whatsapp
   ```

5. Enter the same verification token and subscribe to `messages`. For Business-app coexistence also subscribe to `smb_message_echoes`.
6. Set policy URLs to the deployed `/privacy`, `/terms` and `/data-deletion` pages as appropriate. Confirm each opens without login.
7. If using outside-window order updates, submit the supported order-status template from Orderly and wait for Meta approval. Submission is not approval.

Reference: [Meta Embedded Signup](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation). Meta's screens and account requirements can change; follow any additional checks shown in the account.

## 10. Connect WhatsApp with the client present

Have the client's business administrator, their Facebook login, the business number/phone and access to verification messages/calls ready. The client enters their own password and verification codes.

1. Open the correct Orderly workspace → **Integrations → WhatsApp**. Confirm its bot is still paused.
2. If the client intends to keep using the WhatsApp Business mobile app, select **Keep using the WhatsApp Business mobile app**. Meta determines coexistence eligibility. Do not assume ordinary Cloud API registration preserves the mobile app.
3. Click **Continue with Facebook**. Have the client authenticate, grant the required business access, select/create the correct business portfolio and WhatsApp Business Account, and select/verify their number as prompted.
4. Complete billing/payment and display-name requirements in Meta. For standard registration, use the supported six-digit registration PIN flow and store the PIN securely. Do not run standard registration again on a coexistence number.
5. Return to Orderly and confirm the correct phone/WABA connection is shown. Orderly validates ownership/access and subscribes the WABA before saving the connection.
6. If using manual credentials, enter the correct phone number ID, WABA ID and production token; save/test verifies and subscribes them too. Temporary developer tokens are unsuitable for ongoing client operation.
7. Stop if ownership, registration, permissions or subscription fails. Do not enable the bot to bypass a failed check.

## 11. Controlled live acceptance test

Use a recipient you control, with the client's agreement and a staff member monitoring. These tests remain outstanding until the client is present.

1. Recheck the selected model, provider approval, published bot configuration, menu, delivery rules, Sheet connection and budget. Enable the bot for this controlled test.
2. From the test WhatsApp recipient send: “I need one chicken pulao, one cold drink and one zarda.” Verify the response comes from Laziza's number and uses real menu prices.
3. Supply name, delivery address and any missing choices. Verify the summary and total. Confirm explicitly. Check one order exists in Orderly and one Sheet row contains the name, phone and address.
4. Repeat the confirmation; it must not create another order. Test editing the cart before confirmation.
5. Laziza staff calls the test customer, records confirmation in Orderly, accepts and dispatches using the supported statuses. Check Sheet status and WhatsApp delivery results.
6. Ask for a human. Verify the alert bell/inbox and that staff takeover stops automated replies. For coexistence, send a mobile-app staff reply and verify it appears and pauses automation.
7. Test unavailable items, unsupported media, missing address, Urdu/Roman Urdu and a low-budget handoff. No invented menu items or automatic dispatch should occur.
8. In a dedicated test workspace, temporarily revoke Sheet access, place a controlled test order, confirm it remains in Orderly, restore access and retry the failed job. Do not disrupt the client's production Sheet for this rehearsal.
9. After template approval, test a permitted outside-window update. Verify provider delivery status, not just request acceptance.
10. Verify owner/staff access separation and that another workspace is inaccessible. Record test date, workspace, order IDs, outcomes and any failures without copying private credentials.
11. Pause the bot again if any required case fails. Start customer traffic only after the client signs off and staff coverage is arranged.

## 12. Privacy, retention and deletion

1. Give the client the public privacy/deletion links and agree on data handling and retention before activation.
2. Owner → **Security → retention controls**: inspect the preview. Default is off. Select an appropriate period only after agreement, then explicitly confirm. Changed enabled policies have a 24-hour grace period.
3. Scheduled cleanup protects active work and runs hourly. It does not delete the client's Google Sheet or provider backups; handle those separately under the agreed policy.
4. For a customer request, verify identity/authority, export if requested, use the workspace's customer deletion control and document completion. Review separate Sheet/provider copies.
5. For offboarding, pause the bot, export required records, disconnect integrations, revoke provider tokens/Sheet sharing and remove staff access. Keep only records required under the agreed policy.

## 13. Backups and restore rehearsal

1. Check the Supabase project's actual plan and available backup/restore options; purchase upgrades yourself only if suitable. See [Supabase backups](https://supabase.com/docs/guides/platform/backups).
2. Securely back up the existing credential-encryption key and required deployment configuration separately. Database rows alone cannot decrypt credentials without that key. Do not commit secret backups.
3. Create an isolated recovery project/environment. Keep all outgoing workers, scheduled jobs, mail and WhatsApp disabled before restoring application data; restored production jobs must never send from the rehearsal.
4. Follow Supabase's supported restore/export procedure for your plan. Recreate required extensions/configuration and check what is excluded, including external storage/services and project secrets.
5. Verify company/order counts, sample history, tenant access restrictions and decryption with a controlled test credential. Do not contact customers or invoke paid models.
6. Record backup timestamp, restore completion time, checks and missing configuration. Delete the rehearsal environment according to your data policy after review. **A production backup restore has not been performed by this implementation pass.**

## 14. Daily operation and final sign-off

- Assign staff to pending orders, human handoffs and failed jobs. Check the alert bell daily; configure optional email escalation when a sender is available.
- Watch provider invoices/quotas as well as application estimates. Review 80% warnings and unresolved budget holds before increasing caps.
- Investigate failed jobs before retrying; inspect ambiguous external delivery/Sheet results to avoid manual duplicate actions.
- Re-test after changing a model, Meta token, menu source, domain or delivery rules.
- Final sign-off requires: real WhatsApp inbound/reply, confirmed order, Sheet sync, staff handoff, template behavior where used, production Auth email, recovery/MFA, agreed privacy/retention, restore evidence and an assigned operator.

**Ready to configure is not the same as approved for unattended customer traffic.** The remaining client/provider steps above are intentional launch gates, not hidden completed tests.
