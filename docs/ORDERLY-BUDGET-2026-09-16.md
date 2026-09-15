# Orderly budget and Pakistan client pricing

**Prepared 16 September 2026.** Prices were checked against provider pages; they can change. All PKR conversions below use a transparent **planning assumption of PKR 280 per USD**, not a claim about today's card exchange rate. Taxes, card conversion charges, usage overages and third-party reseller fees are additional. Figures are estimates, not provider invoices.

## 1. What you actually need to buy

**Supabase Pro + Cloudflare Free + a basic domain is enough for the current hosting architecture.** Supabase runs the backend API, database and login. Cloudflare already hosts the frontend. You do not need Hostinger hosting or a Vercel migration.

| Owner expense | Monthly USD | Approximate PKR | Explanation |
|---|---:|---:|---|
| Supabase Pro | $25.00 | 7,000 | Baseline for one project on the included Micro compute allowance; extra compute/projects/usage can add cost. |
| Cloudflare static frontend | $0 | 0 | Current frontend fits static hosting; static asset requests are free. |
| Basic `.com`, budgeted at $20/year | $1.67 equivalent | 467 | Usually paid annually, not $1.67 each month. |
| Hostinger hosting | $0 | 0 | Unnecessary for this deployment. Buying only a domain from a registrar is a separate matter. |
| **Recommended baseline** | **$26.67/month equivalent** | **7,467/month** | Before overages, taxes and operating labour. |

Sources: [Supabase pricing](https://supabase.com/pricing), [Cloudflare static asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/). As one registrar example, [Namecheap](https://www.namecheap.com/domains/) displayed a `.com` promotion at $11.28 and renewal at $18.48, with the applicable ICANN fee extra. Budget for renewal, not just the first-year offer; premium names cost more. No specific domain's availability has been established.

### If you buy the additional plans you mentioned

| Stack | Monthly equivalent USD | Approximate PKR |
|---|---:|---:|
| Supabase Pro + Cloudflare Free + $20/year domain | $26.67 | 7,467 |
| Above, plus Cloudflare Pro billed monthly | $51.67 | 14,467 |
| Above, using Cloudflare Pro's annual billing rate | $46.67 | 13,067 |
| Supabase Pro + Vercel Pro for one developer + domain, without Cloudflare Pro | $46.67 | 13,067 |

[Cloudflare Pro](https://www.cloudflare.com/plans/) is $25/month, or $20/month equivalent when billed annually. It is a website security/performance plan, separate from the [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/), which starts at $5/month for relevant dynamic Worker usage. Neither upgrade is necessary just to serve this current static dashboard. A Pro zone subscription does not automatically protect the separate `supabase.co` API endpoint.

[Vercel](https://vercel.com/pricing) has commercial Pro pricing starting at $20/month for a developer seat; Hobby is personal/non-commercial. It adds cost here without solving the missing routes, bot settings or responsive layouts.

### Cash to set aside

- First month with Supabase $25 and a domain costing $12–20: **$37–45, roughly PKR 10,360–12,600**, before fees.
- A practical small hosting reserve is **PKR 9,000–12,000/month** for the recommended stack. This is a planning cushion, not a promised invoice.
- If choosing Cloudflare Pro monthly too, reserve roughly **PKR 16,000–18,000/month** before your labour. The upgrade should have a specific reason.
- Add separately any monitoring, production email delivery, staff salaries, development, support, customer acquisition or accounting you actually purchase. Those costs are not covered by a hosting subscription.

Supabase Pro provides a better production baseline, including daily backup retention, but restoration still needs testing. The audit also found a worker lease tied to Free-plan timing; review it for the longer paid-plan runtime before the production upgrade rollout. [Supabase limits](https://supabase.com/docs/guides/functions/limits)

## 2. Which bill belongs to whom?

| You, the Orderly owner | Laziza, your client |
|---|---|
| Supabase and frontend infrastructure | Your one-time setup charge |
| Your Orderly domain | Your monthly service charge |
| Platform maintenance, security, monitoring and support | Its own AI API usage |
| Any optional platform email/monitoring tools | Its own Meta WhatsApp template charges |
| Business overhead and development | Its SIM/number, staff calls and optional ads/reseller fees |

For client-paid usage, choose **“own key”**, not a platform key, and confirm that Meta billing is attached to the client's business account rather than your credit line or a reseller arrangement. Keep every client's credentials separate. A Google account/Sheet is also required; paid Google Workspace is optional if the client's needs do not require it. Standard Sheets API use currently has no additional charge within quotas; Google flags future changes for excess usage, so recheck before scaling. [Sheets quotas and pricing](https://developers.google.com/workspace/sheets/api/limits)

## 3. WhatsApp cost for Pakistan

Meta's calculator was checked with **Pakistan + USD** on 16 September 2026. The following are base rates before volume discounts, taxes and any partner markup. The destination market/category matters; these figures are not universal rates for messages sent to every country.

| Message category | Meta charge per delivered message | PKR at 280/USD |
|---|---:|---:|
| Service reply during an open customer-service window | $0 | 0 |
| Utility template inside that window | $0 | 0 |
| Chargeable utility template outside that window | $0.0100 | 2.80 |
| Marketing template | $0.0473 | 13.244 |
| Domestic authentication template | $0.0100 | 2.80 |

Source: [official WhatsApp pricing calculator](https://whatsappbusiness.com/products/platform-pricing/?country=Pakistan&currency=US%20Dollars%20(USD)&category=Utility). Authentication-international has separate rules/rates and is not part of the restaurant estimate.

When a customer messages Laziza, the 24-hour customer-service window opens or refreshes. Normal replies in that window can therefore cost **$0 in Meta messaging charges**, even when an AI generates the replies. Later approved utility templates can be chargeable. Marketing is a separate category. Current billing is based on delivered chargeable messages; old per-conversation pricing articles should not drive this budget. [WhatsApp pricing explanation](https://whatsappbusiness.com/products/platform-pricing/)

### Three examples

| Monthly behavior | Meta cost USD | Approximate PKR |
|---|---:|---:|
| 1,000 customer ordering chats, all replies within their service windows, no chargeable templates | $0 | 0 |
| Those chats plus 200 chargeable late utility updates | $2.00 | 560 |
| Above plus 1,000 delivered marketing templates | $49.30 | 13,804 |

The last row is $2 utility + $47.30 marketing. Promotions require appropriate permission/template compliance. The estimate assumes direct Cloud API billing; a BSP/reseller can add a subscription or message markup. Number/SIM, ads and staff phone calls are separate.

## 4. OpenAI cost: an explicit usage model

Use the app's current OpenAI default, **`gpt-5.4-mini`**, as the initial budget example. The published standard rates are $0.75 per million input tokens and $4.50 per million output tokens. A cheaper comparison is **`gpt-5.4-nano`** at $0.20 input and $1.25 output. [Mini pricing](https://developers.openai.com/api/docs/models/gpt-5.4-mini), [Nano pricing](https://developers.openai.com/api/docs/models/gpt-5.4-nano)

### Assumptions per customer conversation

- 5 paid AI calls.
- 4,000 input tokens per call, including instructions, action schema, selected menu, history and customer message.
- 250 billed output tokens per call. Provider-billed reasoning tokens, if applicable, must be included in the actual output measurement.
- No caching discounts, audio/image processing, paid tools, failed-call overhead or taxes in this simple example.

These are planning assumptions, **not measured Laziza usage**. The application bypasses AI for some simple commands, which can reduce cost. Large menus, long histories, repeated clarification, reasoning and retries can increase it. Conversations that never become orders still consume AI.

```text
Monthly input tokens  = conversations × AI calls per conversation × input tokens per call
Monthly output tokens = conversations × AI calls per conversation × output tokens per call
AI cost = input tokens / 1,000,000 × input rate
        + output tokens / 1,000,000 × output rate
```

| Customer conversations/month | Mini USD | Mini PKR | Nano USD | Nano PKR |
|---|---:|---:|---:|---:|
| 300 | $6.19 | 1,733 | $1.67 | 467 |
| 1,000 | $20.63 | 5,775 | $5.56 | 1,558 |
| 3,000 | $61.88 | 17,325 | $16.69 | 4,673 |

At 1,000 conversations the arithmetic is 20 million input tokens + 1.25 million output tokens: $15 + $5.625 = **$20.625** with Mini. Nano is a cost comparison, not a recommendation to switch without Urdu/Roman Urdu ordering tests. Flagship models should earn their extra cost through measured quality improvements.

For the 1,000-conversation Mini example, start with a client AI allowance around **$30–40/month** and inspect actual usage. The existing $10 workspace budget is too small for this particular scenario. Application budget reservations can stop calls conservatively, so the displayed limit is not a guarantee of exactly that many completed orders.

## 5. What should you charge in Pakistan?

### Observed public benchmarks

- [OrderPilot](https://www.orderpilot.pk/) advertises PKR 4,999/month for 300 orders, PKR 12,999 for 1,000 and PKR 29,999 for 5,000, with different features/branch allowances and overage prices.
- [JawaabAI](https://www.jawaabai.com/) advertises PKR 4,999/month for 300 conversations with PKR 12,000 setup; its 800-conversation tier is PKR 10,999/month with PKR 18,000 setup.

These are advertised offers, not audited product quality or a measured market average. Inclusions vary, and orders are not the same unit as conversations. Clients will compare their **total** bill, including any AI/Meta charges you exclude.

### Recommended starting offer

**PKR 20,000 one-time setup + PKR 12,000/month**, with the client paying AI and Meta directly, after the pilot blockers are fixed and the real-number flow is demonstrated.

Suggested scope:

- One restaurant/branch, one WhatsApp number and one order Sheet.
- Menu onboarding and a restaurant ordering workflow.
- Staff training, handoff, monitoring and routine maintenance.
- A written traffic allowance, for example 1,000 customer conversations/month, with review before increasing it. Do not advertise usage enforcement until the app implements it.
- Up to two hours of routine monthly support/menu-flow adjustments.
- New custom integrations, voice processing, extra branches and larger workflow changes quoted separately.

For the first supervised pilot, **PKR 15,000–20,000 setup and PKR 8,000–10,000/month** may be a practical introductory offer, with limited support scope and a stated pilot period. After configuration, alerts and reliable onboarding are complete, **PKR 12,000–18,000/month** is a reasonable managed-service target. Higher fees need additional value or more support; a BYOK offer with few finished features is harder to sell against inclusive competitors.

### Laziza's worked monthly bill

Assume 1,000 conversations, Mini token assumptions above, 200 paid utility updates and no marketing:

| Client expense | Approximate PKR/month |
|---|---:|
| Pays Orderly | 12,000 |
| Pays OpenAI | 5,775 |
| Pays Meta | 560 |
| **Total recurring cost** | **18,335** |
| One-time setup in first month | 20,000 |
| **Estimated first month** | **38,335** |

If all messages stay within free service/utility conditions, subtract PKR 560. If a tested Nano configuration meets the restaurant's quality needs, the same example is approximately **PKR 14,118/month** including your fee. With the 1,000 marketing-template campaign, add PKR 13,244. Taxes, FX differences, SIM/calls and reseller charges remain separate.

## 6. Your unit economics

Your hosting bill is shared across clients. It does not automatically multiply by the number of restaurants. The table assumes the $26.67 baseline still meets capacity needs; it is not a load-tested capacity promise.

Assume PKR 12,000 recurring revenue/client and **two support hours/client/month valued at PKR 1,500/hour**. The labour allowance is an explicit business assumption.

| Paying clients | Revenue/month | Shared infrastructure | Support allowance | Remaining before other overhead/tax/development |
|---|---:|---:|---:|---:|
| 1 | 12,000 | 7,467 | 3,000 | **1,533** |
| 5 | 60,000 | 7,467 | 15,000 | **37,533** |
| 10 | 120,000 | 7,467 | 30,000 | **82,533** |
| 25 | 300,000 | 7,467 | 75,000 | **217,533** |

This remainder is **not net profit**: it excludes sales time, support spikes, refunds, taxes, monitoring/email subscriptions, further engineering and higher infrastructure usage. One client barely covers steady-state costs at this price. Cloudflare Pro monthly would subtract another PKR 7,000 from each row; that is a poor early purchase without a concrete need.

The setup fee pays for menu cleanup, number onboarding, bot setup, tests and staff training. For example, six onboarding hours valued at PKR 1,500 consume PKR 9,000 of a PKR 20,000 setup fee before other costs. Keep recurring support bounded rather than promising unlimited custom changes.

For sales conversations, show the restaurant a simple value test: if the service helps retain 50 additional orders/month and the restaurant earns PKR 400 contribution per order, that is PKR 20,000 of contribution. Both numbers are hypothetical; use the client's actual margins and recovered orders before claiming ROI.

## 7. Recommendation

1. Keep **Cloudflare Free + Supabase**, upgrade Supabase for production with the lease/backup checks, and buy a non-premium domain.
2. Fix the launch blockers before taking on unattended client traffic.
3. Run one restaurant pilot and measure real AI tokens and support time for a week or two.
4. Start quotes around **PKR 20,000 setup + PKR 12,000/month**, clearly disclosing client-paid provider charges.
5. Use separate client credentials and spending limits; show a monthly usage report.
6. Reprice larger branches/traffic/support from observed costs. Recheck Meta and AI rates before signing a fixed inclusive package.

The [interactive local calculator](<C:/Meeru/Works/My chatbot for daddy/docs/orderly-cost-calculator.html>) lets you change the exchange rate, clients, traffic, token assumptions, template volume and support allowance. It makes no API calls and does not change any provider account.
