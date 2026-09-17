import 'dotenv/config';
import { spawnSync } from 'node:child_process';
const base = process.env.VITE_API_BASE_URL;
if (!base)
  throw new Error(
    'Set VITE_API_BASE_URL to your Supabase function URL before building the hosted frontend.',
  );
const url = new URL(base);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
  throw new Error('The hosted API base must be a plain HTTPS URL.');
// Invoke Node directly so paths with spaces work without shell interpolation.
for (const script of ['node_modules/typescript/bin/tsc', 'node_modules/vite/bin/vite.js']) {
  const args = script.includes('typescript') ? ['--noEmit'] : ['build'];
  const result = spawnSync(process.execPath, [script, ...args], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
await import('./prerender-public.mjs');
