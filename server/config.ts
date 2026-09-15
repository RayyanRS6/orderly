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
export function requiredEnv(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`${name} must be configured on the server.`);
  return value;
}
