import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Windows checkouts may have CRLF line endings.
const read = (file: string) =>
  readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');

describe('setup and deployment docs', () => {
  it('keeps the current docs free of the removed cap, retired URL and stale status', () => {
    for (const file of [
      'README.md',
      'docs/DEPLOYMENT.md',
      'docs/GET-IT-RUNNING.md',
      'docs/BACKUP-AND-RESTORE.md',
      'docs/INCIDENT-RUNBOOK.md',
    ]) {
      const doc = read(file);
      for (const stale of [
        'platform-funded',
        'https://orderly.waytogalaxy999.workers.dev',
        'eligibility for free usage',
        'not deployed',
        'in use at Fries & Buns',
      ])
        expect(doc, `${file} still says "${stale}"`).not.toContain(stale);
    }
    expect(read('docs/ORDERLY-LAUNCH-STEPS-2026-09-18.md')).not.toContain(
      'Website: <https://orderly.waytogalaxy999.workers.dev>',
    );
  });

  it('lists the official WhatsApp route first in the setup guide', () => {
    const guide = read('docs/GET-IT-RUNNING.md');
    const official = guide.indexOf('**Option A: official Meta Cloud API, with coexistence');
    const linked = guide.indexOf('**Option B: linked phone through Railway (unofficial)');
    expect(official).toBeGreaterThan(0);
    expect(linked).toBeGreaterThan(official);
    expect(guide.slice(linked)).toContain('against WhatsApp');
  });

  it('documents the release order, new settings and owner actions', () => {
    const deployment = read('docs/DEPLOYMENT.md');
    const release = deployment.slice(deployment.indexOf('## 7. Release order'));
    // The gateway goes right after its backend, in a second push, before the dashboard.
    const steps = [
      '202610200001',
      '**Backend, first push:**',
      '**Gateway, second push:**',
      '**Dashboard:**',
      '202610200002',
    ];
    const at = steps.map((step) => release.indexOf(step));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(deployment).toMatch(
      /`WORKER_LEASE_SECONDS`\s*\|\s*`180` on the Free plan.*`480` on Pro/,
    );
    expect(deployment).toContain('`ORDERLY_PAUSE_AUTOMATION`');
    expect(deployment).toContain('`HEALTH_CHECK_TOKEN`');
    expect(deployment).toContain('/api/health/pipeline');
    for (const action of ['Vercel', 'production', 'commit SHA', 'dependabot'])
      expect(deployment).toContain(action);
  });

  it('describes the pilot as it is', () => {
    const readme = read('README.md');
    expect(readme).toContain('pilot');
    expect(readme).toContain('Two test restaurants');
    expect(readme).toContain("a friend's restaurant is the first real one to go live");
  });
});
