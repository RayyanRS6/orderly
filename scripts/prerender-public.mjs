import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
await writeFile(
  'dist/app.html',
  shell.replace('</head>', '<meta name="robots" content="noindex,nofollow" /></head>'),
);
const pages = {
  '/': 'Conversations to orders',
  '/contact': 'Contact',
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
    `<div id="root">${renderPublic(path)}</div>` +
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
await writeFile(
  'dist/_redirects',
  '/login /app 200\n/app/* /app 200\n',
);
await writeFile('dist/robots.txt', 'User-agent: *\nDisallow: /app\nDisallow: /login\n');
console.log('Generated public pages, app deep links, security headers and a public 404 page.');
