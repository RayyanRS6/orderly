import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
// Windows checkouts may have CRLF line endings.
const read = (file: string) => readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n');

describe('incident runbook', () => {
  const runbook = read('docs/INCIDENT-RUNBOOK.md');

  it('covers every secret the apps and workflows use', () => {
    const names = new Set<string>(['ORDERLY_PAUSE_AUTOMATION', 'HEALTH_CHECK_TOKEN']);
    for (const file of ['.env.example', 'gateway/.env.example'])
      for (const match of read(file).matchAll(/^#?\s*([A-Z][A-Z0-9_]*(?:SECRET|KEY|TOKEN))=/gm))
        names.add(match[1]);
    for (const file of readdirSync(join(root, '.github/workflows')))
      for (const match of read(`.github/workflows/${file}`).matchAll(/secrets\.([A-Z0-9_]+)/g))
        names.add(match[1]);
    expect(names.size).toBeGreaterThan(10);
    for (const name of names) expect(runbook, `${name} is missing`).toContain(name);
  });

  it('describes the emergency stop and says plainly the encryption key cannot be rotated', () => {
    expect(runbook).toContain('ORDERLY_PAUSE_AUTOMATION=on');
    expect(runbook).toContain('**It cannot be rotated today.**');
    expect(runbook).toContain('configure-scheduler.mjs');
    expect(runbook).toContain('Who to tell');
    expect(runbook).toContain('BACKUP-AND-RESTORE.md');
  });
});

describe('compliance notes', () => {
  const notes = read('docs/COMPLIANCE-NOTES-2026-10-18.md');

  it('never presents the data protection bill as law', () => {
    expect(notes).toContain('has **not been enacted**');
    for (const doc of [notes, read('src/components/Legal.tsx')])
      expect(doc).not.toMatch(/Personal Data Protection Act/);
  });

  it('records a source and date for each rule and flags what needs a lawyer', () => {
    for (const topic of [
      'WhatsApp Business App terms',
      'Meta Terms for WhatsApp Business Platform',
      'Anthropic Usage Policy',
      'Gemini',
      'PECA',
      'Punjab Revenue Authority',
      'Islamabad',
      'Consumer Protection Act',
      'Questions for a local lawyer',
    ])
      expect(notes).toContain(topic);
    expect(notes.match(/Checked 2026-10-18/g)?.length).toBeGreaterThanOrEqual(8);
  });
});
