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

Optional: **Wait for CI** makes Railway wait for GitHub checks before deploying. It waits for
_every_ check on the commit, so a failing backend workflow also blocks a gateway deploy.

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

In Orderly → **Integrations**, accept the risk notice and start QR or phone-code pairing with
the restaurant owner. On the phone: WhatsApp → **Linked devices** → **Link a device**. Keep
automatic replies paused until the live acceptance checklist in [README.md](README.md) passes.

Afterwards, Orderly's **Agent flow** page shows **Last heartbeat** for the connection. The gateway
reports once a minute, so it should stay under about 75 seconds; over 3 minutes means Orderly
treats WhatsApp as offline.

## 11. Running it: risks and caveats

- **Every redeploy means short downtime and a WhatsApp reconnect.** That includes pushes to
  the watch paths, variable edits and backup restores: Railway stops the old container before
  mounting the volume on the new one. Sends during the gap fail as unreachable; a send cut off
  mid-way reports `SEND_UNCERTAIN` and staff must check the phone. Redeploy in quiet hours.
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
- **Unofficial linked device.** This is not Meta's official API. WhatsApp may restrict or ban
  the number (Railway uses shared datacenter IPs), and the protocol can change. Keep the
  official Meta connection available as a fallback.
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
