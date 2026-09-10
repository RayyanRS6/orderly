# Account setup status — September 10, 2026

- Supabase project `Orderly`: `zygsuxgqkeedgcbjhfzx`, MeeruRayyan Free organization. Automatic Asia-Pacific placement selected Sydney (`ap-southeast-2`); Vercel functions now target `syd1`.
- Both initial SQL migrations applied successfully together in a transaction through the SQL editor. Live verification: 13 public tables, all 13 with RLS enabled. SQL editor execution does not populate Supabase CLI migration history; do not blindly push these migrations again.
- Existing anon and service-role keys saved in ignored local `.env`. Verified anon cannot read companies (401); service role reads the empty companies table (200).
- Gemini `Orderly server` key saved in ignored local `.env`. Model listing returned 200 and includes `gemini-2.5-flash-lite`. No generation test yet. This key belongs to existing Google project `gen-lang-client-0579034647` and shares project quota with Proofix.
- Local app remains in demo mode, preserving existing demo data. Founder `waytogalaxy999@gmail.com` was created and confirmed by the user; platform-admin membership is enabled for `03df5c0d-9a6c-4d15-a899-bdf0ba180489`.
- Private GitHub repository `https://github.com/RayyanRS6/orderly` created and code pushed using the existing RayyanRS6 Git Credential Manager login. Credential scan found none of the saved keys in tracked source.
- Vercel recognizes the GitHub repository; import form is prepared but project/deployment creation remains pending. Secret environment prepared in ignored `.local/vercel.env`; browser file upload is blocked by the extension's file-access setting, so credentials have not been uploaded to Vercel. Vercel account currently uses Hobby; checked-in every-minute recovery cron needs Pro before deployment as configured. No paid upgrade purchased.
- Google Sheets service account and spreadsheet remain pending.
- WhatsApp remains blocked by Meta developer registration contact-verification loop. User submitted a bug report.

Account assignments: Supabase/Vercel `waytogalaxy999@gmail.com`; GitHub `RayyanRS6` / `meerurayyan@gmail.com`; Google services `meerubmellow@gmail.com`.

Never commit `.env` or `.local`. The temporary loopback setup helper is in ignored `.local/setup-server.cjs`; stop it after collecting credentials.
