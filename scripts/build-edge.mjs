import { build } from 'esbuild';
import { mkdir, stat } from 'node:fs/promises';

await mkdir('supabase/functions/orderly', { recursive: true });
await build({
  entryPoints: ['server/runtime/supabase.ts'],
  outfile: 'supabase/functions/orderly/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  mainFields: ['module', 'main'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  inject: ['server/runtime/node-globals.ts'],
  minify: true,
  legalComments: 'none',
  // No process.env defines: all credentials stay runtime-only.
});
const size = (await stat('supabase/functions/orderly/index.js')).size;
if (size > 5 * 1024 * 1024)
  throw new Error('Edge bundle exceeds the 5 MB server-side bundling limit.');
console.log(`Supabase edge bundle: ${(size / 1024 / 1024).toFixed(2)} MB`);
