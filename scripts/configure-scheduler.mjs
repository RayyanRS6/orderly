import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/configure-scheduler.mjs <ignored-server-env-file>');
const env = parse(readFileSync(path));
for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CRON_SECRET'])
  if (!env[key]) throw new Error(`Missing ${key} in server environment file.`);
const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
// What went wrong, without the keys. Migrations are never re-applied to fix this: on the existing
// project they were applied by hand, and the older files refuse to run again.
function explain(error, step) {
  if (['PGRST202', '42883'].includes(error.code))
    return `The database has no ${step} function. Check which migrations this project has (docs/DEPLOYMENT.md §1) before applying anything, and never re-apply the folder.`;
  // configure_orderly_scheduler's own checks: the URL or the token is not acceptable.
  if (error.code === 'P0001')
    return `The database refused the scheduler settings: ${error.message}. Check SUPABASE_URL and CRON_SECRET in the env file.`;
  return `The ${step} call failed (${error.code || 'no code'}). Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the env file, then retry.`;
}
const { error } = await client.rpc('configure_orderly_scheduler', {
  p_worker_url: `${env.SUPABASE_URL}/functions/v1/orderly/api/jobs/process`,
  p_worker_token: env.CRON_SECRET,
});
if (error)
  throw new Error(
    `Scheduler configuration failed. ${explain(error, 'configure_orderly_scheduler')}`,
  );
const { data, error: checkError } = await client.rpc('orderly_scheduler_status');
if (checkError)
  throw new Error(`Scheduler check failed. ${explain(checkError, 'orderly_scheduler_status')}`);
if (!data?.configured || !data?.recoveryScheduled)
  throw new Error(
    `Scheduler is not ready: ${JSON.stringify({ configured: !!data?.configured, recoveryScheduled: !!data?.recoveryScheduled })}. Check the Vault secrets and the orderly-recover-jobs schedule (select jobname, active from cron.job).`,
  );
console.log(JSON.stringify(data));
