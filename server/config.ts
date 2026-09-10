import 'dotenv/config';
export function appMode(): 'demo' | 'live' {
  const mode = process.env.APP_MODE ?? (process.env.VERCEL ? 'live' : 'demo');
  if (mode !== 'demo' && mode !== 'live') throw new Error('APP_MODE must be demo or live.');
  if (mode === 'demo' && process.env.VERCEL)
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
