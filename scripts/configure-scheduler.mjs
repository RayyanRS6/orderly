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
const { error } = await client.rpc('configure_orderly_scheduler', {
  p_worker_url: `${env.SUPABASE_URL}/functions/v1/orderly/api/jobs/process`,
  p_worker_token: env.CRON_SECRET,
});
if (error)
  throw new Error(
    'Scheduler configuration failed. Apply the scheduler migration and check server credentials.',
  );
const { data, error: checkError } = await client.rpc('orderly_scheduler_status');
if (checkError || !data?.configured || !data?.recoveryScheduled)
  throw new Error('Scheduler is not ready. Inspect its migration and Vault configuration.');
console.log(JSON.stringify(data));
