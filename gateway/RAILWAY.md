# Hosting the gateway on Railway

This runbook deploys the WhatsApp linked-device gateway as **one Docker service with one
persistent volume** in the existing, empty, private Railway project **"order work"**. It
replaces the VPS + Caddy setup in [DEPLOYMENT.md](DEPLOYMENT.md): Railway provides HTTPS
and the public hostname. Everything else in DEPLOYMENT.md (migration gate, live acceptance,
sign-off) still applies. **Prepared does not mean deployed or real-phone verified.**

Railway no longer reads `railway.json` / `railway.toml` for new services, so every setting
below is entered in the Railway dashboard or as a service variable. Dashboard section names
can move slightly; the Settings page has a search box.

> **Secrets rule:** never paste `gateway/.env`, a secret value, the Railway Variables page or
> a screenshot of it into chat, an AI assistant, a support ticket, an issue or CI logs. Copy
> values only between `gateway/.env`, your password manager, Railway and Supabase.

## 0. Before you start

- **Railway plan: Hobby or higher.** The Trial/Free plans cannot use the **Always** restart
  policy and have tighter memory/volume limits.
- Node.js **24** on your computer, plus this repository checked out.
- A password manager for the encryption key.
- Access to the Supabase project `zygsuxgqkeedgcbjhfzx` (Sydney, `ap-southeast-2`), with
  `APP_MODE=live` already set for the `orderly` function.
- The restaurant owner's permission and phone for pairing (step 10).

## 1. Connect GitHub and create the service

1. Open the **order work** project in Railway.
2. Click **+ Create** (or **Add a service**) → **GitHub Repo**.
3. If Railway asks, click **Connect GitHub** / **Configure GitHub App**. In GitHub's own
   window, grant the Railway app access to the private repository **RayyanRS6/orderly** only.
   You must do this yourself; it is an OAuth permission on your GitHub account.
4. Select **RayyanRS6/orderly**. Railway creates a service and starts a first build at once.
   **That first build is expected to fail or build the wrong app** (the variables below are
   not set yet). Ignore it.
5. Rename the service to `gateway` (click its name).

## 2. Service settings

Open the `gateway` service → **Settings** and set:

| Setting                            | Value                                                                                                                  | Why                                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Source → Branch                    | `main`                                                                                                                 | Deploy only the reviewed branch.                                                                                              |
| Source → Root Directory            | **leave blank**                                                                                                        | The Dockerfile copies shared files from the repo root. `/gateway` breaks the build.                                           |
| Build → Watch Paths                | `/gateway/**`<br>`!/gateway/**/*.md`<br>`/src/shared/whatsapp.ts`<br>`/server/whatsapp/signing.ts`<br>`/.dockerignore` | Otherwise every frontend/backend push (or a docs edit) redeploys the gateway, and each redeploy disconnects WhatsApp briefly. |
| Deploy → Custom Start Command      | **leave empty**                                                                                                        | The image's entrypoint must run (it fixes volume ownership and drops root).                                                   |
| Deploy → Healthcheck Path          | `/healthz`                                                                                                             | Unauthenticated liveness endpoint.                                                                                            |
| Deploy → Restart Policy            | **Always**                                                                                                             | Comes back after any crash.                                                                                                   |
| Deploy → Serverless (app sleeping) | **Off**                                                                                                                | A sleeping gateway drops WhatsApp.                                                                                            |
| Deploy → Region                    | Australia/Sydney if listed; otherwise the nearest (usually Southeast Asia / Singapore)                                 | Close to Supabase. Pick it **now**: the volume is tied to its region.                                                         |
| Deploy → Replicas                  | **1**                                                                                                                  | Never more than one instance per volume.                                                                                      |
| Deploy → Resource Limits → Memory  | about **1 GB** (if your plan shows it)                                                                                 | Caps cost; one number needs far less.                                                                                         |

A push to `main` with a commit that changes a watch path rebuilds the gateway from that commit,
while the backend workflow may still be testing the same push. **Wait for CI** (Settings →
Source) makes Railway wait for GitHub checks before deploying. It waits for _every_ check on the
commit, including the backend's `deploy` job and **Check WhatsApp gateway**, so the gateway
never goes live before the backend from the same push; a commit with a red check is not deployed
at all, so a failing backend workflow (or docs test) also holds a gateway deploy back. Keep it
on. It is required for the October 2026 release, which goes out as one push
([DEPLOYMENT.md §7](../docs/DEPLOYMENT.md), steps 5 and 6).

Project-level: **Project Settings → Environments → PR Environments: Off.** A pull-request
environment would start a second gateway with the same secrets.

## 3. Public HTTPS domain

1. `gateway` → **Settings → Networking → Public Networking → Generate Domain**.
2. When asked for the port, enter **8080**.
3. Note the hostname, e.g. `orderly-gateway-production.up.railway.app`. Below it is called
   `<name>.up.railway.app`. Railway serves it over HTTPS automatically; there is no Caddy.

## 4. Generate the gateway secrets on your computer

From the repository root (PowerShell or a terminal), with Node 24:

```sh
npm ci; npm ci --prefix gateway; npm run build --prefix gateway; cd gateway
npm run configure -- --hostname <name>.up.railway.app --email <you@your-email> --events-url https://zygsuxgqkeedgcbjhfzx.supabase.co/functions/v1/orderly/api/whatsapp/gateway/events
npm run doctor
```

- `configure` creates the private file `gateway/.env` with a random signing secret
  (`GATEWAY_SHARED_SECRET`) and encryption key (`GATEWAY_ENCRYPTION_KEY`). It prints neither.
  The email is required by the tool but unused on Railway.
- `doctor` must print `PASS: private configuration ...`. It works offline.
- If `configure` says it **refuses to overwrite**, a `gateway/.env` already exists. If no
  gateway ever ran with it, open it in a text editor and change only the `GATEWAY_HOSTNAME=`
  line to `<name>.up.railway.app`; keep the keys. Never rotate keys on a gateway that has
  paired numbers (they would all need re-pairing).
- **Copy `GATEWAY_ENCRYPTION_KEY` into your password manager now.** If it is lost, every
  number must be paired again. Keep `gateway/.env` private (on Windows, restrict it with
  NTFS permissions); it is ignored by Git and Docker.

## 5. Variables

`gateway` → **Variables → Raw Editor**, paste this block, then replace the two `<...>`
placeholders with the values from `gateway/.env` (open the file in a text editor; do not
paste it anywhere else):

```text
PORT=8080
GATEWAY_SHARED_SECRET=<GATEWAY_SHARED_SECRET from gateway/.env>
GATEWAY_ENCRYPTION_KEY=<GATEWAY_ENCRYPTION_KEY from gateway/.env>
ORDERLY_EVENTS_URL=https://zygsuxgqkeedgcbjhfzx.supabase.co/functions/v1/orderly/api/whatsapp/gateway/events
GATEWAY_MAX_SESSIONS=1
RAILWAY_DOCKERFILE_PATH=gateway/Dockerfile
RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30
RAILWAY_HEALTHCHECK_TIMEOUT_SEC=300
RAILWAY_RUN_UID=0
```

What each line does:

- `PORT=8080`: Railway's healthcheck calls the port in `PORT`; the gateway listens on 8080
  (`GATEWAY_PORT=8080` is already set inside the image).
- `GATEWAY_SHARED_SECRET`, `GATEWAY_ENCRYPTION_KEY`: from `gateway/.env`, exactly, no quotes or
  spaces. After saving, use each variable's menu → **Seal** if offered, so the value is hidden
  in the dashboard (sealed values cannot be viewed again; your copies are in `.env` and the
  password manager).
- `ORDERLY_EVENTS_URL`: where the gateway sends incoming messages and heartbeats.
- `GATEWAY_MAX_SESSIONS=1`: one restaurant number for the pilot. The code default is 10, so
  set it explicitly.
- `RAILWAY_DOCKERFILE_PATH=gateway/Dockerfile`: build this Dockerfile from the repo root.
  Without it Railway tries to build the frontend instead.
- `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30`: on redeploy Railway waits up to 30 s after SIGTERM,
  so the gateway closes WhatsApp cleanly and releases its data-volume lease. The default (0)
  kills it at once; the next start then waits up to about a minute (log `GATEWAY_LEASE_WAIT`).
- `RAILWAY_HEALTHCHECK_TIMEOUT_SEC=300`: leaves room for that wait.
- `RAILWAY_RUN_UID=0`: Railway mounts volumes owned by root, which the image's normal user
  cannot write. With this, the container _starts_ as root only so the entrypoint can give
  `/data` to the unprivileged `node` user (uid 1000); it then drops to `node` with `setpriv`
  before the gateway starts. The gateway itself never runs as root.

Do not add `GATEWAY_HOSTNAME`, `ACME_EMAIL` or `GATEWAY_DATA_DIR`; they are not needed here.
Railway collects edits as staged changes; don't deploy yet.

## 6. Volume

1. In the project canvas: **+ Create → Volume** (or right-click the canvas).
2. Attach it to **gateway** with mount path **`/data`** (exactly).
3. Now click **Deploy** / **Apply changes** at the top of the canvas.

`/data` holds the encrypted WhatsApp credentials and queues. Never attach this volume, or the
secrets above, to any other service.

## 7. Verify the deployment

1. **Deployments → View logs**: the build uses `gateway/Dockerfile`; the deploy becomes
   **Active**; there is no `SUPERVISOR_FATAL`, `SUPERVISOR_REJECTION` or `EACCES`. A single
   `GATEWAY_LEASE_WAIT` line after a forced stop is normal.
2. In a browser open `https://<name>.up.railway.app/healthz`. Expected: `{"ok":true}`.
3. From `gateway/` on your computer:

   ```sh
   npm run doctor -- --online
   ```

   Expected: `PASS: HTTPS, signed health, unsigned rejection and replay protection; 0/1 workers.`
   This proves HTTPS reachability and matching secrets only, not callbacks or WhatsApp delivery.

## 8. Backups

`gateway` → the volume → **Backups**: enable **Daily** and **Weekly** schedules. Backups cost
volume storage for changed data. Row values are encrypted, but SQLite metadata is not, and a
backup is useless without the encryption key from your password manager. Restoring a backup
replaces the volume and redeploys. Never run a restored copy anywhere while the original is live.
A backup holds working WhatsApp credentials for every number paired at that time. Disconnecting in
Orderly logs the device out when WhatsApp can be reached, also for a session that was stopped,
which makes those credentials useless; if it could not, remove the device on the phone as well.
Restoring an older backup also brings back sessions disconnected since. Keep backup retention
short.

## 9. Connect Orderly (Supabase side)

1. **Migration:** back up the Supabase database, then apply
   `supabase/migrations/202609200001_whatsapp_gateway.sql` through the reviewed migration
   process in DEPLOYMENT.md §4. CI and backend deploys do **not** apply migrations.
2. **Secrets** (server-only; never `VITE_` variables). In the Supabase dashboard
   (**Edge Functions → Secrets**) or with `npx supabase secrets set --project-ref zygsuxgqkeedgcbjhfzx ...`:

   ```text
   WHATSAPP_GATEWAY_URL=https://<name>.up.railway.app
   WHATSAPP_GATEWAY_SECRET=<the same value as GATEWAY_SHARED_SECRET>
   WHATSAPP_GATEWAY_ENABLED=true
   ```

   The URL is the origin only: no path, no trailing slash. Set `WHATSAPP_GATEWAY_ENABLED=true`
   last, after the migration and step 7 pass. The dashboard avoids leaving the secret in your
   shell history. Never use the Supabase service-role key as the gateway secret, and never put
   `GATEWAY_ENCRYPTION_KEY` in Supabase.

3. `APP_MODE` must already be `live`; otherwise Orderly treats the gateway as unavailable.

## 10. Pair the restaurant number

Only a business the Orderly admin has enabled for linked-phone pairing can pair (`PUT
/api/admin/businesses/:companyId/linked-device` with `{"allowed": true}`, or the audited SQL in
[DEPLOYMENT.md §4](../docs/DEPLOYMENT.md); a business already on a linked phone keeps it).
An admin revoke (`{"allowed": false}`, recorded as `admin.linked_device.revoked`) blocks every
further pairing for that business, including pairing its own phone again; its current session
keeps working until it ends. Without an admin decision either way, only a business from before
approvals whose linked phone is still in use (connected, connecting, reconnecting or waiting for
its pairing to finish) may pair it again without approval; one that disconnected, was logged out
or failed needs approval like any other. In Orderly → **Integrations**, go through the risk notice with the restaurant owner: this
unofficial method is against WhatsApp's terms, WhatsApp can ban the
whole number temporarily or permanently, including the restaurant's own WhatsApp app, and
messages are decrypted on Orderly's gateway on Railway. The owner ticks the consent box, and
Orderly records who accepted which version of the notice, and when. Then start QR or
phone-code pairing. On the phone: WhatsApp → **Linked devices** → **Link a device**. Keep
automatic replies paused until the live acceptance checklist in [README.md](README.md) passes,
and ask the owner to turn off the Business app's greeting and away messages.

Afterwards, Orderly's **Agent flow** page shows **Last heartbeat** for the connection. The gateway
reports once a minute, so it should stay under about 75 seconds; over 3 minutes means Orderly
treats WhatsApp as offline.

## 11. Running it: risks and caveats

- **Every redeploy means short downtime and a WhatsApp reconnect.** That includes pushes to
  the watch paths, variable edits and backup restores: Railway stops the old container before
  mounting the volume on the new one. Sends during the gap fail as unreachable; a send cut off
  mid-way reports `SEND_UNCERTAIN` and staff must check the phone. Redeploy in quiet hours.
- **Backend first, then the gateway.** With **Wait for CI** on (§2), a push that changes both
  deploys the gateway only after the backend from the same push is live. For the October 2026
  release either order is still safe, with one short window ([DEPLOYMENT.md §7](../docs/DEPLOYMENT.md),
  step 6, says why). This gateway with the older backend: that backend still refuses
  linked-phone replies once the last heartbeat is over 90 seconds old, while this gateway reports
  about once a minute, so replies are refused, and retried a few seconds later, only while
  heartbeats cannot reach Orderly for about 20 seconds or more; nothing is retired, since an
  older backend never answers 410. An older gateway with this backend: its 15-second heartbeats
  stay well inside the 3-minute limit; a session Orderly answers with 410 (no longer used) stays
  queued there, retried every 15 seconds, until this version starts and ends it.
- **Switched or disconnected while the gateway was down.** Orderly saves the change anyway and
  the old session keeps running here, linked to the phone, until the gateway reaches Orderly
  again: its next event or heartbeat is answered 410 and the gateway logs it out and wipes it
  (`SESSION_RETIRED` in the logs). A session that sends nothing (stopped on a refusal such as
  `DISCONNECT_405`) is not reached that way: press **Disconnect** again once the gateway is
  reachable (`SESSION_DISCONNECTED` in the logs). Until then, remove the device on the phone
  under WhatsApp → **Linked devices**. Never delete the business's rows before one of those
  lines appears ([incident runbook](../docs/INCIDENT-RUNBOOK.md) §6): Orderly then no longer
  knows the session, answers its events with 200, and nothing ends it.
- **A business deleted with Delete business** (People page, from
  `202610220001_business_deletion.sql`). Orderly presses Disconnect itself first and deletes
  nothing until the gateway confirms it. It also keeps the business's connection ids, so any later
  event or heartbeat of that session is answered 410, as for a retired one, and the gateway logs
  it out and wipes it (`SESSION_RETIRED`). Any other connection Orderly does not know is still
  answered 200: that alone is not proof enough to end it.
- **Never two instances on one volume.** Keep replicas at 1, PR environments off, and don't
  duplicate the service or environment with these secrets. A lease blocks a second gateway on
  the same volume, but cannot detect copies elsewhere.
- **`/healthz` is liveness only.** Railway checks it only during deploys, and it stays 200 even
  if the gateway lost its lease or a number disconnected. Watch **Last heartbeat** on the Agent
  flow page and the connection status in Integrations.
- **Key custody.** The encryption key and the encrypted data now live in the same Railway
  account. Keep the key in your password manager as well; enable Railway account 2FA.
- **Reduced container hardening.** Railway cannot apply the Compose file's read-only root
  filesystem, dropped capabilities or process limits. The gateway still runs as `node` and
  writes only to `/data`.
- **Unofficial linked device.** This is not Meta's official API and is against WhatsApp's
  terms. WhatsApp can ban the whole number, temporarily or permanently, including the
  restaurant's own WhatsApp app on it (Railway's shared datacenter IPs add to the risk), and
  the protocol can change. Messages are decrypted on this gateway, and sent replies are kept
  here, encrypted, for up to 3 days. Move each restaurant to the official Cloud API with
  coexistence as soon as it can.
- **Cost (estimate, not measured):** Hobby is $5/month including $5 of usage. One number should
  use roughly $3-5/month of RAM/CPU/volume, so about **$5-6/month in total**. Each extra number
  adds a worker process. Check Railway's pricing page and set a usage alert/limit.

## Troubleshooting

| Symptom                                                                 | Fix                                                                                                                                                                                                            |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build log shows Railpack/Nixpacks building the Vite app                 | `RAILWAY_DOCKERFILE_PATH=gateway/Dockerfile` missing, or Root Directory not blank.                                                                                                                             |
| Build: `gateway/src` or `server/whatsapp/signing.ts` not found          | Root Directory must be blank.                                                                                                                                                                                  |
| Crash with `EACCES` on `/data`                                          | `RAILWAY_RUN_UID=0` missing; the log also says `GATEWAY_DATA_DIR is not writable`.                                                                                                                             |
| Crash: `Configure gateway secret, encryption key and HTTPS events URL.` | A secret has quotes/spaces, the key is not the exact base64 value, or the URL is wrong.                                                                                                                        |
| Healthcheck never passes                                                | `PORT=8080` missing.                                                                                                                                                                                           |
| Deploy is Active but the public URL fails                               | Networking → the domain's target port must be 8080.                                                                                                                                                            |
| Every redeploy asks to pair the number again                            | The volume is not mounted at exactly `/data`, so data was lost with the old container.                                                                                                                         |
| `Another gateway owns this data volume.` after about a minute           | Another instance still holds the lease: check replicas, duplicate services or environments.                                                                                                                    |
| `npm run doctor -- --online` fails                                      | Hostname in `gateway/.env` differs from the Railway domain, or the Railway secret differs from `.env`.                                                                                                         |
| Pairing shows `DISCONNECT_405`                                          | WhatsApp rejected an outdated web version. In `gateway/` run `npm run version:check`, set the `candidate` tuple as `GATEWAY_WA_VERSION` (for example `2,3000,1043857760`), redeploy, then start a new pairing. |
