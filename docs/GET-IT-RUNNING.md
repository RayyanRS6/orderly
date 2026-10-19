# Get Orderly running

Updated 18 October 2026. This is the one checklist to follow. Each step says who does it, where and how you know it worked. The **Agent flow** page in the dashboard shows the same steps live, with what is still missing for each business.

Pilot: two test restaurants are set up, and a friend's restaurant is the first real one to go live.

## 1. Where everything runs

```text
Customer's WhatsApp
   │
   ├─ Meta Cloud API (official WhatsApp Business Platform; coexistence keeps the Business app)
   └─ or linked phone → WhatsApp gateway on Railway ("order work"), unofficial
   ▼
Orderly API + database + jobs on Supabase (zygsuxgqkeedgcbjhfzx, Sydney)
   ├─ AI model: each restaurant's own key (Anthropic Claude Haiku 5.5 recommended, or OpenAI / Gemini)
   ├─ Google Sheet (order copy)
   └─ Staff alerts (optional email through Resend)
   ▲
Dashboard on Cloudflare (https://orderly.meerurayyan.workers.dev)
```

| Piece                                    | Status today                                                                | You pay                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| Dashboard (Cloudflare)                   | Live for the pilot                                                          | Free plan                                                 |
| API, database, logins, jobs (Supabase)   | Live for the pilot                                                          | Free plan for the pilot: **no automatic backups**, see §8 |
| Meta official WhatsApp (Cloud API)       | In use; the supported route                                                 | Meta message fees                                         |
| WhatsApp gateway (Railway, "order work") | In use for linked-phone restaurants; new pairings only when you enable them | Hobby plan, roughly $5–6/month for one number (estimate)  |
| AI model                                 | Each restaurant connects and pays for its own key                           | Usage only, see section 7                                 |
| Google Sheet                             | Works with the existing service account                                     | Free                                                      |

Only the gateway needs Railway. It is the one part that must stay running all the time with saved WhatsApp login data, which Supabase and Cloudflare cannot do.

## 2. Ship an update

Follow the release order in [DEPLOYMENT.md](DEPLOYMENT.md) §7: backup, any SQL marked "before", the legal placeholders filled in, Railway's **Wait for CI** checked, one push that deploys the backend and then the gateway, the dashboard deploy and any SQL marked "after", all at a quiet hour.

1. **You:** review and approve the commit, then push to `main` at a quiet time. GitHub Actions (`Deploy Supabase backend`) first runs the type check and every test, and deploys only if they pass. Wait in GitHub → Actions until both `verify` and `deploy` are green; `deploy` also checks the live `/api/health`. Pushes that change only docs, Markdown or `gateway/` do not redeploy the backend; `Check WhatsApp gateway` still runs every test on them, so fix it if it turns red. A push with a commit that changes `gateway/` (other than Markdown), `src/shared/whatsapp.ts`, `server/whatsapp/signing.ts` or `.dockerignore` rebuilds the gateway on Railway; with **Wait for CI** on (required, DEPLOYMENT.md §7, step 5) Railway deploys it only after every check on the commit is green, so after the backend from the same push.
2. **You:** deploy the dashboard from this folder, signed in to the Cloudflare account that serves `orderly.meerurayyan.workers.dev` (`npx wrangler whoami` shows which account):

   ```powershell
   $env:VITE_API_BASE_URL = 'https://zygsuxgqkeedgcbjhfzx.supabase.co/functions/v1/orderly'
   npm run build:cloudflare
   npx wrangler deploy
   ```

3. **Check:** sign in at the dashboard, open a business, and click **Agent flow** in the sidebar. You should see the setup checklist and the flow diagram.

## 3. Turn on Claude Haiku 5.5

Model ID `claude-haiku-5-5`. Prices: $0.10 per million input tokens and $0.50 per million output tokens for prompts up to 100,000 tokens. Orderly's prompts stay well under that. Larger prompts are billed at $0.50 / $2.50, and Orderly's budget estimate already uses the higher price when it applies. Orderly asks it to think briefly (effort: low) for fast chat replies.

Each business uses its own Anthropic key, so its AI usage is billed to its own Anthropic account.

1. **The business owner (or you, with them):** at <https://console.anthropic.com>, add billing and credit, set a monthly spend limit, and create an API key. Do not paste the key into chat or into any `VITE_` setting.
2. **Orderly → Bot settings → AI model** (everything is on this one card):
   - **AI provider:** Anthropic Claude. The model fills in as `claude-haiku-5-5` (recommended).
   - **Anthropic API key for <business>:** paste the key.
   - Tick the agreement to send customer messages to Anthropic.
   - Click **Connect and test**.
3. Orderly checks the key, sends one fictional test message ("Hello. Please show the menu.") to prove the model works, then saves the key encrypted for that business and switches the bot over. If anything fails you see why, and nothing changes. The badge turns **Connected**, and Agent flow shows the **Model** circle in green with $0.10 in · $0.50 out.

To change model or key later, use the same card: pick or paste the new one and click **Connect and test** again. **Remove saved key** pauses replies until another key is connected. Orderly never supplies a key of its own: every business must connect its own.

## 4. Connect WhatsApp

**Option A: official Meta Cloud API, with coexistence (the supported route).** Follow [`ORDERLY-LAUNCH-STEPS-2026-09-18.md`](ORDERLY-LAUNCH-STEPS-2026-09-18.md) sections 9–10. If the restaurant already uses the WhatsApp Business app on its number, tick **Keep using the WhatsApp Business mobile app** during signup: Meta's coexistence onboarding keeps the app working alongside Orderly (Meta decides eligibility).

**Option B: linked phone through Railway (unofficial).** Use it only when Option A is not possible for that restaurant, and only after you, the platform admin, have enabled linked-phone pairing for that business ([DEPLOYMENT.md](DEPLOYMENT.md) §4 says how).

- **The risk, in plain words:** this method is against WhatsApp's terms. WhatsApp can ban the whole number, temporarily or permanently, and the restaurant's own WhatsApp app on that number stops working too. Customer messages are decrypted and processed on Orderly's gateway server on Railway. Tell the owner this before pairing; the dashboard records their consent. A banned number may not be able to move to the official route afterwards.

1. The Railway service is already running. For a new installation, follow [`gateway/RAILWAY.md`](../gateway/RAILWAY.md) exactly: service settings, the two secrets, the variables, the `/data` volume, the domain and the health check. The gateway migration (`202609200001_whatsapp_gateway.sql`) is already applied in production.
2. **With the restaurant owner present:** Orderly → **Integrations → WhatsApp**, go through the risk notice with them, tick the consent box and pair by QR code or pairing code.
3. **The owner, on the phone:** turn off the WhatsApp Business app's greeting and away messages (Business tools → Greeting message / Away message) and use Orderly's greeting instead. With a linked phone those automatic messages reach Orderly like a reply staff typed, so each one pauses the bot for that customer.
4. **Check:** Agent flow → **WhatsApp (linked phone)** is green. Its last heartbeat is updated about once a minute; over 3 minutes means Orderly treats WhatsApp as offline. "Server connections" shows the gateway as set. If the phone stops working while the bot is on, staff see a WhatsApp alert in the bell (and an email, for those who opted in).
5. Plan the move to Option A with coexistence for that restaurant.

## 5. Per business (repeat for each client)

The Agent flow checklist shows these steps in order. Each one has a button to the right page.

1. **Settings:** address, phone, opening hours and delivery areas with fees.
2. **Menu:** items, prices, options and aliases (the other names customers use). Or connect the Sheet menu.
3. **Bot settings:** model (above), goal, tone, language, rules, greeting and handoff message. Save the draft.
4. **Test your bot:** order something end to end. Click **Why this reply?** under any answer you don't like. It shows which settings, rule and model were used, what the AI proposed, what the order engine corrected, and who wrote each part of the reply.
5. **Publish** the draft. Live WhatsApp chats only use the published version.
6. **Integrations → Google Sheet:** share the spreadsheet with the service account and test it. Live automatic replies currently require this.
7. **Connect WhatsApp** (section 4), then **Bot settings → Enable automation**.
8. Run the controlled live test in `ORDERLY-LAUNCH-STEPS-2026-09-18.md` §11 before real customers.

## 6. Reading the Agent flow page

- **Colours:** green means ready, orange means it needs attention (the panel says exactly what to do), a grey dashed outline means not connected, and a lock means built into Orderly.
- **Select any box** to see what it takes in, what it passes on, its current settings, how it shapes replies, and the fixed rules you can't change. Examples: the model never sets prices; a chat a staff member took over stays with staff.
- **Why did it reply that way?** Pick a recent reply. The path it took lights up in orange, and anything that stopped it (budget, AI error, menu Sheet) is outlined in red.
- **Server connections** (owners and admins only) lists which server keys are set, without showing their values.

## 7. Running costs (estimates, not quotes)

- **Claude Haiku 5.5:** a typical customer message sends about 5,000–15,000 input tokens (rules, menu index, history) and gets about 300–1,000 output tokens back, including brief thinking. That is roughly $0.001–$0.002 per message, or about $1–2 per 1,000 messages. The provider invoice is authoritative. Monthly limits in Bot settings stop spending at the cap.
- **Railway gateway:** about $5–6/month for one number on Hobby. Each extra number adds roughly $1.5–2.5 (estimate; measure before adding clients).
- **Supabase:** Free plan for the pilot ($25/month for Pro later, which adds daily backups). **Cloudflare:** free.

## 8. Backups and incidents

- **Backups:** Supabase Free has no automatic backups, and since 19 October 2026 the owner keeps no regular backups (the privacy policy says so), so a lost database cannot be restored. Setting up the nightly backup and doing the restore drill once is still recommended: [BACKUP-AND-RESTORE.md](BACKUP-AND-RESTORE.md) (change the policy first). Always take a copy before pasting SQL into production, and delete it within 30 days.
- **If something goes wrong** (wrong replies, a leaked key, a lost laptop): [INCIDENT-RUNBOOK.md](INCIDENT-RUNBOOK.md). The fastest stop is the Edge Function secret `ORDERLY_PAUSE_AUTOMATION=on`.

## 9. Not verified yet

- A backup restore has not been rehearsed yet ([BACKUP-AND-RESTORE.md](BACKUP-AND-RESTORE.md) §5).
- The emergency stop has not been tried on the live project; try it once on the test restaurant.
- The legal pages were filled in on 19 October 2026 (operator: the owner as a sole proprietor in Islamabad; no regular backups) but have not had a lawyer's review ([COMPLIANCE-NOTES-2026-10-18.md](COMPLIANCE-NOTES-2026-10-18.md)).
