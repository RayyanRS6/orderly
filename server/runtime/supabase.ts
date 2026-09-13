import { createEdgeApp } from '../edge.js';
import { SupabaseRepository } from '../storage/supabase.js';
import { appMode, requiredEnv } from '../config.js';

declare const Deno: { serve(handler: (request: Request) => Response | Promise<Response>): unknown };
declare const EdgeRuntime: { waitUntil(task: Promise<unknown>): void } | undefined;

// Hosted Supabase environments are read-only. Validate without mutating env.
if (appMode() !== 'live') throw new Error('Supabase deployment requires APP_MODE=live.');
requiredEnv('APP_URL');
requiredEnv('CREDENTIAL_ENCRYPTION_KEY');
requiredEnv('CRON_SECRET');
const repo = new SupabaseRepository(
  requiredEnv('SUPABASE_URL'),
  requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
);
const app = createEdgeApp(repo, {
  waitUntil: typeof EdgeRuntime !== 'undefined' ? (task) => EdgeRuntime.waitUntil(task) : undefined,
});
Deno.serve((request) => app.fetch(request));
