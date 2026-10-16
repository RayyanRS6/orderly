import { build } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Public information is readable without JavaScript; app routes retain their
// own loading shell and authenticate in the browser and backend.
await mkdir('.local', { recursive: true });
await build({
  entryPoints: ['src/public-render.tsx'],
  outfile: '.local/public-render.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  jsx: 'automatic',
});
const { renderPublic } = await import(pathToFileURL(resolve('.local/public-render.mjs')).href);
const shell = await readFile('dist/index.html', 'utf8');
// The workspace is a separately loaded chunk (src/main.tsx), so public pages skip it.
// App pages fetch it, the chunks it imports and the sign-in client alongside the entry
// script rather than after it runs.
const manifest = JSON.parse(await readFile('dist/.vite/manifest.json', 'utf8'));
const preload = new Set();
const visit = (key, depth = 0) => {
  const chunk = manifest[key];
  if (!chunk || chunk.isEntry || preload.has(chunk.file)) return;
  preload.add(chunk.file);
  for (const dep of chunk.imports ?? []) visit(dep, depth);
  if (depth === 0) for (const dep of chunk.dynamicImports ?? []) visit(dep, depth + 1);
};
visit('src/App.tsx');
if (!preload.size) throw new Error('The workspace chunk (src/App.tsx) is missing from the build.');
const preloadTags = [...preload]
  .map((file) => `<link rel="modulepreload" crossorigin href="/${file}" />`)
  .join('');
await writeFile(
  'dist/app.html',
  shell.replace(
    '</head>',
    `<meta name="robots" content="noindex,nofollow" />${preloadTags}</head>`,
  ),
);
// The manifest is a build detail, not something to publish.
await rm('dist/.vite', { recursive: true, force: true });
const pages = {
  '/': 'Conversations to orders',
  '/contact': 'Contact',
  '/pricing': 'Pricing',
  '/privacy': 'Privacy Policy',
  '/terms': 'Terms of Service',
  '/data-deletion': 'Data deletion',
  '/404': 'Page not found',
};
for (const [path, title] of Object.entries(pages)) {
  const start = shell.indexOf('<div id="root">');
  const end = shell.indexOf('<noscript>');
  if (start < 0 || end < start) throw new Error('Public page shell markers are missing.');
  const html = (
    shell.slice(0, start) +
    `<div id="root" data-prerendered="${path}">${renderPublic(path)}</div>` +
    shell.slice(end)
  )
    .replace(/<noscript>[\s\S]*?<\/noscript>/, '')
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${title} · Orderly</title>`);
  await writeFile(`dist/${path === '/' ? 'index' : path.slice(1)}.html`, html);
}
const apiOrigin = process.env.VITE_API_BASE_URL
  ? new URL(process.env.VITE_API_BASE_URL).origin
  : '';
const socketOrigin = apiOrigin.replace(/^https:/, 'wss:');
const csp = [
  "default-src 'self'",
  "script-src 'self' https://connect.facebook.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  `connect-src 'self' ${apiOrigin} ${socketOrigin} https://*.facebook.com https://*.facebook.net`,
  'frame-src https://*.facebook.com',
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
await writeFile(
  'dist/_headers',
  `/*\n  Content-Security-Policy: ${csp}\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n  Strict-Transport-Security: max-age=31536000\n/app*\n  X-Robots-Tag: noindex, nofollow\n/login\n  X-Robots-Tag: noindex, nofollow\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n`,
);
await writeFile('dist/_redirects', '/login /app 200\n/app/* /app 200\n');
await writeFile('dist/robots.txt', 'User-agent: *\nDisallow: /app\nDisallow: /login\n');
console.log('Generated public pages, app deep links, security headers and a public 404 page.');
