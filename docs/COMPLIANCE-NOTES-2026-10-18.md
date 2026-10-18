# Compliance notes, 18 October 2026

These notes record the outside rules that were checked on **18 October 2026** for the pilot, how Orderly meets each one and what is still open. They are an engineer's reading of the sources, **not legal advice**. Items marked **Lawyer** need a Pakistani lawyer before launch decisions rely on them.

Scope, from the owner's decisions of 18 October 2026: restaurants operate in **Punjab and Islamabad**; each restaurant is the **data controller** and Orderly processes data on its behalf; payments are cash or manual JazzCash, Easypaisa and bank transfers checked by staff outside Orderly, so Orderly takes no payments and asks for no payment details (the order confirmation and the menu page tell customers to pay cash at pickup or on delivery; a transfer is arranged with the restaurant); both WhatsApp routes (official Cloud API and the linked phone) are in use.

"Orderly today" describes the software with the pre-launch fixes of 18 October 2026 deployed (branch `audit/prelaunch-2026-10-18`: AI notice at the start of each chat, the "staff" keyword, OpenAI `store: false`, the Gemini billing confirmation, admin-enabled linked-phone pairing with recorded consent). Until they are live, those points are not yet true in production.

Certainty: **high** = read in the primary source; **medium** = secondary sources (news, law-firm or council summaries) or a primary source that may be out of date; **low** = applicability unclear.

## 1. WhatsApp and Meta

### 1.1 Linked phone (unofficial gateway) and WhatsApp's terms

- **Rule:** the WhatsApp Business App terms effective 23 September 2026 do not allow apps that interact with the service without WhatsApp's prior written consent. The consumer WhatsApp Terms of Service also forbid access through unauthorised or automated means (the version seen showed an effective date of 4 January 2021; a newer one may exist).
- **Source:** the WhatsApp Business App terms and WhatsApp Terms of Service on whatsapp.com/legal (exact URLs were not recorded in the research notes). Checked 2026-10-18.
- **Certainty:** high that the linked phone breaches the Business App terms.
- **Orderly today:** the official Cloud API is the supported route and is listed first in the guides. The dashboard notice and consent box say plainly that the linked phone is against WhatsApp's terms, that WhatsApp can ban the whole number (temporarily or permanently, including the restaurant's own app) and that messages are decrypted on Orderly's gateway on Railway. New pairings need the platform admin to enable the business, and the owner's consent is recorded. Replies stay inside the 24-hour window; no templates or broadcasts; history sync and online presence are off.
- **Open:** decide whether to keep offering the route; obtain written, informed consent from each linked restaurant; move linked restaurants to the Cloud API with coexistence. **Lawyer:** the operator's own exposure for running the gateway.

### 1.2 Meta Terms for WhatsApp Business Platform, section 4.7 (AI providers) and section 4.1(b)

- **Rule:** the ban on AI providers applies where AI is the main thing on offer; a business may use an AI provider as a Solution Provider, but WhatsApp Business Platform data (including derived data) must not be used to "create, develop, train, or improve" AI models. Section 4.1(b) limits sharing with third parties other than Solution Providers.
- **Source:** <https://www.facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform>, last modified 23 September 2026. Checked 2026-10-18.
- **Certainty:** high for the text; likely that a restaurant ordering bot (AI as a side feature) is allowed, but Meta decides.
- **Orderly today:** Orderly does not train models on chats. The Terms of Service require each business to use a paid AI plan whose terms forbid training, with no data-sharing opt-in, and forbid free Gemini keys with real customers. OpenAI calls are sent with response storage off (`store: false`).
- **Open:** **Lawyer / Meta:** whether the AI providers, Google Sheets and Resend count as permitted Solution Providers under section 4.1(b). Confirm each live business's AI plan.

### 1.3 WhatsApp Business Messaging Policy

- **Rule:** automated experiences need "prompt, clear, and direct escalation paths" to a person; businesses must not ask people to share full payment card numbers, financial account numbers or national ID card numbers.
- **Source:** <https://whatsappbusiness.com/policy/>, last updated 23 September 2026. Checked 2026-10-18.
- **Certainty:** high.
- **Orderly today:** customers are told at the start of a chat that they are talking to the restaurant's AI assistant and that typing "staff" reaches a person; staff can take over any chat; the Cloud API review message has a "Talk to staff" button. Orderly never asks for card, bank or CNIC numbers, and the Terms forbid businesses from asking for them in chat. A number a customer types anyway is kept with the chat until it is deleted; the privacy policy asks customers not to send them.
- **Open:** a fixed instruction in the AI prompt never to ask for card, bank or CNIC numbers (owner-written instructions are free text today).

### 1.4 Meta Commerce Policies

- **Rule:** alcohol and "tobacco products and related paraphernalia" may not be sold. Whether shisha or hookah counts is not stated.
- **Source:** <https://www.facebook.com/policies_center/commerce/>. Checked 2026-10-18.
- **Certainty:** high for alcohol and tobacco.
- **Orderly today:** the Terms forbid listing items WhatsApp's commerce rules prohibit.
- **Open:** no menu warning for such items yet; tell restaurants not to list them.

### 1.5 Template review and pricing

- **Rule:** templates cannot start or end with a parameter and need enough fixed text per parameter. Utility templates inside an open service window are free; Pakistan has its own rates, raised on 1 April 2026.
- **Source:** <https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-review/> and <https://developers.facebook.com/docs/whatsapp/pricing>. Checked 2026-10-18.
- **Certainty:** high for the rules; medium on whether the current status template's trailing full stop is enough.
- **Orderly today:** the template is UTILITY, never MARKETING; there is no broadcast feature.
- **Open:** resubmit a fuller order-status template; check the current Pakistan utility rate before quoting costs.

## 2. AI providers

### 2.1 Anthropic Usage Policy: tell people they are talking to AI

- **Rule:** consumer-facing chatbots "must disclose to users that they are interacting with AI rather than a human", "at a minimum at the beginning of each chat session".
- **Source:** <https://www.anthropic.com/legal/archive/22742366-2ef0-4c7a-a833-6523f10d3944> (effective 15 September 2025); the version effective 12 November 2026 keeps it: <https://www.anthropic.com/legal/aup>. Checked 2026-10-18.
- **Certainty:** high.
- **Orderly today:** a fixed, localised notice that the owner cannot remove opens each chat session, and the privacy policy says replies are written by an automated assistant that uses AI. The notice itself uses the rule's word: "<Restaurant>'s AI assistant", then says to type "staff" anytime to talk to a person (Urdu "اے آئی اسسٹنٹ", Roman Urdu "AI assistant"; `src/domain/disclosure.ts`). A chat told in the earlier "automated assistant" wording within the last day is not told again.
- **Open:** OpenAI's and Google's own disclosure rules were not verified; Orderly shows the notice for every provider anyway.

### 2.2 Anthropic and OpenAI API data use

- **Rule:** Anthropic: API data is "never used for model training without your express permission", deleted from the backend within 30 days. OpenAI: not used for training unless the organisation opts in; abuse-monitoring logs up to 30 days; the Responses API also stores responses for 30 days by default unless `store: false` is sent.
- **Source:** <https://platform.claude.com/docs/en/manage-claude/api-and-data-retention>, <https://privacy.claude.com/en/articles/7996866>, <https://developers.openai.com/api/docs/guides/your-data>, <https://developers.openai.com/api/docs/guides/migrate-to-responses>. Checked 2026-10-18.
- **Certainty:** high.
- **Orderly today:** each business uses its own key; OpenAI calls send `store: false`; the privacy policy names the provider as a recipient.
- **Open:** each owner confirms no data-sharing or training opt-in is on in their provider account.

### 2.3 Google Gemini API: unpaid services

- **Rule:** data sent to Unpaid Services is used to "provide, improve, and develop" Google products, "human reviewers may read" it, and users must not submit personal information. Paid terms apply only through a Cloud project with active billing.
- **Source:** <https://ai.google.dev/gemini-api/terms>, effective 23 March 2026, last updated 28 April 2026. Checked 2026-10-18.
- **Certainty:** high.
- **Orderly today:** the Terms of Service and the deployment guide forbid free Gemini keys with real customers; connecting Gemini asks the owner to confirm billing is on.
- **Open:** Orderly cannot check a key's billing tier. Confirm each live Gemini business's project is billed.

## 3. Processors' own terms

| Provider   | What was found (checked 2026-10-18)                                                                                                                   | Open                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Supabase   | DPA v1 of 1 August 2026 is part of the terms on acceptance and includes the EU standard contractual clauses (<https://supabase.com/legal/dpa>). High. | None.                                       |
| Railway    | The DPA must be signed through DocuSign (<https://railway.com/legal/dpa>). High.                                                                      | [OWNER TO CONFIRM: signed?] Sign it if not. |
| Cloudflare | Not fetched.                                                                                                                                          | Read and accept its data-processing terms.  |
| Resend     | Not fetched.                                                                                                                                          | Read and accept its data-processing terms.  |

Each restaurant is the controller; Orderly is its processor. **Lawyer:** a short written data-processing agreement between Orderly and each restaurant (what Orderly does with the data, sub-processors above, breach notice, deletion on exit).

## 4. Pakistan

### 4.1 Personal Data Protection Bill: not law

- **Finding:** Pakistan's Personal Data Protection Bill has **not been enacted**. The IT ministry's legislation page lists only drafts (2018, 2020 and May 2023), and the Chambers 2026 guide says it has not passed both houses. There are no statutory registration, data-protection-officer or data-localisation duties today.
- **Source:** <https://moitt.gov.pk/Legislations> and <https://practiceguides.chambers.com/practice-guides/data-protection-privacy-2026/pakistan>. Checked 2026-10-18.
- **Certainty:** likely (medium to high).
- **Orderly today:** the privacy policy, retention controls, export and erase tools and the breach commitment follow good practice, not a statute.
- **Open:** **Lawyer:** watch for enactment, and whether its draft cross-border and breach rules would need changes before it passes.

### 4.2 Prevention of Electronic Crimes Act (PECA) 2016

- **Rule:** PECA covers spam and direct marketing (unsubscribe), unauthorised use of identity information (s.16), and may require a "service provider" to keep specified traffic data for at least one year "within its existing or required technical capability".
- **Source:** UNODC eEvidence country fiche <https://sherloc.unodc.org/cld/uploads/pdf/El%20Evidence%20Hub/SOUTH_ASIA/eEvidence_Country_Fiche_PAKISTAN.pdf>; the National Assembly PDFs of the Act and the 2025 amendment could not be read. Checked 2026-10-18.
- **Certainty:** low on whether Orderly is a "service provider"; section numbers differ between sources.
- **Orderly today:** no marketing messages or broadcasts; the menu page never messages a number typed on the web (the customer sends the order code from their own WhatsApp), and only a keyed hash of that number is stored. Owners can delete chats after 30 days or on request.
- **Open:** **Lawyer:** whether Orderly is a PECA service provider, whether any traffic-data retention period has been notified for it, and the PECA (Amendment) Act 2025 "social media platform" definition. If it applies, a metadata-only log kept for a year would need a migration.

### 4.3 Telecom spam rules (PTA) and the Electronic Transactions Ordinance 2002

- PTA's spam regulations bind telecom licensees (SMS and voice), not apps such as WhatsApp; Orderly sends no SMS. Source: <https://digitalrightsmonitor.pk/pta-restricts-telemarketers-with-promotional-text-messages/> (secondary). Certainty: likely.
- The Electronic Transactions Ordinance 2002 (listed at <https://moitt.gov.pk/Legislations>) recognises electronic records. Orders need an explicit confirmation and are stored with timestamps. Certainty: medium.

### 4.4 Sales tax on restaurant orders (Punjab and Islamabad)

- **Punjab (Punjab Revenue Authority):** restaurant services 16% when paid in cash; 8% for digital payments from July 2026, citing PRA notification PRA/Member Legal/816/26 of 2 July 2026 (the notification itself was not seen). Restaurants are being brought onto PRA e-invoicing (point-of-sale integration). Sources: Business Recorder <https://www.brecorder.com/news/40432594>, Dawn <https://www.dawn.com/news/1880030>. Certainty: medium.
- **Islamabad (FBR):** 15% cash and 5% digital per FBR circular 2 of 2023-24 (<https://download1.fbr.gov.pk/Docs/20237211773220909CircularNo.02of2023-24.pdf>), which may be out of date. Certainty: low to medium.
- **Orderly today:** Orderly has no tax setting. It quotes exactly the prices the owner entered and the Terms make the restaurant responsible for whether prices include sales tax and for receipts or tax invoices. The pilot's payments are cash or manual transfers, so the rate depends on how the customer pays, outside Orderly.
- **Open:** each restaurant confirms its menu prices already include sales tax (and its menu label says so), and staff enter every Orderly order in their PRA- or FBR-integrated point of sale. **Lawyer / tax adviser:** whether WhatsApp and menu-page orders must show tax on the order total or carry a fiscal invoice number, and whether Finance Act 2025 rules on digitally ordered goods reach a restaurant's own WhatsApp ordering. Sindh rates were also researched but do not apply to the pilot.

### 4.5 Consumer protection (price display and receipts)

- **Punjab Consumer Protection Act 2005:** s.18 (prices exhibited) and s.19 (receipt). Source: Punjab Consumer Protection Council guidance <https://pcpc.punjab.gov.pk/guidelines>. Certainty: medium (exact wording not seen).
- **Islamabad Consumers Protection Act 1995:** the price-display and receipt sections were not found in primary text. Certainty: low.
- **Orderly today:** the customer sees an itemised summary with prices, delivery fee and total before confirming, and an order reference after; the menu page shows prices and delivery fees.
- **Open:** **Lawyer:** whether the WhatsApp order summary meets the receipt requirement, or whether the restaurant must still hand over a receipt with its name and address.

### 4.6 Cash on delivery and transfers

- No State Bank rule was found that restricts restaurant cash on delivery. The FBR PKR 200,000 cash cap is an income-tax deductibility rule, and the Finance Act 2025 cash-on-delivery withholding falls on couriers and payment intermediaries, not on Orderly. Source: KPMG brief <https://assets.kpmg.com/content/dam/kpmg/pk/pdf/2025/07/A-Brief-on-Finance-Act-2025.pdf>. Certainty: medium.
- Orderly takes no payments and asks for no payment details. The order confirmation and the menu page tell customers to pay cash at pickup or on delivery; a JazzCash, Easypaisa or bank transfer is arranged with the restaurant and checked by its staff outside Orderly.

## 5. Checked and found in order (18 October 2026)

- Meta webhooks are verified with HMAC-SHA256 over the raw body with a timing-safe compare; unknown numbers still get 200 so Meta does not retry.
- The 24-hour reply window is enforced; outside it only the utility template is used.
- Blocked numbers are dropped before anything is saved; staff takeover, bot pause and blocks stop queued automatic replies.
- Photos, videos, documents and voice notes are never downloaded, stored or sent to the AI, and menu product photos are not sent to it either. A caption and a shared location become chat text: a location is its place name, address and coordinates. That text is stored with the chat and sent to the business's AI provider like any customer message, now and in the recent history of later turns, as the privacy policy says. Only the cart's own name and address fields reach the AI as "[collected]"; an address in a shared location or typed in the chat reaches it as written.
- Staff alert emails (Resend) carry no customer data; stored credentials use AES-256-GCM. Server and gateway logs are built to carry no customer data (a failure logs codes and at most 300 characters of scrubbed error text); still to be confirmed in the live function and Railway logs after deploy.
- The Anthropic prompt cache covers only the fixed business instructions, for 5 minutes.
- A daily purge (`purge_orderly_operations`, 05:41 in Pakistan) deletes activity logs (traces) and delivery receipts never linked to a chat after 90 days, and clears the contents of finished jobs after 14 days. A job that failed for good keeps its contents (for example a reply's text and the customer's number) until staff retry it or the customer's details are erased. The privacy policy says the same.

## 6. Questions for a local lawyer

1. The WhatsApp terms and the linked phone: the operator's exposure, and wording for written, informed consent from each restaurant.
2. Meta platform terms: Solution Provider status of the AI providers, Google Sheets and Resend (section 4.1(b)), given that the AI provider receives customers' typed addresses and the place name, address and coordinates of shared locations; the incident-reporting duty to Meta.
3. The Personal Data Protection Bill: status, and what to prepare before it passes. It is not law today.
4. PECA: whether Orderly is a service provider; traffic-data retention; the 2025 amendment.
5. Punjab Revenue Authority and Islamabad (FBR) rules on showing sales tax on order totals and fiscal invoices for WhatsApp and menu-page orders; Finance Act 2025 digital-order rules.
6. The Punjab 2005 and Islamabad 1995 consumer-protection acts: price display and receipts for WhatsApp orders.
7. The privacy policy's controller and processor wording, international transfers, the breach-notice commitment and its timing, and a data-processing agreement with each restaurant.
