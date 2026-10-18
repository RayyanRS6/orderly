// A run on another branch can never replace a waiting main deploy, and only one deploy reaches
// production at a time.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Windows checkouts may have CRLF line endings.
const workflow = readFileSync(
  join(process.cwd(), '.github/workflows/deploy-backend.yml'),
  'utf8',
).replace(/\r\n/g, '\n');
const top = workflow.slice(0, workflow.indexOf('\njobs:'));
const jobs = workflow.slice(workflow.indexOf('\njobs:'));
const deploy = jobs.slice(jobs.indexOf('\n  deploy:'));
const verify = jobs.slice(jobs.indexOf('\n  verify:'), jobs.indexOf('\n  deploy:'));
// The concurrency block that starts at this indentation.
const group = (text: string, indent: string) =>
  text.match(
    new RegExp(
      `\\n${indent}concurrency:\\n${indent}  group: (.+)\\n${indent}  cancel-in-progress: (.+)`,
    ),
  );

describe('backend workflow concurrency', () => {
  it('queues whole runs per branch, so a branch run never replaces a waiting main run', () => {
    const run = group(top, '');
    expect(run?.[1]).toBe('supabase-backend-${{ github.ref }}');
    expect(run?.[2]).toBe('false');
  });

  it('lets only one deploy job at a time reach production, never cancelling one', () => {
    const job = group(deploy, '    ');
    expect(job?.[1]).toBe('supabase-production');
    expect(job?.[2]).toBe('false');
    expect(verify).not.toContain('concurrency:');
  });

  it('warns that re-running an old run deploys old code', () => {
    expect(top).toContain('Re-running an older run deploys that older commit over newer code');
    expect(top).not.toContain('Whole runs queue in push order');
  });
});
