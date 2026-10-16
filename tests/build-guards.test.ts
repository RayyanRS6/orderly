import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

type Chunk = {
  file: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
};
type Manifest = Record<string, Chunk>;

// Shaped like the manifest of a real build:cloudflare run.
const built = (): Manifest => ({
  'index.html': {
    file: 'assets/index-e1.js',
    src: 'index.html',
    isEntry: true,
    dynamicImports: ['src/components/MenuPage.tsx', 'src/App.tsx'],
  },
  '_pricing-p1.js': { file: 'assets/pricing-p1.js', imports: ['index.html'] },
  'src/App.tsx': {
    file: 'assets/App-a1.js',
    src: 'src/App.tsx',
    isDynamicEntry: true,
    imports: ['_pricing-p1.js', 'index.html'],
    dynamicImports: [
      'src/components/People.tsx',
      'node_modules/@supabase/supabase-js/dist/index.mjs',
    ],
  },
  'src/components/MenuPage.tsx': {
    file: 'assets/MenuPage-m1.js',
    src: 'src/components/MenuPage.tsx',
    isDynamicEntry: true,
    imports: ['_pricing-p1.js', 'index.html'],
  },
  'src/components/People.tsx': {
    file: 'assets/People-u1.js',
    src: 'src/components/People.tsx',
    isDynamicEntry: true,
    imports: ['_pricing-p1.js', 'index.html', 'src/App.tsx'],
  },
  'node_modules/@supabase/supabase-js/dist/index.mjs': {
    file: 'assets/dist-s1.js',
    src: 'node_modules/@supabase/supabase-js/dist/index.mjs',
    isDynamicEntry: true,
    imports: ['src/App.tsx'],
  },
});

// Runs the real prerender step in a scratch folder holding a small fake build.
function prerender(
  change: (manifest: Manifest, chunks: Record<string, string>) => void = () => {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'orderly-prerender-'));
  try {
    const manifest = built();
    const chunks: Record<string, string> = {};
    for (const chunk of Object.values(manifest)) chunks[chunk.file] = 'export {};';
    change(manifest, chunks);
    const shell = readFileSync(join(process.cwd(), 'index.html'), 'utf8')
      .replace('<script type="module" src="/src/main.tsx"></script>', '')
      .replace(
        '</head>',
        '<script type="module" crossorigin src="/assets/index-e1.js"></script></head>',
      );
    const files: Record<string, string> = {
      'src/public-render.tsx':
        'export const renderPublic = (path: string) => `<main>${path}</main>`;',
      'dist/index.html': shell,
      'dist/.vite/manifest.json': JSON.stringify(manifest),
      ...Object.fromEntries(Object.entries(chunks).map(([file, code]) => [`dist/${file}`, code])),
    };
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
    const run = spawnSync(process.execPath, [join(process.cwd(), 'scripts/prerender-public.mjs')], {
      cwd: dir,
      encoding: 'utf8',
    });
    const page = (file: string) =>
      existsSync(join(dir, 'dist', file)) ? readFileSync(join(dir, 'dist', file), 'utf8') : '';
    return {
      status: run.status,
      error: run.stderr,
      menu: page('menu.html'),
      app: page('app.html'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const preloads = (html: string) =>
  [...html.matchAll(/<link rel="modulepreload" crossorigin href="\/([^"]+)" \/>/g)].map(
    (m) => m[1],
  );

describe('prerendered menu and workspace pages', () => {
  it('preloads the menu page chunks on menu.html and leaves app.html as it was', () => {
    const run = prerender();
    expect(run.status, run.error).toBe(0);
    expect(preloads(run.menu)).toEqual(['assets/MenuPage-m1.js', 'assets/pricing-p1.js']);
    expect(run.menu).toContain('<title>Menu · Orderly</title>');
    // The workspace keeps its preloads, and lazy pages such as People still load when opened.
    expect(preloads(run.app)).toEqual([
      'assets/App-a1.js',
      'assets/pricing-p1.js',
      'assets/dist-s1.js',
    ]);
  });

  it.each([
    [
      'the workspace chunk through a shared chunk',
      (manifest: Manifest) => {
        manifest['_helper-h1.js'] = { file: 'assets/helper-h1.js', imports: ['src/App.tsx'] };
        manifest['src/components/MenuPage.tsx'].imports!.push('_helper-h1.js');
      },
      'src/App.tsx',
    ],
    [
      'a dialog library chunk',
      (manifest: Manifest) => {
        const radix = 'node_modules/@radix-ui/react-dialog/dist/index.mjs';
        manifest[radix] = { file: 'assets/index-r1.js', src: radix, isDynamicEntry: true };
        manifest['src/components/MenuPage.tsx'].imports!.push(radix);
      },
      '@radix-ui/react-dialog',
    ],
    [
      'a shared chunk the dialog library was merged into',
      (_: Manifest, chunks: Record<string, string>) => {
        chunks['assets/pricing-p1.js'] = 'e.setAttribute("data-radix-focus-guard","");';
      },
      'assets/pricing-p1.js',
    ],
  ])('fails the build when the menu page loads %s', (_, change, named) => {
    const run = prerender(change);
    expect(run.status).not.toBe(0);
    expect(run.error).toContain(`The menu page must stay light`);
    expect(run.error).toContain(named);
    expect(run.menu).toBe('');
  });
});
