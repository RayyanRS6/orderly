import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// F137: the gateway image is built from the repository root, so the root .dockerignore decides
// what reaches the Docker builder. This models Docker's rules (moby patternmatcher): the last
// matching pattern wins, and a pattern that matches a folder also matches everything inside it.
const root = fileURLToPath(new URL('..', import.meta.url));
function patterns(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const exclusion = line.startsWith('!');
      const pattern = (exclusion ? line.slice(1) : line).replace(/^\/+|\/+$/g, '');
      const source = pattern
        .split(/(\*\*\/|\/\*\*$|\*\*|\*|\?)/)
        .map((part) =>
          part === '**/'
            ? '(.*/)?'
            : part === '/**'
              ? '(/.*)?'
              : part === '**'
                ? '.*'
                : part === '*'
                  ? '[^/]*'
                  : part === '?'
                    ? '[^/]'
                    : part.replace(/[.+^${}()|[\]\\]/g, '\\$&'),
        )
        .join('');
      return { exclusion, regex: new RegExp(`^${source}$`) };
    });
}
function sent(rules: ReturnType<typeof patterns>, path: string) {
  const parts = path.split('/');
  const prefixes = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  let excluded = false;
  for (const rule of rules)
    if (prefixes.some((prefix) => rule.regex.test(prefix))) excluded = !rule.exclusion;
  return !excluded;
}
const rules = patterns(readFileSync(join(root, '.dockerignore'), 'utf8'));
function files(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = `${dir}/${name}`;
    return statSync(join(root, path)).isDirectory() ? files(path) : [path];
  });
}

describe('gateway Docker build context', () => {
  it('models the folder re-include that leaked gateway/.env', () => {
    const old = patterns('**\n!gateway/\n!gateway/package.json');
    expect(sent(old, 'gateway/.env')).toBe(true);
    expect(sent(old, 'gateway/data/session.sqlite')).toBe(true);
  });

  it('never sends gateway secrets, WhatsApp session data or unrelated code to the builder', () => {
    for (const path of [
      '.env',
      '.env.local',
      'gateway/.env',
      'gateway/.env.production',
      'gateway/data/gateway.sqlite',
      'gateway/data/0f8b.sqlite-wal',
      'gateway/node_modules/@whiskeysockets/baileys/package.json',
      'gateway/dist/gateway/src/index.js',
      'gateway/README.md',
      'gateway/src/data.sqlite',
      '.local/audit-2026-10-18/packets/wp-d.md',
      'src/App.tsx',
      'src/shared/types.ts',
      'server/app.ts',
      'server/whatsapp/connections.ts',
      'supabase/migrations/202609200001_whatsapp_gateway.sql',
    ])
      expect(sent(rules, path), path).toBe(false);
  });

  it('still sends every file the gateway Dockerfile copies', () => {
    const dockerfile = readFileSync(join(root, 'gateway/Dockerfile'), 'utf8');
    const sources = [...dockerfile.matchAll(/^COPY (?!--from)(?:--\S+ )*(\S+) \S+$/gm)].map(
      (match) => match[1]!,
    );
    expect(sources).toEqual(
      expect.arrayContaining([
        'gateway/src',
        'src/shared/whatsapp.ts',
        'server/whatsapp/signing.ts',
      ]),
    );
    const wanted = sources.flatMap((source) => {
      if (source.includes('*')) {
        const [dir, glob] = [source.slice(0, source.lastIndexOf('/')), source.split('/').pop()!];
        const regex = new RegExp(`^${glob.replace(/\./g, '\\.').replace(/\*/g, '[^/]*')}$`);
        return readdirSync(join(root, dir))
          .filter((name) => regex.test(name))
          .map((name) => `${dir}/${name}`);
      }
      return statSync(join(root, source)).isDirectory() ? files(source) : [source];
    });
    expect(wanted).toContain('gateway/package.json');
    expect(wanted).toContain('gateway/package-lock.json');
    expect(wanted).toContain('gateway/src/worker.ts');
    for (const path of wanted) expect(sent(rules, path), path).toBe(true);
  });
});
