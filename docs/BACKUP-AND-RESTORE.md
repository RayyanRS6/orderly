# Database backups and the restore drill

Updated 18 October 2026. Supabase stays on the **Free plan for the pilot**, and Free has no automatic backups. Until the plan changes, these backups are the only copy of the restaurants' orders, chats, logins and encrypted credentials. Take one before every hand-applied SQL migration, and let Windows take one every night.

## 1. What a backup holds

`npm run backup:db` writes a folder `.local/backups/db-<UTC time>/` with:

| File            | Contents                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roles.sql`     | Custom database roles (Supabase's own roles are left out, as `supabase db dump` does).                                                                |
| `schema.sql`    | Tables, functions, policies and grants as they are **in production** (not as the migration files say: SQL is applied by hand, so the two can differ). |
| `data.sql`      | Every row, including `auth.users` (logins), memberships, orders, conversations, the encrypted credentials and the `cron.job` schedule.                |
| `manifest.json` | Time, tool version, file sizes and SHA-256 checksums. No connection details.                                                                          |

The backup contains customer names, numbers, addresses and chats, plus encrypted Meta, AI and Sheets credentials. From Auth it also keeps the sign-in records (`auth.audit_log_entries`, with the IP addresses of owners and staff) and authenticator apps (`auth.mfa_factors`). It leaves out the live sign-in sessions, refresh tokens and one-time codes (`auth.sessions`, `auth.refresh_tokens`, `auth.mfa_amr_claims`, `auth.mfa_challenges`, `auth.one_time_tokens`, `auth.flow_state`), so a leaked backup cannot reuse a live sign-in session and everyone signs in again after a restore. It still holds every account's password hash (`auth.users`), the token hashes behind recent invite and password-reset emails, and the authenticator secrets, so a leaked plain backup means new passwords and new authenticator setups for every account, and older backups also hold the live sessions: the [incident runbook](INCIDENT-RUNBOOK.md) §3 says what to do if one leaks. Treat the folder like the customers' data itself: encrypt it, copy it off the laptop, and delete old plain copies (section 4).

It does **not** hold: Supabase Vault secrets (the worker token; Vault is encrypted per project), Edge Function secrets, the Railway gateway volume (it has its own backups, `gateway/RAILWAY.md` §8) or anything in Google Sheets. `CREDENTIAL_ENCRYPTION_KEY` is needed to read the stored credentials after a restore: keep it in the password manager, separately from the backups.

## 2. One-time setup

1. **Install pg_dump.** Install the PostgreSQL 17 client tools: `winget install PostgreSQL.PostgreSQL.17`, or the EDB installer with only **Command Line Tools** ticked. The script finds `C:\Program Files\PostgreSQL\<version>\bin` by itself; elsewhere, add the folder to PATH or set `PG_BIN` to it. Version 17 also dumps a Postgres 15 project; an older pg_dump than the server refuses to run.
   - Without pg_dump the script falls back to `supabase db dump`. That command runs pg_dump inside a Docker container, also on Windows, so it needs Docker Desktop running. pg_dump is the simpler choice on a laptop.
2. **Get the connection string.** Supabase → **Connect** → **Session pooler** (port 5432). Do not use the Transaction pooler (6543), and do not use the direct `db.<ref>.supabase.co` host: it needs IPv6, which many home connections lack.
3. **Save it encrypted for your Windows account** (DPAPI, so only you on this laptop can read it). In PowerShell, from the repository folder:

   ```powershell
   Read-Host 'Session pooler connection string' -AsSecureString | ConvertFrom-SecureString | Set-Content .local\db-url.dpapi
   ```

   Never put it in a plain `.env` file, a chat or a screenshot.

4. **Make an encryption key pair for backups.** Install age (`winget install FiloSottile.age`), then:

   ```powershell
   age-keygen -o .local\orderly-backup-key.txt
   ```

   Copy the line starting `# public key: age1…` into `.local\backup-recipient.txt` (only the `age1…` part). Move `orderly-backup-key.txt` into the password manager (as a secure note or attachment) and delete it from `.local`. Only the public key stays on the laptop, so a stolen laptop cannot open the off-laptop copies. Never create the key in the Desktop, Documents or a OneDrive or Google Drive folder: those can sync it next to the encrypted backups.

5. **Pick an off-laptop folder**, for example a personal OneDrive or Google Drive sync folder, or a USB drive. Below it is `D:\OrderlyBackups`. A sync folder keeps a deleted file in its recycle bin for about 30 more days; the privacy policy says so. Do not use a work or school OneDrive: it can keep deleted files for up to 93 days, longer than the policy says.

## 3. Take a backup by hand (always before pasting SQL)

```powershell
$secure = Get-Content .local\db-url.dpapi | ConvertTo-SecureString
$env:SUPABASE_DB_URL = [System.Net.NetworkCredential]::new('', $secure).Password
npm run backup:db
Remove-Item Env:SUPABASE_DB_URL
```

It prints one line per file and the folder name. It fails with a plain message (and removes the incomplete folder) when the connection string is wrong, pg_dump is missing or too old, or the dump lacks `public.companies` or `auth.users`. Then encrypt it and copy it off the laptop (the same commands the nightly task in section 4 runs; change the folder path), and only then paste the migration:

```powershell
$latest = Get-ChildItem '.local\backups' -Directory -Filter 'db-*' | Sort-Object Name | Select-Object -Last 1
$tarball = Join-Path $env:TEMP "$($latest.Name).tar.gz"
tar -czf $tarball -C $latest.FullName .
age -R '.local\backup-recipient.txt' -o (Join-Path 'D:\OrderlyBackups' "$($latest.Name).tar.gz.age") $tarball
Remove-Item $tarball
```

Run any other SQL-editor work as read-only (`begin; set transaction read only; …; rollback;`).

## 4. Nightly backup with Windows Task Scheduler

Save this as `.local\backup-db-task.ps1` (`.local` is ignored by Git), and change the two folder paths:

```powershell
$ErrorActionPreference = 'Stop'
Set-Location 'C:\Meeru\Works\My chatbot for daddy'
$offsite = 'D:\OrderlyBackups'
$secure = Get-Content '.local\db-url.dpapi' | ConvertTo-SecureString
$env:SUPABASE_DB_URL = [System.Net.NetworkCredential]::new('', $secure).Password
try { npm run backup:db; if ($LASTEXITCODE -ne 0) { throw 'backup failed' } }
finally { Remove-Item Env:SUPABASE_DB_URL -ErrorAction SilentlyContinue }
$latest = Get-ChildItem '.local\backups' -Directory -Filter 'db-*' | Sort-Object Name | Select-Object -Last 1
$tarball = Join-Path $env:TEMP "$($latest.Name).tar.gz"
tar -czf $tarball -C $latest.FullName .
age -R '.local\backup-recipient.txt' -o (Join-Path $offsite "$($latest.Name).tar.gz.age") $tarball
Remove-Item $tarball
# Keep two plain copies on the laptop and 14 days of encrypted copies off it.
Get-ChildItem '.local\backups' -Directory -Filter 'db-*' | Sort-Object Name | Select-Object -SkipLast 2 | Remove-Item -Recurse -Force
Get-ChildItem $offsite -Filter 'db-*.age' | Where-Object LastWriteTime -lt (Get-Date).AddDays(-14) | Remove-Item
```

Register it once (PowerShell, as yourself, not as administrator):

```powershell
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\Meeru\Works\My chatbot for daddy\.local\backup-db-task.ps1"'
$trigger = New-ScheduledTaskTrigger -Daily -At 3:30am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable
Register-ScheduledTask -TaskName 'Orderly nightly database backup' -Action $action -Trigger $trigger -Settings $settings
```

`-StartWhenAvailable` runs a missed backup when the laptop is next on. The task runs as you, which DPAPI needs. Check it the next morning: Task Scheduler → **Orderly nightly database backup** → Last Run Result `0x0`, and a new `.age` file in the off-laptop folder. If a backup is older than about 26 hours, find out why that day.

The privacy policy (`src/components/Legal.tsx`, `BACKUP_DAYS` and "How long we keep it") states what this task does: 14 days of encrypted copies, only the two newest plain copies on the laptop (including any taken by hand), and up to 30 more days in a sync folder's recycle bin. Change both together. Old copies are removed only when this task runs: if it stops running (Last Run Result not `0x0`), delete plain folders older than two days from `.local\backups` and `.age` files older than 14 days by hand until it is fixed. The task removes only `db-*` folders: any other plain export kept in `.local\backups` (for example one taken by hand before a migration, such as `pre-gateway-migration-…`) stays until you delete it. Delete such exports, or encrypt them off the laptop first as in section 3, as soon as they are not needed; `Get-ChildItem .local\backups -Directory | Where-Object Name -notlike 'db-*'` must print nothing before a dashboard deploy publishes the policy ([DEPLOYMENT.md](DEPLOYMENT.md) §7, step 4).

## 5. Restore drill (do it once now, then after big schema changes)

Rehearse in a **separate** Supabase project, never in production. The drill must never send a WhatsApp message, email or AI request.

1. **Create the drill project:** Supabase → New project, name `orderly-restore-drill`, same region (Sydney) and the same Postgres major version as production (Settings → Infrastructure). Free allows two active projects.
2. **Keep everything switched off there.** Do **not** deploy the `orderly` function, set any Edge Function secret, run `scripts/configure-scheduler.mjs`, configure Auth SMTP, connect Railway or add Resend keys. In **Database → Extensions** turn on `pg_cron` and `pg_net` (the restored schema expects them).
3. **Decrypt a backup** into a temporary folder: `age -d -i <key file from the password manager> -o db.tar.gz <file>.age`, then `tar -xzf db.tar.gz`.
4. **Restore**, with the drill project's own Session pooler string in `$env:DRILL_DB_URL` (from the drill project, not production). The last command removes the restored cron schedule inside the same transaction, so no job ever runs there:

   ```powershell
   psql --single-transaction --variable ON_ERROR_STOP=1 --file roles.sql --file schema.sql --command 'SET session_replication_role = replica' --file data.sql --command 'select cron.unschedule(jobid) from cron.job' --dbname $env:DRILL_DB_URL
   ```

5. **Check and record** (a short note in `.local/restore-drill-<date>.md`; no personal data in it):
   - `select public.orderly_scheduler_ready();` returns **false** (the worker token did not come across).
   - `select count(*) from cron.job;` returns **0**.
   - These counts match the same query run on production (read-only) right after the backup: `select (select count(*) from public.companies) companies, (select count(*) from public.orders) orders, (select count(*) from public.conversations) conversations, (select count(*) from auth.users) users, (select count(*) from public.company_memberships) memberships;`
   - The time from starting the restore to the checks passing, and anything that failed or was missing.
6. **Delete the drill project** (Settings → General → Delete project) and the decrypted folder once the note is written.

If the restore stops on an error, nothing is half-applied (single transaction). Note the error, fix the cause (usually a missing extension or a newer pg_dump than psql), and run it again.

## 6. Restoring production for real

Only after a real loss, and after telling the restaurants (docs/INCIDENT-RUNBOOK.md):

1. Pause every bot first (or set `ORDERLY_PAUSE_AUTOMATION=on`), so nothing is sent while data is missing.
2. Take a fresh backup of whatever is left, even if damaged.
3. If only some rows are wrong, restore the backup into a drill project as above and copy back only the damaged rows. Restoring over production discards every order taken since the backup.
4. If the project is gone, create a new one, restore as in section 5 **without** the `cron.unschedule` command, set every Edge Function secret again from the password manager (the same `CREDENTIAL_ENCRYPTION_KEY`, or stored credentials cannot be read), deploy the function, run `node scripts/configure-scheduler.mjs <env file>`, point the frontend (`VITE_API_BASE_URL`), Meta webhooks and the gateway's `ORDERLY_EVENTS_URL` at the new project, then test one order end to end before turning bots back on.
