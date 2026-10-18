export function env(name: string): string | undefined {
  // Supabase Edge Functions expose secrets through Deno.env. The Node compatibility
  // layer normally mirrors them into process.env, but using both keeps deployment
  // configuration deterministic after a function or secret update.
  const deno = (globalThis as unknown as { Deno?: { env?: { get: (key: string) => string | undefined } } })
    .Deno;
  return deno?.env?.get(name) ?? process.env[name];
}

export function appMode(): 'demo' | 'live' {
  const hosted = env('ORDERLY_RUNTIME') === 'supabase' || !!env('VERCEL');
  const mode = env('APP_MODE') ?? (hosted ? 'live' : 'demo');
  if (mode !== 'demo' && mode !== 'live') throw new Error('APP_MODE must be demo or live.');
  if (mode === 'demo' && hosted)
    throw new Error(
      'Demo mode is local-only. Configure Supabase and APP_MODE=live before deployment.',
    );
  return mode;
}
// Audit entries that belong to no business (directory views, deleting an account with none).
export const PLATFORM_AUDIT_ID = '_platform';
export function requiredEnv(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`${name} must be configured on the server.`);
  return value;
}
/**
 * The platform-wide stop: ORDERLY_PAUSE_AUTOMATION=on makes every business behave as if its bot
 * were switched off. Messages are still saved and staff can still reply; nothing automatic goes
 * out and no AI is called. Never throws, so it cannot break a webhook.
 */
export function automationPaused(): boolean {
  return ['on', 'true', '1'].includes((env('ORDERLY_PAUSE_AUTOMATION') ?? '').trim().toLowerCase());
}
