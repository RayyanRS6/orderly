import { build } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Public information is readable without JavaScript; app routes retain their
// own loading shell and authenticate in the browser and backend.
await mkdir('.local', { recursive: true });
await build({
  // The support address comes from the Contact page, so security.txt names the same one.
  stdin: {
    contents:
      "export { renderPublic } from './src/public-render.tsx';\nexport { supportEmail } from './src/components/Public.tsx';\n",
    resolveDir: process.cwd(),
    sourcefile: 'public-render-entry.ts',
    loader: 'ts',
  },
  outfile: '.local/public-render.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  jsx: 'automatic',
});
const { renderPublic, supportEmail } = await import(
  pathToFileURL(resolve('.local/public-render.mjs')).href
);
if (!/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(supportEmail ?? ''))
  throw new Error('The support email (src/components/Public.tsx) is missing or invalid.');
// The legal pages must not go live with an "[OWNER TO CONFIRM: …]" placeholder (the operator's
// legal name and address, the backup period; src/components/Legal.tsx). The build stops before
// anything is published, and removes the half-built dist folder, so a deploy run straight after
// a failed build has nothing to upload. Only for a build that will not be published (a local
// preview), set ALLOW_LEGAL_PLACEHOLDERS=1 to build anyway.
const unconfirmed = ['/privacy', '/terms', '/data-deletion'].filter((path) =>
  renderPublic(path).includes('OWNER TO CONFIRM'),
);
if (unconfirmed.length && process.env.ALLOW_LEGAL_PLACEHOLDERS !== '1') {
  await rm('dist', { recursive: true, force: true });
  throw new Error(
    `The legal pages (${unconfirmed.join(', ')}) still contain [OWNER TO CONFIRM: …] placeholders. Fill them in src/components/Legal.tsx before publishing. For a build that will not be published, set ALLOW_LEGAL_PLACEHOLDERS=1.`,
  );
}
if (unconfirmed.length)
  console.warn(
    `ALLOW_LEGAL_PLACEHOLDERS=1: the legal pages (${unconfirmed.join(', ')}) still contain [OWNER TO CONFIRM: …] placeholders. Do not publish this build.`,
  );
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
  // Lazy pages (such as the admin-only People page) load when opened, not for everyone.
  if (depth === 0)
    for (const dep of chunk.dynamicImports ?? [])
      if (!dep.startsWith('src/components/')) visit(dep, depth + 1);
};
visit('src/App.tsx');
if (!preload.size) throw new Error('The workspace chunk (src/App.tsx) is missing from the build.');
if ([...preload].some((file) => /(^|\/)People-[^/]*\.js$/.test(file)))
  throw new Error('The admin-only People page must not be preloaded for every workspace.');
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
// A restaurant's menu page (/m/<slug>, rewritten to this file) fetches its own small chunk and
// the chunks it imports alongside the entry script. It must never reach the workspace or the
// dialog library, which would make every Instagram/QR visitor download the dashboard.
if (!manifest['src/components/MenuPage.tsx'])
  throw new Error('The menu page chunk (src/components/MenuPage.tsx) is missing from the build.');
const menuPreload = new Set();
const visitMenu = (key) => {
  const chunk = manifest[key];
  if (!chunk || chunk.isEntry || menuPreload.has(chunk.file)) return;
  if (key === 'src/App.tsx' || /(^|\/)node_modules\/@radix-ui\//.test(key))
    throw new Error(`The menu page must stay light, but it loads ${key}.`);
  menuPreload.add(chunk.file);
  for (const dep of chunk.imports ?? []) visitMenu(dep);
};
visitMenu('src/components/MenuPage.tsx');
// Shared chunks have no source path in the manifest and the bundler can merge Radix into one,
// so also look for the attribute its focus guards add.
for (const file of menuPreload)
  if ((await readFile(`dist/${file}`, 'utf8')).includes('data-radix-'))
    throw new Error(`The menu page must stay light, but ${file} contains the dialog library.`);
const menuPreloadTags = [...menuPreload]
  .map((file) => `<link rel="modulepreload" crossorigin href="/${file}" />`)
  .join('');
await writeFile(
  'dist/menu.html',
  shell
    .replace('Opening your workspace…', 'Opening the menu…')
    .replace('to run the workspace', 'to show this menu')
    .replace(/<title>[\s\S]*?<\/title>/, '<title>Menu · Orderly</title>')
    .replace(
      /<meta\s+name="description"\s+content="[^"]*"\s*\/>/,
      '<meta name="description" content="See the menu and order on WhatsApp." />',
    )
    .replace('</head>', `<meta name="robots" content="noindex" />${menuPreloadTags}</head>`),
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
  `/*\n  Content-Security-Policy: ${csp}\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n  Strict-Transport-Security: max-age=31536000\n/app*\n  X-Robots-Tag: noindex, nofollow\n/login\n  X-Robots-Tag: noindex, nofollow\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n/m/*\n  X-Robots-Tag: noindex\n  Referrer-Policy: no-referrer\n`,
);
await writeFile('dist/_redirects', '/login /app 200\n/app/* /app 200\n/m/* /menu 200\n');
await writeFile('dist/robots.txt', 'User-agent: *\nDisallow: /app\nDisallow: /login\n');
// Where to report a security problem (RFC 9116). It must be renewed before it expires, which
// every build does.
await mkdir('dist/.well-known', { recursive: true });
const expires = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
expires.setUTCHours(0, 0, 0, 0);
await writeFile(
  'dist/.well-known/security.txt',
  `Contact: mailto:${supportEmail}\nExpires: ${expires.toISOString()}\nPreferred-Languages: en\nPolicy: /privacy\n`,
);
console.log(
  'Generated public pages, app deep links, security headers, security.txt and a public 404 page.',
);
