import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Windows checkouts may have CRLF line endings.
const workflow = readFileSync(
  join(process.cwd(), '.github/workflows/deploy-backend.yml'),
  'utf8',
).replace(/\r\n/g, '\n');
// Each job's own lines, keyed by job name.
const jobs: Record<string, string> = Object.fromEntries(
  workflow
    .slice(workflow.indexOf('\njobs:'))
    .split(/\n(?= {2}[\w-]+:\n)/)
    .slice(1)
    .map((block) => [block.trim().split(':')[0], block]),
);

describe('backend deploy waits for the checks', () => {
  it('verifies with typecheck, tests and the Deno smoke test, without secrets', () => {
    expect(Object.keys(jobs)).toEqual(['verify', 'deploy']);
    const order = ['npm ci', 'npm run typecheck', 'npm test', 'npm run test:edge-runtime'].map(
      (step) => jobs.verify.indexOf(`run: ${step}\n`),
    );
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(jobs.verify).not.toContain('secrets.');
    expect(jobs.verify).toContain('upload-artifact');
  });

  it('deploys only after verify, only from main, through the production environment', () => {
    const deploy = jobs.deploy;
    expect(deploy).toContain('needs: verify');
    expect(deploy).toContain("if: github.ref == 'refs/heads/main'");
    expect(deploy).toContain('environment: production');
    expect(deploy).toContain('download-artifact');
    expect(deploy).toContain('supabase functions deploy orderly');
    expect(deploy).toContain('secrets.SUPABASE_ACCESS_TOKEN');
    expect(deploy).toContain('/api/health');
  });

  it('skips docs, Markdown and gateway-only pushes and keeps the gateway build out', () => {
    for (const path of ["'docs/**'", "'**/*.md'", "'gateway/**'"]) expect(workflow).toContain(path);
    expect(workflow).not.toMatch(/docker/i);
    // A running deploy is never cancelled half-way; prelaunch-fx4-ci checks the groups.
    expect(workflow).toContain('cancel-in-progress: false');
  });
});
