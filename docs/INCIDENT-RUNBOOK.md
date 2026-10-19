# Incident runbook

Updated 18 October 2026. For the platform operator. Keep a copy outside this laptop (printed, or in the password manager), because the laptop may be the thing that was lost.

Never paste a secret value into a chat, an AI assistant, a ticket, a screenshot or this file. Write down names and times only.

## 0. The first ten minutes

1. **Write down** the time, what you saw and where (no secret values).
2. **Is something sending wrong messages, or could customer data or a key be exposed?** If yes, use the emergency stop (section 1) now. Stopping is cheap; it can be undone in a minute.
3. **Take a backup** before changing any data (`npm run backup:db`, [BACKUP-AND-RESTORE.md](BACKUP-AND-RESTORE.md) §3). It keeps both the evidence and the data.
4. **Do not change `CREDENTIAL_ENCRYPTION_KEY`** (section 3 says why).
5. Then work through sections 3 to 5, and tell people as in section 2.

## 1. Emergency stop

### Pause automation for every business (first choice)

Set the Edge Function secret `ORDERLY_PAUSE_AUTOMATION=on`: Supabase → Edge Functions → Secrets, or

```powershell
npx supabase secrets set ORDERLY_PAUSE_AUTOMATION=on --project-ref zygsuxgqkeedgcbjhfzx
```

- **What it stops:** every business behaves as if its bot were switched off. Live chats get no AI reply and no new automatic reply; bot replies already queued are dropped, and order reminders not yet sent are skipped (not sent later). **Test your bot**, **Test model** and **Connect and test** are refused with 503, so Orderly calls no AI provider. Public menu-page orders are paused. Incoming messages are still saved and appear in the inbox under **Needs staff**, so staff can answer from the dashboard. It lives in the function's secrets, not the database, so it still works if the database or the service-role key is compromised, and owners cannot switch it back on from the dashboard: saving settings with automation switched on is refused while it is set (a bot already on keeps its setting, and works again once the stop is lifted). `/api/config` reports `automationPaused: true` meanwhile. Only the values `on`, `true` and `1` count.
- **What it does not stop:** replies staff type themselves; the order-status notices staff actions send (accepting, declining, marking ready and the like); confirmations of orders already placed; and an automatic notice that was already queued as a WhatsApp send before the stop (for example a reminder, or a limit or connection-problem notice, waiting behind a busy WhatsApp connection) can still go out.
- **Check:** send a message to the test restaurant from your own phone. It appears in the inbox with no bot reply. Supabase can take a short while to give running workers a changed secret; if bot replies continue after about 5 minutes, redeploy the function: open the newest **Deploy Supabase backend** run on `main` in GitHub Actions and use **Re-run all jobs** (never an older one: it would deploy that older code over the current one; a run started by hand on another branch never deploys), or use the break-glass commands in [DEPLOYMENT.md](DEPLOYMENT.md) §2 (`npm run test:edge-runtime`, then `npx supabase functions deploy orderly --project-ref zygsuxgqkeedgcbjhfzx --use-api`).
- **Resume:** `npx supabase secrets unset ORDERLY_PAUSE_AUTOMATION --project-ref zygsuxgqkeedgcbjhfzx`. Each chat goes back to the bot on the customer's next message.

### Other stops

| Stop                              | How                                                                                                   | Side effects                                                                                                                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One business                      | Its **Bot settings → Pause automation** (the platform admin can open any business).                   | Its owners can switch it back on.                                                                                                                                                                |
| Every business, from SQL          | `update public.companies set data = data \|\| '{"botEnabled":false}'::jsonb;`                         | Use only if function secrets cannot be changed. Owners can switch their own back on. Record which were on before.                                                                                |
| Linked-phone route                | Stop the Railway `gateway` service, or set `WHATSAPP_GATEWAY_ENABLED=false` in Supabase.              | Linked numbers stop replying. The gateway keeps incoming messages on disk and delivers them when it is back; ones delayed more than 2 hours get a resumable pause instead of an automatic reply. |
| All background work (last resort) | `select cron.unschedule('orderly-recover-jobs');` and delete the Vault secret `orderly_worker_token`. | Freezes everything, including the inbox and staff replies. Restore by rerunning the schedule line from `202609110001_job_dispatch.sql` and `node scripts/configure-scheduler.mjs <env file>`.    |

Do not use a wrong `CRON_SECRET` or an unset `META_APP_SECRET` as a stop: they fail silently or make Meta resend everything later.

## 2. Who to tell

Each restaurant is the controller of its customers' data; Orderly processes it for them. Orderly tells the restaurants; the restaurants tell their customers, with Orderly's help.

| Who                  | When                                                                     | How                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Affected restaurants | Without undue delay once an incident is confirmed (aim: within 24 hours) | Owner emails from the admin **People** page, and the phone number in each business's Settings. Template below.                                                    |
| Their customers      | When the restaurant decides, usually right after                         | Sent by the restaurant from its own WhatsApp. Orderly drafts the text (template below).                                                                           |
| Meta                 | If data from the official WhatsApp Business Platform may be involved     | Meta's platform terms expect developers to report incidents involving platform data. Use Meta for Developers support. [OWNER TO CONFIRM: exact reporting channel] |
| Provider support     | If their keys or accounts were involved                                  | Supabase, Railway, Cloudflare, Google, the AI providers, Resend.                                                                                                  |
| Lawyer               | For any confirmed personal-data incident                                 | Whether a notice to an authority is required, and whether a crime should be reported under PECA. [OWNER TO CONFIRM: lawyer's name and number]                     |

**Restaurant notice (email):** "On <date> we found <what happened> affecting Orderly. It may have exposed <kinds of data, e.g. customer names, WhatsApp numbers, addresses, order details> for <your restaurant / all restaurants> between <start> and <end>. We have <what was done: stopped automation, changed keys, …>. What you should do: <e.g. connect a new AI key, re-run WhatsApp signup>. We will send an update by <time>. We can help you tell your customers; a draft is below."

**Customer notice (for the restaurant to send):** "Assalam o Alaikum. <Restaurant> uses Orderly to take WhatsApp orders. On <date> a security problem at Orderly may have exposed your <name, number, address, order details, chat messages>. Orderly does not take payments or ask for card, bank or CNIC details, but anything typed in the chat <was / was not> affected. We have fixed the problem. If you have questions, reply here."

## 3. Secrets: what a leak allows and how to change each one

Rotate in this order for a broad compromise (for example a lost laptop or a leaked `.local` file): stop (section 1) → accounts → database access → message forging → worker → links → restaurant credentials → mail → sign users out → reset every account (both below the table).

| Secret (where it lives)                                                                                              | If it leaks                                                                                                                                                             | How to change it, and what happens                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SUPABASE_ACCESS_TOKEN` (GitHub `production` environment, local CLI login, `.local/deploy.env`)                      | Worst case. Deploys any code into the function (which can read every secret), runs SQL and manages every project on the account.                                        | Supabase → Account → Access tokens: revoke it, create a new one with an expiry, update the GitHub environment secret, `npx supabase login` again. Deploys fail until updated. Check: the next workflow run deploys.                                                                                                                                                                                                                                    |
| GitHub account and push access                                                                                       | A push to `main` deploys the backend, and Railway builds the gateway from `main`.                                                                                       | Change the password, check 2FA, revoke personal tokens and the Git Credential Manager login, review collaborators and the Railway GitHub app grant.                                                                                                                                                                                                                                                                                                    |
| Supabase dashboard login and database password (password manager, `.local/db-url.dpapi`)                             | Full access to the project and database.                                                                                                                                | Change the account password and check 2FA. Database password: Settings → Database → Reset. The app does not use it, so nothing breaks; save the new Session pooler string again (BACKUP-AND-RESTORE §2).                                                                                                                                                                                                                                               |
| `SUPABASE_SERVICE_ROLE_KEY` (provided to the function automatically; `.local/supabase.env` for the scheduler helper) | Reads and writes every restaurant's data, including encrypted credentials; Auth admin; can queue WhatsApp sends from any restaurant's number. Cannot delete audit rows. | [OWNER TO CONFIRM: whether the project uses legacy JWT keys or the new secret keys, Settings → API Keys.] New secret keys: create a new one, then revoke the leaked one. Legacy keys: rotating the JWT secret also replaces `SUPABASE_ANON_KEY` and signs out every user. The browser fetches the anon key at run time, so no frontend rebuild is needed. Update `.local/supabase.env`.                                                                |
| `SUPABASE_ANON_KEY`                                                                                                  | Public by design (sent to every browser). Row-level security protects data.                                                                                             | Only changes with a legacy JWT-secret rotation, above.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `CREDENTIAL_ENCRYPTION_KEY` (function secret, `.local/supabase.env`, password manager)                               | With a database copy: decrypts every restaurant's stored Meta token, AI key and Google key. Without `MENU_LINK_SECRET`: also forges menu links.                         | **It cannot be rotated today.** There is no re-encryption tool, so a new key makes every stored credential unreadable and disconnects every restaurant. If it leaked with database access: cut the database access (service-role key, database password), then have every restaurant revoke and re-enter its credentials (rows below). Keep the old key in the password manager. Real rotation needs a versioned key and a re-encryption script first. |
| `MENU_LINK_SECRET` (function secret; when unset, derived from the encryption key)                                    | Forges a customer's personal menu link: shows their name and can place pending orders into their chat.                                                                  | Generate `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` (standard base64, not hex) and set it in quiet hours. Links from the last 2 hours and order codes from the last 30 minutes stop working. Check: open a fresh link and redeem a test code on the test restaurant. Set it explicitly now, so it can change without the encryption key.                                                                            |
| `CRON_SECRET` (function secret, Vault `orderly_worker_token`, `.local/supabase.env`)                                 | Triggers due jobs early and wastes function calls. No data access.                                                                                                      | Two places, back to back in quiet hours: set the new function secret, update the env file, run `node scripts/configure-scheduler.mjs .local/supabase.env` at once. In between, dispatches get 401 and jobs wait (retried about every 45 seconds); nothing is lost. Check: a test message gets its reply; `/api/health/pipeline` is OK if `HEALTH_CHECK_TOKEN` is set.                                                                                  |
| `META_APP_SECRET` (function secret)                                                                                  | Forges WhatsApp webhooks for official-route restaurants: fake customer messages that spend their AI budget and create pending orders, fake staff echoes.                | Meta App Dashboard → Settings → Basic → Reset app secret, then set the Supabase secret straight away. Webhooks in the gap fail and Meta resends them late; WhatsApp signup fails in the gap. Check: a test message arrives and is answered.                                                                                                                                                                                                            |
| `META_VERIFY_TOKEN` (function secret, Meta webhook settings)                                                         | Only the webhook handshake. Low risk.                                                                                                                                   | Set a new value in Supabase and in Meta's webhook settings, then verify the webhook again.                                                                                                                                                                                                                                                                                                                                                             |
| Restaurant Meta access tokens (stored encrypted)                                                                     | Send messages as the restaurant.                                                                                                                                        | Orderly cannot revoke them. The owner removes the system user token or app access in Meta Business settings, then runs WhatsApp signup again in Orderly.                                                                                                                                                                                                                                                                                               |
| `WHATSAPP_GATEWAY_SECRET` (Supabase) = `GATEWAY_SHARED_SECRET` (Railway, `gateway/.env`)                             | Sends any text from a linked restaurant number and forges events into Orderly.                                                                                          | Generate a new random value (at least 32 characters) and set it in Railway and Supabase together in a quiet hour. The gateway redeploys and WhatsApp reconnects briefly; events in the gap are retried. Check: Agent flow **Last heartbeat** under about 75 seconds, and `npm run doctor -- --online` in `gateway/`.                                                                                                                                   |
| `GATEWAY_ENCRYPTION_KEY` (Railway, `gateway/.env`, password manager)                                                 | With the Railway volume or a volume backup: takes over the linked WhatsApp session.                                                                                     | First remove the Orderly session on the phone (WhatsApp → Linked devices); that ends the session at once. Changing the key means pairing every linked number again.                                                                                                                                                                                                                                                                                    |
| `HEALTH_CHECK_TOKEN` (function secret, the uptime monitor)                                                           | Reads only the coarse pipeline health.                                                                                                                                  | Set a new value in Supabase and in the monitor.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `RESEND_API_KEY`, `ALERT_FROM_EMAIL` (function secrets)                                                              | Sends email as the alert sender.                                                                                                                                        | Create a new key in Resend, set it, delete the old one. Nothing breaks.                                                                                                                                                                                                                                                                                                                                                                                |
| Restaurant AI keys (stored encrypted)                                                                                | Spends the restaurant's AI credit.                                                                                                                                      | The owner revokes it in the provider's console and connects a new key in **Bot settings → AI model → Connect and test**.                                                                                                                                                                                                                                                                                                                               |
| Google service-account keys (stored encrypted; `.local/google-sheets.json`)                                          | Reads and writes the orders Sheet, which holds customer details.                                                                                                        | Google Cloud → IAM → Service accounts → Keys: add a key, paste it in **Integrations → Google Sheets**, test, then delete the old key.                                                                                                                                                                                                                                                                                                                  |
| Auth SMTP login, Cloudflare (wrangler), Railway and Meta Business admin accounts                                     | Account takeover: email as your domain, replace the website, change the gateway, change WhatsApp settings.                                                              | Change passwords, check 2FA, end other sessions; for SMTP, also update Supabase → Authentication → SMTP.                                                                                                                                                                                                                                                                                                                                               |
| Retired copies: Vercel project `orderly`, the old `waytogalaxy999` Cloudflare worker                                 | The Vercel project likely still holds the service-role key and the encryption key.                                                                                      | Delete them ([DEPLOYMENT.md](DEPLOYMENT.md) §8), then rotate whatever they held.                                                                                                                                                                                                                                                                                                                                                                       |

**Lost or stolen laptop.** It holds (names only): `.local/supabase.env`, `.local/supabase-secrets.env`, `.local/deploy.env`, `.local/vercel.env`, `.local/google-sheets.json`, `.local/cli-login-output.txt`, `.local/db-url.dpapi`, `.local/backups/`, `.local/orderly-backup-key.txt` if it was never moved to the password manager (then the encrypted off-laptop backups are exposed too), `gateway/.env` and `gen-lang-client-*.json`. Assume all of them leaked: stop, then rotate in the order above, including the service-role key and database password. Because `.local/supabase.env` holds both the service-role key and the encryption key, treat every stored restaurant credential as exposed and ask every restaurant to re-key. Plain backup folders hold customer data, so this is a personal-data incident: tell the restaurants (section 2). They also hold every account's sign-in secrets, so do both steps below: sign everyone out, then reset every account.

**Sign people out.** After a dashboard account is compromised, change its password and end its sessions: `delete from auth.sessions where user_id = '<user id>';`. To sign out everyone (a lost laptop or a leaked backup): `delete from auth.sessions;`, which also ends their refresh tokens. An access token already issued lasts until it expires, about an hour. Backups made by an older copy of `scripts/backup-db.mjs` hold everyone's live sessions too, including the platform admin's. Remove the account from businesses on the People page if needed.

**Reset every account after a leaked backup** (a lost laptop counts). Signing out is not enough: every backup still holds each account's password hash (`auth.users`), which can be cracked offline, the token hashes behind recent invite and password-reset emails, and the authenticator secrets (`auth.mfa_factors`). After signing everyone out:

1. **Platform admin:** change the password, then set up the authenticator again: remove the old factor in Supabase → Authentication → Users (or `delete from auth.mfa_factors where user_id = '<user id>';`), then enrol again in **Security & privacy**.
2. **Every owner and staff member:** ask each to set a new password with **Send password reset link** on the sign-in page, and to set up any authenticator again once you have removed their old factor the same way. Until they do, a cracked password still works.
3. **Invites and reset emails** sent in the day before the backup: treat them as exposed and send the invites again.
4. Optionally raise the minimum password length in Supabase → Authentication.

## 4. Suspected breach: steps

1. **Contain:** emergency stop, then rotate as above.
2. **Preserve:** take a backup; save the Supabase function and API logs now (the Free plan keeps them only briefly); note times. Do not delete anything. The app's service-role key cannot delete audit rows, which helps; the database owner (the SQL editor, or anyone holding the access token or database password) still can.
3. **Scope:** which businesses (a service-role or access-token leak means all of them), which kinds of data, which time window. Read-only queries in the SQL editor (inside `begin; set transaction read only; … rollback;`):

   ```sql
   -- Admin and privacy actions, newest first.
   select created_at, company_id, actor_id, action from public.audit_events
   where created_at > now() - interval '7 days' order by created_at desc limit 200;
   -- WhatsApp sends queued in the window, per business.
   select company_id, count(*) from public.jobs
   where data->>'kind' = 'whatsapp_send' and created_at > now() - interval '1 day' group by 1;
   -- Worker dispatch results (401 means a CRON_SECRET mismatch).
   select status_code, count(*) from net._http_response group by 1;
   -- Recent scheduler runs.
   select jobid, status, start_time from cron.job_run_details order by start_time desc limit 50;
   ```

4. **Tell** the people in section 2. Say what is known and what is not yet known; send updates.
5. **Recover:** if data was lost or changed, restore as in [BACKUP-AND-RESTORE.md](BACKUP-AND-RESTORE.md) §6.
6. **Resume** (unset `ORDERLY_PAUSE_AUTOMATION`), watch the inbox and Agent flow for an hour, then write a short account: what happened, when, what was exposed, what changed, what to do differently. Update this runbook.

## 5. Contacts

| Who                       | Contact                                         |
| ------------------------- | ----------------------------------------------- |
| Operator (you)            | [OWNER TO CONFIRM: phone and backup contact]    |
| Lawyer                    | [OWNER TO CONFIRM]                              |
| Restaurants               | Admin **People** page and each business's phone |
| Supabase / Railway / Meta | Their support pages, from the account dashboard |

## 6. Delete a workspace on request

The Terms and the deletion page promise that Orderly deletes a whole workspace on request, by hand: there is no dashboard button. Do every step in this order, signed in as the platform admin, and note each one with its time (business name only, no customer data).

1. **Confirm the request.** It must come from the account email of one of that business's owners (People page). Reply to that address to confirm it and agree a date. Note the business's id and slug (`select id, slug, data->>'name' from public.companies;`, read-only); every step below names both, so a typo cannot reach another business.
2. **Pause the bot and the menu page:** that business's **Bot settings → Pause automation**, and **Your menu → Menu page** off.
3. **Disconnect everything, in Orderly first.** Deleting the rows while a linked phone is still paired leaves it paired on the Railway gateway, still receiving and decrypting the restaurant's chats.
   - **Integrations → WhatsApp → Disconnect.** On a linked phone this logs the device out and wipes its session on the gateway (logged there as `SESSION_DISCONNECTED`). If Orderly then says to "Also remove Orderly under WhatsApp → Linked devices" because the old session could not be ended from here, the gateway did not get the command: once the gateway answers again (its `/healthz`), press **Disconnect** again until it finishes without that note. Either way, ask the owner to check WhatsApp → **Linked devices** and remove Orderly. On the official route the owner also removes Orderly's app in Meta Business settings.
   - **Integrations → Google Sheets → Disconnect**, and the owner removes the service account from the spreadsheet's sharing (the Sheet itself stays theirs).
   - **Bot settings → AI model → Remove saved key**, and the owner revokes the key in the provider's console.
4. **Export, then back up.** The owner downloads what they need: **Orders → Export all matching orders** (all statuses and dates) and, per customer, **Security & privacy → Export customer data**. There is no one-click export of every chat. Then take a backup ([BACKUP-AND-RESTORE.md](BACKUP-AND-RESTORE.md) §3); it expires with the others, as the privacy policy says.
5. **Check nothing is running and list the accounts** (read-only). The first must return 0 (otherwise wait a few minutes); note from the second each account that is in no other business and is not a platform admin:

   ```sql
   select count(*) from public.jobs where company_id = '<id>' and status = 'processing' and lease_until > now();
   select m.user_id, u.email, m.role,
     (select count(*) from public.company_memberships o where o.user_id = m.user_id and o.company_id <> m.company_id) other_businesses,
     exists(select 1 from public.platform_admins a where a.user_id = m.user_id) platform_admin
   from public.company_memberships m join auth.users u on u.id = m.user_id where m.company_id = '<id>';
   select id, data->>'provider' as provider, data->>'status' as status from public.whatsapp_connections where company_id = '<id>';
   ```

   If the business uses or used a linked phone (the last query shows `baileys`, or the owner says it moved from a linked phone to the official route), confirm that the gateway ended that session: Railway → `gateway` → logs show `SESSION_DISCONNECTED` or `SESSION_RETIRED` with that connection id after step 3. If neither appears and the provider is `baileys`, press **Disconnect** in Orderly again once the gateway answers (it logs `SESSION_DISCONNECTED` even for a session it no longer has); in every case the owner removes Orderly under Linked devices. Do not go on to step 6 before this: once the rows are gone, Orderly answers that session's events with 200 and ignores them, so nothing would ever end a session the gateway missed, and it would stay linked on Railway, still receiving and decrypting the restaurant's chats.

6. **Delete the workspace** in one transaction. Traces and orders point at chats without a cascade, so they go first; deleting the `companies` row then removes everything else of that business (chats and their messages, receipts, jobs, menu, menu page, integrations and their encrypted secrets, the WhatsApp connection, usage, limits, blocks, alert settings, retention policy and memberships). If the id and slug do not name one business, it stops and nothing is deleted. The last line records who did it, in the audit table, which keeps no message text:

   ```sql
   begin;
   do $$
   declare n integer;
   begin
     delete from public.traces where company_id = (select id from public.companies where id = '<id>' and slug = '<slug>');
     delete from public.orders where company_id = (select id from public.companies where id = '<id>' and slug = '<slug>');
     delete from public.companies where id = '<id>' and slug = '<slug>';
     get diagnostics n = row_count;
     if n <> 1 then raise exception 'No business with this id and slug; nothing was deleted'; end if;
   end $$;
   select public.audit_event('<id>', '<your auth user id>', 'admin.workspace_deleted');
   commit;
   ```

7. **Delete the accounts** noted in step 5 in Supabase → Authentication → Users. Leave anyone who is in another business or a platform admin.
8. **Verify** (read-only): every count is 0.

   ```sql
   select (select count(*) from public.companies where id = '<id>') companies,
     (select count(*) from public.conversations where company_id = '<id>') conversations,
     (select count(*) from public.orders where company_id = '<id>') orders,
     (select count(*) from public.jobs where company_id = '<id>') jobs,
     (select count(*) from public.integrations where company_id = '<id>') integrations,
     (select count(*) from public.whatsapp_connections where company_id = '<id>') whatsapp,
     (select count(*) from public.company_memberships where company_id = '<id>') members;
   ```

9. **Tell the owner** it is done, and what stays: the audit records (no message text), Orderly's backups until they expire, Railway volume backups of a linked phone ([gateway/RAILWAY.md](../gateway/RAILWAY.md) §8), and copies Orderly does not control (the Google Sheet, WhatsApp on the phone, the AI provider's own retention, downloaded exports).
