// The operator docs describe the settings and migrations as they are implemented.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Windows checkouts may have CRLF line endings.
const read = (file: string) =>
  readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');

describe('settings and migrations in the docs', () => {
  it('lists the new backend settings in .env.example, each with its comment', () => {
    const example = read('.env.example');
    for (const line of [
      'WORKER_LEASE_SECONDS=180',
      'ORDERLY_PAUSE_AUTOMATION=',
      'HEALTH_CHECK_TOKEN=',
    ]) {
      const at = example.split('\n').indexOf(line);
      expect(at, line).toBeGreaterThan(0);
      expect(example.split('\n')[at - 1], line).toMatch(/^# /);
    }
    expect(example).toContain('480 on Pro');
    expect(example).toContain('Authorization: Bearer <token>');
  });

  it('names the real pre-launch migration files, and only files that exist', () => {
    const deployment = read('docs/DEPLOYMENT.md');
    expect(deployment).not.toMatch(/2026102000\d{2}_\*/);
    for (const file of ['202610200001_prelaunch_fixes.sql', '202610200002_order_followups.sql'])
      expect(deployment).toContain(`\`${file}\``);
    for (const [name] of deployment.matchAll(/\b\d{12}_[a-z0-9_]+\.sql\b/g))
      expect(existsSync(join('supabase/migrations', name)), name).toBe(true);
  });

  it('describes the pipeline health route and the emergency stop as implemented', () => {
    const deployment = read('docs/DEPLOYMENT.md');
    expect(deployment).toContain('`Authorization: Bearer <token>`');
    expect(deployment).toContain('answers 404 like an unknown route');
    expect(deployment).toContain('503 with `status: unavailable`');
    const runbook = read('docs/INCIDENT-RUNBOOK.md');
    expect(runbook).toContain('`automationPaused: true`');
    expect(runbook).toContain('saving settings with automation switched on is refused');
  });

  it('gives the heartbeat as reported now, and the greeting and away message step', () => {
    for (const file of ['docs/DEPLOYMENT.md', 'docs/GET-IT-RUNNING.md', 'docs/INCIDENT-RUNBOOK.md'])
      expect(read(file), file).not.toContain('under 90 seconds');
    const guide = read('docs/GET-IT-RUNNING.md');
    expect(guide).toContain(
      'updated about once a minute; over 3 minutes means Orderly treats WhatsApp as offline',
    );
    expect(guide).toContain('greeting and away messages');
  });

  it('words the linked-phone risk in the gateway docs as the dashboard does', () => {
    for (const file of ['gateway/README.md', 'gateway/RAILWAY.md']) {
      const doc = read(file).replace(/\s+/g, ' ');
      expect(doc, file).toContain("against WhatsApp's terms");
      expect(doc, file).toContain('temporarily or permanently');
      expect(doc, file).toContain("restaurant's own WhatsApp app");
      expect(doc, file).toContain('official Cloud API with coexistence');
    }
    const railway = read('gateway/RAILWAY.md').replace(/\s+/g, ' ');
    expect(railway).toContain('enabled for linked-phone pairing');
    expect(railway).toContain('Orderly records who accepted which version of the notice');
    expect(railway).not.toContain('available as a fallback');
  });
});
