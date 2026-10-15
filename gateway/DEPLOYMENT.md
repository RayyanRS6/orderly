# Gateway launch runbook (hosting can wait)

The gateway, HTTPS configuration, setup helper and test suite can be prepared without
buying a server. **Prepared does not mean deployed or real-phone verified.** Do not enable
customer traffic until every acceptance gate below has passed. No script here provisions
a paid resource, applies a production migration, or pairs a WhatsApp number automatically.
Hosting on Railway instead of a VPS: see [RAILWAY.md](RAILWAY.md).

## 1. What will be needed later

- An always-on Ubuntu 24.04 x64 VPS. Start with one authorized number on the proposed
  2 GB host. The production overlay budgets 1,280 MiB for the gateway and 128 MiB for HTTPS,
  leaving memory for the OS. The generic Compose file's 2 GB cap is for larger hosts.
  These are limits, not guarantees of workload capacity. Do not raise the one-number
  default before measuring RSS/CPU, peak message load and reconnect behavior.
- Docker Engine and Compose v2 installed using the official Ubuntu instructions:
  https://docs.docker.com/engine/install/ubuntu/
- A DNS hostname controlled by the operator, e.g. `gateway.yourdomain.com`, pointing to
  the server's public IPv4. The frontend's `*.workers.dev` hostname is **not** a domain
  you can repoint to a VPS. If you do not own a domain, settle on a stable HTTPS hostname
  before launch; the VPS purchase does not automatically provide one.
- SSH public-key access; keep private keys on the operator's device, never in this repo.
  Enable provider account MFA. Restrict inbound SSH to trusted administrator IPs and open
  TCP 80/443 for certificate issuance and backend calls. Never open 8080 or 2019 publicly.
  Use the provider firewall as well as host controls: Docker-published ports can bypass
  some UFW rules. Gateway 8080 remains bound to host loopback only.
- Authorized Supabase project access, an owner-controlled WhatsApp number and a second
  consenting test sender. Test with fictional order/customer details.

No need to move the frontend, database or main backend. Only this transport runs on the VPS.

## 2. Prepare the release locally (no hosting or accounts required)

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

On a machine with Docker, additionally:

```sh
docker build -f gateway/Dockerfile -t orderly-gateway:test .
npm run test:container --prefix gateway
```

The container smoke test uses random temporary credentials, an isolated anonymous volume,
and no WhatsApp sessions. It checks non-root/read-only operation, persistent SQLite across
restart, signed health and nonce replay rejection. Its disposable container/volume are
removed when finished. It never uses a production `.env` file or connects to Supabase.
The GitHub gateway-check workflow also validates the HTTPS config and Compose structure.
Pushing main still deploys the existing app; it does **not** deploy this gateway or migrate
the database. Do not push just to run Docker checks if app deployment is not intended.

## 3. Configure only after a hostname is chosen

Use Node.js 24 and run from `gateway/`:

```sh
npm run configure -- --hostname gateway.yourdomain.com --email ops@yourdomain.com --events-url https://PROJECT.supabase.co/functions/v1/orderly/api/whatsapp/gateway/events
npm run doctor
```

Replace all example values first. The helper generates separate cryptographically random
signing/encryption keys, defaults to one restaurant number, and creates `.env` exclusively
with mode 0600. It **refuses to overwrite** existing credentials. It does not print them,
provision anything or make network requests. On Windows, restrict the file using NTFS ACLs;
POSIX mode flags are not Windows access controls. The real file is ignored by Git and Docker.

Transfer this file over SSH/SFTP to `gateway/.env` on the host, set mode 0600 and restrict
repository access to trusted operators. Keep the encryption key in a separate password
manager. Do not paste `.env`, `docker inspect`, or full `docker compose config` output into
chat, CI logs or support tickets. Compose can expand secret values into those outputs.
Use `docker compose ... config --quiet` for validation.

## 4. Migration gate (manual, not bundled with server startup)

1. Back up the existing Supabase database and verify the recovery procedure.
2. Compare applied migration history with the repository. Review the pending changes;
   do not blindly apply every file to an existing project.
3. Apply `supabase/migrations/202609200001_whatsapp_gateway.sql` using the project's
   reviewed migration process. It expects the earlier Orderly schema migrations.
4. Verify the private connection/nonce tables and service-role-only functions exist,
   and existing Meta traffic still behaves correctly. The local PGlite tests cover the
   migration but do not certify production's current schema or migration history.

Keep `WHATSAPP_GATEWAY_ENABLED=false` until HTTPS and the migration are verified.
The backend deployment workflow intentionally does not apply production SQL automatically.

## 5. Start on the server

Deploy an explicitly tested commit/release, not an unreviewed branch tip. From `gateway/`:

```sh
docker compose -f compose.yaml -f compose.production.yaml config --quiet
docker compose -f compose.yaml -f compose.production.yaml up -d --build
docker compose -f compose.yaml -f compose.production.yaml ps
```

The Caddy sidecar provisions and renews HTTPS certificates; its TLS state is on a persistent
volume. DNS must resolve to this server and port 80/443 must be reachable. Start with a
DNS-only record while verifying origin HTTPS. No host Docker socket is mounted into either
container. Gateway messages, pairing QR/codes and signed headers must not be access-logged.

The gateway has a bounded global overload guard (120-request burst, 10 requests/second
refill), body-size limits and timeouts. All customers on the host share this guard; a 429
means back off, not switch provider. This is not protection against a volumetric DDoS.
Use provider network protections and review metrics before raising limits.

From your local `gateway/` directory, with the matching private `.env`:

```sh
npm run doctor -- --online
```

The online check requires trusted HTTPS and verifies unsigned rejection, signed health
and replay protection. It does not send messages. A successful check proves transport
reachability, **not** correct database migration, callback configuration or WhatsApp delivery.

## 6. Connect the backend and perform live acceptance

In Supabase's server-only secrets, set:

```text
WHATSAPP_GATEWAY_URL=https://gateway.yourdomain.com
WHATSAPP_GATEWAY_SECRET=<the GATEWAY_SHARED_SECRET from the private gateway file>
WHATSAPP_GATEWAY_ENABLED=true
```

Never set these as frontend `VITE_` variables. Never upload `GATEWAY_ENCRYPTION_KEY` to the
frontend or use a Supabase service-role key as the shared signing secret. The encryption key
is only needed on the gateway and in the operator's recovery vault.

Open Orderly's Integrations screen, pair with the restaurant owner's permission, and keep
automatic replies paused until the live checklist in `README.md` passes. Verify both QR and
code, staff takeover, bot-echo suppression, unknown LIDs, reconnect, confirmed orders, Sheets
deduplication and sandbox isolation. Prove the callback heartbeat reaches Orderly; local
`/healthz` by itself says nothing about callback success. No real-number claims until tested.

## 7. Backups, monitoring and updates

- Take a consistent backup **with the gateway stopped**, including the full named data
  volume (SQLite, WAL and SHM together). For a first pilot, a stopped-server snapshot is
  simpler than selectively copying active SQLite files. This creates downtime: schedule it.
- Ensure backups are encrypted at rest with restricted access. Provider snapshots may cost
  extra; confirm the cost and encryption/access guarantees before enabling them. Row values
  are encrypted, but database metadata is not. Keep the encryption key separately.
- Document retention and rehearse restore on an isolated host with outbound WhatsApp and
  callback access blocked. Never run an original and restored clone simultaneously. Do not
  use `docker compose down -v`; that destroys credentials and TLS state.
- Monitor container restarts, disk space, CPU/RAM, public HTTPS liveness, callback heartbeat
  age and failed jobs. Set billing alerts. Neither this code nor a paid VPS supplies an
  operator on call or a guarantee against WhatsApp account restrictions.
- For upgrades, run checks first, back up, record the current commit/image, stop the old
  gateway and start the new release against the same volume. Brief downtime is expected.
  Do not run overlapping replicas. Verify health and callbacks before resuming traffic.
- To roll back, pause replies and restore the last tested image/config with the same data
  only if storage compatibility is established. Do not blindly reverse database migrations
  or restore an old snapshot over newer orders. Follow the README's protocol-version policy.

## Ready-to-launch sign-off

- [ ] App/gateway tests and frontend/Edge builds pass for the exact release.
- [ ] Docker image build, container smoke and Caddy/Compose validation pass.
- [ ] Host purchased/approved; SSH, firewall, DNS and trusted HTTPS verified.
- [ ] Encrypted backup and recovery procedure verified; secrets kept private.
- [ ] Reviewed database migration applied and legacy official route checked.
- [ ] Backend secrets configured; signed health and callbacks verified.
- [ ] Owner-approved QR/code pairing and complete real-phone acceptance pass.
- [ ] One-number pilot measured before expanding; owner explicitly enables replies.

Until these boxes are verified, call the system **prepared for deployment**, not live-ready.
