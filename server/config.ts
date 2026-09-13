export function appMode(): 'demo' | 'live' {
  const hosted = process.env.ORDERLY_RUNTIME === 'supabase' || !!process.env.VERCEL;
  const mode = process.env.APP_MODE ?? (hosted ? 'live' : 'demo');
  if (mode !== 'demo' && mode !== 'live') throw new Error('APP_MODE must be demo or live.');
  if (mode === 'demo' && hosted)
    throw new Error(
      'Demo mode is local-only. Configure Supabase and APP_MODE=live before deployment.',
    );
  return mode;
}
export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured on the server.`);
  return value;
}
