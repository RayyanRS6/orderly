# Orderly linked-device gateway (pilot)

Orderly-owned WhatsApp transport using pinned Baileys **6.7.22**. No n8n, paid gateway,
AI model, catalog, cart, or order logic runs here. The existing Orderly backend remains
the only business-logic authority. Official Meta connections remain supported.

## Status and boundaries

- Code includes QR + phone-number pairing, encrypted persistent auth, one child process
  per connection, signed callbacks/commands, durable message deduplication, generation
  fences, manual-phone takeover, uncertain-send protection, and bounded reconnects.
- **Pilot limit: 10 active numbers per gateway; one active route per restaurant.** This
  is an operational safety limit, not a Baileys subscription quota. It is not a measured
  ten-account production capacity guarantee. The ten-process automated test uses fake
  sockets, not ten real WhatsApp accounts.
- Text only. Voice notes/images trigger staff handoff; staff use the WhatsApp phone app
  to inspect them. Authenticated media playback and transcription are not part of v1.
- Only live `notify` events are ingested. History, groups, newsletters, status broadcasts,
  protocol events, reactions and placeholder-resend events are excluded. Offline history
  is deliberately not replayed as new customer orders. Verify staff-phone echoes in the
  live pilot; protocol behavior may change.
- Native LIDs remain identities, not phone numbers. Mapping uses authenticated contact
  and phone-number-share events. Unknown phone numbers are displayed as unavailable.
- Unofficial automatic replies are limited by Orderly to 24 hours after a customer message.
  This is our conservative policy, not a claim that Meta's template API exists here.
- No claim of WhatsApp approval, unlimited capacity, ban prevention, or guaranteed delivery.
  Meta may change the protocol or restrict accounts. Keep the official route available.

## Deployment prerequisites

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
- Reply on the restaurant phone during a slow bot turn: the bot must pause; its own echoes
  must not pause it. Resume only from Orderly's staff controls.
- Interrupt/restart the gateway. Verify encrypted credentials restore without new pairing,
  queued inbound events retry once, and uncertain sends do not automatically resend.
- Simulate network loss, logout and competing-session errors. Verify bounded retry and
  actionable status. A logged-out account requires fresh pairing.
- Switch Meta → linked device → Meta with pending jobs. No old job may send via the new route.
- Confirm sandbox messages generate no WhatsApp sends or Sheet order rows.
- Test load and reconnect behavior progressively before expanding from one authorized number.

## Failure handling

Each child owns one socket and SQLite database. A fatal child error exits; the supervisor
restarts only that child up to five times. 401 clears authentication and requires pairing;
440/403/411/500 and unknown codes stop reconnecting. 515 restarts the socket with retained
credentials. 408/428/503 retry with bounded exponential backoff and jitter. A healthy socket
resets network retries after two minutes. An explicit owner reconnect resets process retries.

Heartbeats reach Orderly every 15 seconds; a heartbeat older than 90 seconds is not ready to
send. The gateway must also report a verified account identity. Backend callback failure
keeps inbound events encrypted on disk, capped at 10,000 per session; a full queue stops
the session for investigation. Monitor disk, stale heartbeats, `SESSION_CRASH`, queue failures
and failed Orderly jobs. `/healthz` indicates process liveness, not every number's readiness.

Outbound records reserve the WhatsApp message ID before sending and suppress that ID's echo.
After an uncertain outcome, automatic retries return `SEND_UNCERTAIN`; staff must inspect the
phone. Do not delete receipt records to force a resend. Exactly-once delivery cannot be
guaranteed across an external messaging service, but duplicate blind retries are prevented.

Disconnect stops the local socket and invalidates credentials/jobs. The owner should also
remove the old session under WhatsApp → Linked devices; local disconnection is not a promise
that Meta's companion-device entry was revoked. Orders and Orderly chat history remain.

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
