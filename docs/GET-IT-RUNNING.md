# Get Orderly running

Updated 15 October 2026. This is the one checklist to follow. Each step says who does it, where and how you know it worked. The **Agent flow** page in the dashboard shows the same steps live, with what is still missing for each business.

## 1. Where everything runs

```text
Customer's WhatsApp
   │
   ├─ Linked phone → WhatsApp gateway on Railway ("order work")  ← new, not deployed yet
   └─ or Meta Cloud API (official route; blocked while the Meta account is restricted)
   ▼
Orderly API + database + jobs on Supabase (zygsuxgqkeedgcbjhfzx)
   ├─ AI model: Anthropic Claude Haiku 5.5 (or OpenAI / Gemini)
   ├─ Google Sheet (order copy)
   └─ Staff alerts (optional email through Resend)
   ▲
Dashboard on Cloudflare (https://orderly.meerurayyan.workers.dev)
```

| Piece                                    | Status today                                                                  | You pay                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| Dashboard (Cloudflare)                   | Live, in use at Fries & Buns                                                  | Free plan                                                |
| API, database, logins, jobs (Supabase)   | Live, in use at Fries & Buns                                                  | Free plan now; Pro ($25/month) adds daily backups        |
| WhatsApp gateway (Railway, "order work") | Project created, **empty**. Needs GitHub access, variables and a volume.      | Hobby plan, roughly $5–6/month for one number (estimate) |
| AI model (Anthropic)                     | Code ready for Claude Haiku 5.5. **Needs an Anthropic API key.**              | Usage only, see section 7                                |
| Google Sheet                             | Works with the existing service account                                       | Free                                                     |
| Meta official WhatsApp                   | Code ready. The Meta account restriction was the blocker (`SETUP-STATUS.md`). | Meta conversation fees                                   |

Only the gateway needs Railway. It is the one part that must stay running all the time with saved WhatsApp login data, which Supabase and Cloudflare cannot do. Everything else stays where it already works.

## 2. Ship this update

What changed: the **Agent flow** page; a **Why this reply?** explanation under every new bot reply (Test your bot and Inbox); Claude Haiku 5.5 as the recommended Anthropic model; Railway support for the gateway.

1. **You:** review and approve the commit, then push to `main`. GitHub Actions deploys the backend automatically (`Deploy Supabase backend`). This is the same production backend Fries & Buns uses, so push at a quiet time and confirm the run is green in GitHub → Actions. Existing conversations and settings are unchanged; only new bot replies gain an explanation.
2. **You:** deploy the dashboard from this folder, signed in to the Cloudflare account that serves `orderly.meerurayyan.workers.dev` (`npx wrangler whoami` shows which account):

   ```powershell
   $env:VITE_API_BASE_URL = 'https://zygsuxgqkeedgcbjhfzx.supabase.co/functions/v1/orderly'
   npm run build:cloudflare
   npx wrangler deploy
   ```

3. **Check:** sign in at the dashboard, open a business, and click **Agent flow** in the sidebar. You should see the setup checklist and the flow diagram.

No database migration is needed for the Agent flow or the reply explanations. Explanations are saved inside each conversation.

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

To change model or key later, use the same card: pick or paste the new one and click **Connect and test** again. **Remove saved key** pauses replies until another key is connected. Platform administrators can still choose Orderly's own shared key under **Advanced** (set as the `ANTHROPIC_API_KEY` server secret), but each business having its own key is the default.

## 4. Connect WhatsApp

**Option A: linked phone through Railway.** This works without Meta approval. It is an unofficial route, so read the risks in `gateway/README.md`.

1. **You:** Railway → project **order work** → **Add a service → GitHub Repository** → **Connect GitHub**. Approve access to `RayyanRS6/orderly` only. This is a GitHub permission screen, so you must do it yourself.
2. Follow [`gateway/RAILWAY.md`](../gateway/RAILWAY.md) exactly. It covers the service settings, generating the two secrets on your computer, the variables, the `/data` volume, the domain and the health check.
3. **You:** back up the database, apply `supabase/migrations/202609200001_whatsapp_gateway.sql` through your reviewed migration process, then set the three backend secrets from the runbook (`WHATSAPP_GATEWAY_URL`, `WHATSAPP_GATEWAY_SECRET`, `WHATSAPP_GATEWAY_ENABLED=true`).
4. **With the restaurant owner present:** Orderly → **Integrations → WhatsApp** → pair by QR code or pairing code.
5. **Check:** Agent flow → **WhatsApp (linked phone)** is green with a heartbeat under 90 seconds. "Server connections" shows the gateway as set.

**Option B: Meta Cloud API.** Follow `ORDERLY-LAUNCH-STEPS-2026-09-18.md` sections 9–10 once Meta lifts the account restriction.

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
- **Supabase:** free to start, $25/month for Pro with backups. **Cloudflare:** free.

## 8. Not verified yet

- No real WhatsApp message has been sent through the Railway gateway; it is not deployed.
- Claude Haiku 5.5 has not been called with a real key from this code, because no Anthropic key was available. The generation test in Bot settings is that check.
- The gateway database migration has not been applied to production.
- This update has not been deployed. Section 2 does that once you approve.
