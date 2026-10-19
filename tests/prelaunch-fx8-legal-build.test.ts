// FX-8 (frontend-8): build:cloudflare refuses to publish the legal pages while they still say
// "[OWNER TO CONFIRM: …]", unless ALLOW_LEGAL_PLACEHOLDERS=1 is set for a build that will not be
// published. A failed build leaves no dist folder, so a deploy run right after has nothing to send.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const manifest = {
  'index.html': {
    file: 'assets/index-e1.js',
    src: 'index.html',
    isEntry: true,
    dynamicImports: ['src/components/MenuPage.tsx', 'src/App.tsx'],
  },
  'src/App.tsx': { file: 'assets/App-a1.js', src: 'src/App.tsx', isDynamicEntry: true },
  'src/components/MenuPage.tsx': {
    file: 'assets/MenuPage-m1.js',
    src: 'src/components/MenuPage.tsx',
    isDynamicEntry: true,
  },
};

// Runs the real prerender step on a small fake build whose legal pages say `legal`.
function prerender(legal: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'orderly-legal-'));
  try {
    const shell = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
    const files: Record<string, string> = {
      'src/public-render.tsx': `export const renderPublic = (path: string) => ['/privacy', '/terms', '/data-deletion'].includes(path) ? ${JSON.stringify(legal)} : '<main>' + path + '</main>';`,
      'src/components/Public.tsx': "export const supportEmail = 'help@orderly.example';",
      'dist/index.html': shell,
      'dist/.vite/manifest.json': JSON.stringify(manifest),
      'dist/assets/index-e1.js': 'export {};',
      'dist/assets/App-a1.js': 'export {};',
      'dist/assets/MenuPage-m1.js': 'export {};',
    };
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
    const { ALLOW_LEGAL_PLACEHOLDERS: _, ...inherited } = process.env;
    const run = spawnSync(process.execPath, [join(process.cwd(), 'scripts/prerender-public.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...inherited, ...env },
    });
    return {
      status: run.status,
      output: run.stderr + run.stdout,
      dist: existsSync(join(dir, 'dist')),
      privacy: existsSync(join(dir, 'dist/privacy.html'))
        ? readFileSync(join(dir, 'dist/privacy.html'), 'utf8')
        : '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const placeholder =
  '<p>Orderly is run by [OWNER TO CONFIRM: legal name and address of the business that runs Orderly].</p>';

describe('publishing the legal pages', () => {
  it('fails while a placeholder remains, naming the pages, and removes the build', () => {
    const run = prerender(placeholder);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('still contain [OWNER TO CONFIRM: …] placeholders');
    expect(run.output).toContain('/privacy, /terms, /data-deletion');
    expect(run.output).toContain('ALLOW_LEGAL_PLACEHOLDERS=1');
    expect(run.dist).toBe(false);
  });

  it('builds anyway with ALLOW_LEGAL_PLACEHOLDERS=1, with a warning', () => {
    const run = prerender(placeholder, { ALLOW_LEGAL_PLACEHOLDERS: '1' });
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('Do not publish this build.');
    expect(run.privacy).toContain('OWNER TO CONFIRM');
  });

  it('builds as before once the legal text is filled in', () => {
    const run = prerender('<p>Orderly is run by Example Foods (Pvt) Ltd, Lahore.</p>');
    expect(run.status, run.output).toBe(0);
    expect(run.output).not.toContain('OWNER TO CONFIRM');
    expect(run.privacy).toContain('Example Foods');
  });

  it('runs inside build:cloudflare, which documents the switch', () => {
    const build = readFileSync(join(process.cwd(), 'scripts/build-frontend.mjs'), 'utf8');
    expect(build).toContain("await import('./prerender-public.mjs');");
    expect(build).toContain('ALLOW_LEGAL_PLACEHOLDERS=1');
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.scripts['build:cloudflare']).toBe('node scripts/build-frontend.mjs');
  });
});
