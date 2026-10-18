# Orderly linked-device gateway (pilot)

Orderly-owned WhatsApp transport using pinned Baileys **6.7.22**. No n8n, paid gateway,
AI model, catalog, cart, or order logic runs here. The existing Orderly backend remains
the only business-logic authority. Official Meta connections remain supported.

## Status and boundaries

- Code includes QR + phone-number pairing, encrypted persistent auth, one child process
  per connection, signed callbacks/commands, durable message deduplication, generation
  fences, manual-phone takeover, uncertain-send protection, and backed-off reconnects.
- **Pilot limit: 10 active numbers per gateway; one active route per restaurant.** This
  is an operational safety limit, not a Baileys subscription quota. It is not a measured
  ten-account production capacity guarantee. The ten-process automated test uses fake
  sockets, not ten real WhatsApp accounts.
- Text only. A photo, video or document caption reaches the bot as text marked "(sent with a
  photo)" and so on; a location pin becomes "Location shared: <place> (lat, long)", and a live
  location is read the same way, from the position it was shared with (its caption as the place).
  Voice notes, stickers, contacts and uncaptioned media trigger staff handoff; staff use the
  WhatsApp phone app to inspect them. Media is never downloaded; playback and transcription are
  not part of v1.
- Every message is judged on its own, whatever the batch type. History, groups, newsletters,
  status broadcasts, protocol events and reactions are excluded, and messages older than 24
  hours are not replayed as new orders. A customer message that arrives here without content
  (WhatsApp's "unavailable" placeholder, or a decryption failure) is held: the phone's resend or
  the sender's retry is filed under the same chat, and a copy that turns out to be a reaction,
  an edit or a deletion just ends the hold. If nothing comes within 45 seconds staff get a
  handoff saying Orderly could not read a message (check the phone); a copy that still arrives
  later reaches Orderly under its own ID. Verify staff-phone echoes in the live pilot; protocol
  behavior may change.
- Native LIDs remain identities, not phone numbers. Mapping uses the `sender_pn`/`sender_lid`
  WhatsApp attaches to customer messages, plus authenticated contact and phone-number-share
  events. An existing chat is never moved by a later mapping; two chats that already exist
  for one customer stay apart (logged as `ROUTE_CONFLICT`). Unknown phone numbers are displayed
  as unavailable.
- Unofficial automatic replies are limited by Orderly to 24 hours after a customer message.
  This is our conservative policy, not a claim that Meta's template API exists here.
- **The risk, as the dashboard states it to the owner:** this unofficial method is against
  WhatsApp's terms. WhatsApp can ban the whole number, temporarily or permanently, and the
  restaurant's own WhatsApp app on that number stops working too. Messages are decrypted and
  processed on Orderly's gateway on Railway, and sent replies are kept there, encrypted, for up
  to 3 days. No claim of WhatsApp approval, unlimited capacity, ban prevention or guaranteed
  delivery; Meta may change the protocol at any time. Move each restaurant to the official
  Cloud API with coexistence (the WhatsApp Business app keeps working) as soon as it can.
- A new pairing is possible only for a business the Orderly admin has enabled for linked-phone
  pairing, and only after the owner accepts the risk notice; Orderly records who accepted which
  version of it, and when. An admin revoke blocks every further pairing for that business; only
  a business from before approvals whose linked phone is still in use may pair it again without
  approval.

## Deployment prerequisites

For the prepared HTTPS stack, private configuration generator, preflight checks and exact
launch gates, use [DEPLOYMENT.md](DEPLOYMENT.md). Hosting can be purchased later. Run
`npm run configure` / `npm run doctor` only after building the gateway. Neither provisions
a server. The production overlay reserves OS memory on a 2 GB pilot VPS and starts with
one number when using the generated configuration. Hosting on Railway instead of a VPS:
see [RAILWAY.md](RAILWAY.md).

Use an always-on Linux host with Docker, a persistent volume, working outbound HTTPS/WebSockets,
an HTTPS reverse proxy, encrypted host backups, and monitoring. **Do not deploy this Node
service inside Supabase Edge or the existing frontend Worker.** No host is provisioned by
the application deployment workflows. The Compose 2 GB cap is a starting budget, not a
promise it accommodates ten busy numbers; measure RSS, CPU, disk and message latency.

1. Review/apply `supabase/migrations/202609200001_whatsapp_gateway.sql` to the existing
   database using the normal migration process. Back up first. The current backend deploy
   workflow deploys code only; it does **not** run `supabase db push`.
2. Copy `gateway/.env.example` to `gateway/.env` on the host and replace all placeholders.
   Generate independent random signing and encryption secrets. Never use the Supabase
   service-role key as a gateway signing key. Preserve the encryption key separately from
   the data backup; losing it requires re-pairing all numbers.
3. Build/start from this directory:

   ```sh
   docker compose up -d --build
   ```

4. Put an HTTPS reverse proxy in front of `127.0.0.1:8080`, with a 32 KB request limit,
   request-rate limits and no request/response body logging. Disable caching. Only `/healthz`
   is unauthenticated; all other routes require timestamped HMAC signatures. Restrict network
   access where your hosting permits. Do not expose a browser-accessible administration port.
5. Set backend secrets (not `VITE_` variables):

   ```text
   WHATSAPP_GATEWAY_URL=https://gateway.your-domain.example
   WHATSAPP_GATEWAY_SECRET=<same random value as GATEWAY_SHARED_SECRET>
   WHATSAPP_GATEWAY_ENABLED=true
   ```

   `ORDERLY_EVENTS_URL` must be the deployed backend's complete
   `/functions/v1/orderly/api/whatsapp/gateway/events` URL. The shared key authenticates
   callbacks without a Supabase user JWT; Orderly's function uses its existing custom
   authentication (`verify_jwt=false`). No restaurant/company ID is trusted from events.
6. In Orderly → Integrations, accept the risk notice and start QR or code pairing with an
   authorized restaurant owner. The route switch pauses automatic replies. Complete the
   checklist below before enabling them again.

Without the flag/host, the UI explains why pairing is unavailable. Before migration, a
disabled feature tolerates only the missing new table when reading legacy connections; other
database errors fail closed. Creating/changing/disconnecting a WhatsApp connection requires
the migration so old queued replies can be fenced safely.

## Live acceptance checklist — required before customers

- Pair by QR and by code on actual phones; verify the resulting account, not just typed input.
- Send a menu question and complete an explicitly confirmed order. Verify real prices and
  exactly one Sheet row (when Sheets is connected).
- Test a native LID customer with and without a phone mapping. Ensure no LID becomes a phone.
  Check that replies to a chat mapped from LID to phone number (or back) are delivered.
- Send a captioned photo and a location pin from a customer phone: the bot reads the caption and
  the place; a voice note or sticker goes to staff. Share a live location for a few minutes: the
  bot should get it once, not once per position update.
- Reply on the restaurant phone during a slow bot turn: the bot must pause; its own echoes
  must not pause it. Resume only from Orderly's staff controls.
- WhatsApp Business app **greeting and away messages** are sent by the phone and reach Orderly
  like a staff reply, so they pause the bot for that chat (WhatsApp marks them no differently).
  Ask the owner to turn them off (Business tools → Greeting message / Away message) and use
  Orderly's own greeting instead. Test once from a number that has never chatted, with the
  greeting on and then off, and resume any chat it paused.
- Interrupt/restart the gateway. Verify encrypted credentials restore without new pairing,
  queued inbound events retry once, and uncertain sends do not automatically resend.
- Simulate network loss, logout and competing-session errors. Verify the session keeps retrying
  (status `reconnecting`) and recovers by itself once the network is back, and that the status
  is actionable. A logged-out account requires fresh pairing.
- Switch Meta → linked device → Meta with pending jobs. No old job may send via the new route.
- Confirm sandbox messages generate no WhatsApp sends or Sheet order rows.
- Test load and reconnect behavior progressively before expanding from one authorized number.

## Failure handling

Each child owns one socket and SQLite database. A fatal child error exits; the supervisor
restarts only that child, with a backoff that grows to at most 30 minutes and never gives up.
The child's own failure code (for example `INBOUND_QUEUE_FULL`) is kept instead of a generic
`SESSION_CRASH`. Ten minutes of healthy connection forgets earlier crashes. 401 clears
authentication and requires pairing; 403/405/411/440 stop reconnecting (405 needs a new
`GATEWAY_WA_VERSION`, 440 means another copy took over). 515 restarts the socket at once with
retained credentials. 408/428/503 retry without limit, backing off from 1 second to 1 minute
and then every 5 minutes; 500, 0 and unknown codes do the same from a 5-second start. A connect
that neither opens nor fails within 45 seconds is abandoned and retried. The status stays
`reconnecting` with `DISCONNECT_<code>` meanwhile. A healthy socket resets network retries after
two minutes.

These retries are for numbers that finished pairing. A pairing nobody finishes ends as
`PAIRING_EXPIRED` and its worker exits, freeing the place: when its QR codes run out (408), on
a second failure (the first, if a pairing code was already shown) or after 5 minutes. The owner
starts a new pairing.

A gateway restart brings back sessions that finished pairing and were `connected`, `connecting`
or `reconnecting`, or that an older version parked in `error` with a passing failure code:
`RECONNECT_EXHAUSTED`, `SESSION_CRASH`, `EVENT_STORAGE_FAILURE`, `SESSION_HANDLER_FAILURE`,
`SEND_HANDLER_FAILURE`, `UNCAUGHT_EXCEPTION`, `UNHANDLED_REJECTION`, `INBOUND_QUEUE_FULL`,
`SESSION_CAPACITY_REACHED`, or any `DISCONNECT_<code>` that is retried (all but 401, 403, 405,
411 and 440). A pairing that never finished, including the abandoned ones older versions kept
retrying, becomes `PAIRING_EXPIRED` instead. At most `GATEWAY_MAX_SESSIONS` start, numbers that
were connected first; the rest wait as `SESSION_CAPACITY_REACHED` and start once a place frees.

Heartbeats reach Orderly once a minute (the 15-second tick still retries undelivered events); a
heartbeat older than 3 minutes is not ready to send. The gateway must also report a verified
account identity. Backend callback failure keeps inbound events encrypted on disk, capped at
10,000 per session; a full queue stops the session until it drains. A message Orderly rejects
outright (400/413/422) no longer blocks the ones behind it: it is set aside (at most 500, cleared
on new pairing), offered again hourly while under 24 hours old, and meanwhile the connected status
carries `INBOUND_EVENT_REJECTED` (check the restaurant phone for that customer). Message IDs over
150 characters are hashed before queueing. Monitor disk, stale
heartbeats, crash codes, queue failures and failed Orderly jobs. `/healthz` indicates process
liveness, not every number's readiness.

Outbound records reserve the WhatsApp message ID before sending and suppress that ID's echo.
After an uncertain outcome, automatic retries return `SEND_UNCERTAIN`; staff must inspect the
phone. Do not delete receipt records to force a resend. Exactly-once delivery cannot be
guaranteed across an external messaging service, but duplicate blind retries are prevented.

Disconnect and new pairing first log the linked device out of WhatsApp (best effort, at most
3.5 seconds, only while the socket is connected and only for a finished pairing), then wipe
credentials and jobs, so leftover credentials and later backups stop working. Redeploys,
restarts and a lost lease only close the socket and keep the pairing. If the session was offline
at the time, the logout cannot happen: the owner should still check WhatsApp → Linked devices
and remove the old session. Orders and Orderly chat history remain.

If the owner switches to the official route or disconnects while the gateway cannot be reached,
Orderly saves the change anyway and the old session keeps running here, linked to the phone.
Orderly answers its next event or heartbeat (within a minute while it is connected) with 410,
and the gateway then ends it as a disconnect would: logout, then wipe (logged as
`SESSION_RETIRED`). Until the gateway is reachable again, removing the device under Linked
devices on the phone is the immediate remedy.

## Protocol updates and rollback

Dependencies are pinned by `gateway/package-lock.json`. Install with `npm ci`. Do not use a
floating Baileys version or automatically promote `fetchLatestBaileysVersion()` fleet-wide.

`npm run build && npm run version:check` prints the bundled and upstream candidate tuple
without modifying anything. Test a candidate on an authorized canary before configuring
`GATEWAY_WA_VERSION`. Successful connections cache the last-good tuple, scoped to library
6.7.22. Selection is explicit override → matching last-good cache → library default. Never
silently try arbitrary protocol versions. To roll back, set the last approved tuple explicitly
and restore the last tested image/lockfile. Re-test QR, code pairing, LIDs and staff echoes
after any library upgrade. A protocol tuple does not upgrade the library's message schemas.

## Storage, backup, privacy and scaling

Auth, mapping, queue and receipt values use AES-256-GCM with row-specific authenticated data.
QRs/codes stay in process/UI memory and are not persisted to SQL, browser storage or logs.
SQLite metadata (row IDs, namespaces and counts) is not encrypted; use full-disk encryption
and encrypted backups as well. Acknowledged inbound payloads are deleted from the gateway.
Auth/identity metadata and deduplication receipts remain until disconnect/new pairing; use
host backup retention policies and remove obsolete backups after approved erasure requests.
The gateway has a separate privacy boundary: Orderly's database-only customer erasure does
not purge old host backups. Do not promise otherwise.

Back up the volume with the container stopped, so SQLite/WAL files form a consistent snapshot.
Keep the encryption key in a separate secret manager. Test restoration on an isolated host
with WhatsApp network access disabled first. Never run a restored copy against WhatsApp while
the original is active. A database lease prevents two supervisors using the same volume, but
it cannot detect copied volumes on different hosts. After a crash it may take 45 seconds for
the lease to expire. Run exactly one gateway instance per volume.

More than ten clients requires measured capacity planning, gateway placement/routing per
connection, host-level resource isolation, distributed ownership leases and staged rollout.
Merely increasing the constant or adding load-balanced replicas is unsafe. Hosting, AI usage,
operations and protocol maintenance still cost money even without a gateway subscription.

## Development checks

From the repository root:

```sh
npm ci
npm ci --prefix gateway
npm run build --prefix gateway
npm test --prefix gateway
npm test
npm run build
npm run test:edge-runtime
```

The gateway CI also builds the Docker image. These checks do not authenticate a real number.
Baileys is MIT-licensed; the locked `libsignal` dependency declares GPL-3.0. Preserve dependency
license notices and review the obligations before distributing gateway images/software.
