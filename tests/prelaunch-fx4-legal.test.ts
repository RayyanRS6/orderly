// The privacy policy and the compliance notes say what the code keeps, sends and purges, and
// filling in the owner's placeholders keeps CI green.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LegalPage } from '../src/components/Legal';

// Windows checkouts may have CRLF line endings.
const read = (file: string) =>
  readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');
const legal = (kind: 'privacy' | 'terms' | 'data-deletion') =>
  renderToStaticMarkup(createElement(LegalPage, { kind }))
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
const privacy = legal('privacy');
const deletion = legal('data-deletion');

// The days of encrypted copies the nightly task in BACKUP-AND-RESTORE.md §4 keeps.
const backup = read('docs/BACKUP-AND-RESTORE.md');
const days =
  backup.match(/Where-Object LastWriteTime -lt \(Get-Date\)\.AddDays\(-(\d+)\)/)?.[1] ?? '';

// What `npm test` checks about the owner's facts: each is either still the visible marker or a
// real value, and a filled-in backup period matches the backup task.
function ownerFactProblems(source: string, days: string) {
  const value = (name: string) =>
    source.match(new RegExp(`const ${name} =\\s*(['"\`])(.+?)\\1;`))?.[2];
  const problems: string[] = [];
  const operator = value('OPERATOR');
  const period = value('BACKUP_DAYS');
  if (!operator) problems.push('OPERATOR is missing');
  else if (!/^\[OWNER TO CONFIRM: [^\]]+\]$/.test(operator) && /[[\]]|TO CONFIRM/.test(operator))
    problems.push('OPERATOR is half filled in');
  if (!period) problems.push('BACKUP_DAYS is missing');
  else if (!/^\[OWNER TO CONFIRM: [^\]]+\]$/.test(period) && period !== days)
    problems.push(`BACKUP_DAYS is ${period}, the backup task keeps ${days}`);
  return problems;
}

describe('owner placeholders in the legal pages', () => {
  const source = read('src/components/Legal.tsx');

  it('pass both before and after the owner fills them in', () => {
    expect(days, 'the nightly task deletes old encrypted copies').toMatch(/^\d+$/);
    expect(ownerFactProblems(source, days)).toEqual([]);
    const filled = source
      .replace(
        /const OPERATOR = '[^']*';/,
        "const OPERATOR = 'Example Foods (Private) Limited, 12 Mall Road, Lahore';",
      )
      .replace(/const BACKUP_DAYS = '[^']*';/, `const BACKUP_DAYS = '${days}';`);
    expect(filled).not.toContain('OWNER TO CONFIRM');
    expect(ownerFactProblems(filled, days)).toEqual([]);
    expect(
      ownerFactProblems(filled.replace(`BACKUP_DAYS = '${days}'`, "BACKUP_DAYS = '90'"), days),
    ).toEqual([`BACKUP_DAYS is 90, the backup task keeps ${days}`]);
  });

  it('render the operator and the backup period wherever the pages state them', () => {
    const operator = source.match(/const OPERATOR = '([^']*)';/)![1]!;
    const period = source.match(/const BACKUP_DAYS = '([^']*)';/)![1]!;
    expect(privacy).toContain(`Orderly is run by ${operator}.`);
    expect(privacy).toContain(`Orderly’s database backups are kept for ${period} days`);
    expect(deletion).toContain(`Orderly’s backups expire after ${period} days`);
  });
});

describe('privacy policy matches the code', () => {
  it('says a shared location and a caption are stored and reach the AI', () => {
    expect(privacy).toContain('a shared location is saved as its name, address and coordinates');
    expect(privacy).toContain('a photo’s caption is saved as text');
    expect(privacy).toContain(
      'a photo’s caption, and the place name, address and coordinates of a location you shared',
    );
    // The code that builds that text, and the AI call that sends the chat as written.
    expect(read('src/shared/whatsapp.ts')).toContain("'Location shared:'");
    expect(read('server/integrations/models.ts')).toContain('customerMessage');
  });

  it('states the operational purge as the database runs it', () => {
    const sql = read('supabase/migrations/202610200001_prelaunch_fixes.sql');
    const purge = sql.slice(sql.indexOf('function public.purge_orderly_operations'));
    const traces = purge.match(/from traces where created_at < now\(\) - interval '(\d+) days'/);
    const jobs = purge.match(
      /from jobs where status = 'done' and data->'payload' <> '\{\}'::jsonb\s+and created_at < now\(\) - interval '(\d+) days'/,
    );
    const receipts = purge.match(
      /where conversation_id is null and created_at < now\(\) - interval '(\d+) days'/,
    );
    expect([traces?.[1], jobs?.[1], receipts?.[1]]).toEqual(['90', '14', '90']);
    expect(privacy).toContain(
      'Activity logs, and delivery receipts not linked to a chat, are deleted after about 90 days.',
    );
    expect(privacy).toContain('The contents of finished background tasks');
    expect(privacy).toContain('are cleared after 14 days');
    // Only finished ('done') jobs are cleared, so a failed one keeps its contents.
    expect(privacy).toContain('a task that failed for good keeps its contents');
    expect(privacy).not.toContain('finished background jobs are cleaned after about 90 days');
  });

  it('states the backups as the backup task keeps them', () => {
    expect(backup).toContain(`Keep two plain copies on the laptop and ${days} days`);
    expect(backup).toContain('Select-Object -SkipLast 2 | Remove-Item -Recurse -Force');
    expect(privacy).toContain('the computer itself keeps only the two newest copies');
    expect(privacy).toContain('up to 30 more days in the cloud storage’s recycle bin');
    expect(deletion).toContain('up to 30 more days in a cloud recycle bin');
  });

  it('does not claim no IP address is stored, since sign-ins record one', () => {
    expect(privacy).not.toContain('so the raw IP address is not stored.');
    expect(privacy).toContain('records the IP address and browser of each dashboard sign-in');
  });

  it('words payment as the bot and the menu page do', () => {
    // What customers are told today: cash at pickup or on delivery.
    expect(read('src/domain/engine.ts')).toContain('Payment is cash ${order.fulfillment');
    const menu = read('src/components/MenuPage.tsx');
    expect(menu).toContain('pay in cash');
    expect(menu).toContain('Pay cash {fulfillment');
    expect(privacy).toContain('usually cash on delivery or at pickup');
    expect(privacy).toContain(
      'A JazzCash, Easypaisa or bank transfer is possible only if the restaurant offers it',
    );
    expect(privacy).toContain('anything typed there is kept with the chat until it is deleted');
    expect(privacy).not.toContain('You pay the restaurant directly: cash, or a JazzCash');
    for (const file of ['README.md', 'docs/DEPLOYMENT.md', 'docs/COMPLIANCE-NOTES-2026-10-18.md']) {
      const doc = read(file);
      expect(doc, file).toContain('cash at pickup or on delivery');
      expect(doc, file).not.toMatch(
        /payment is cash, or a JazzCash|cash, JazzCash, Easypaisa or bank transfer checked/,
      );
    }
  });
});

describe('compliance notes', () => {
  const notes = read('docs/COMPLIANCE-NOTES-2026-10-18.md');

  it('say shared locations and captions are stored and sent to the AI', () => {
    expect(notes).not.toContain('location pins are never sent to the AI or stored');
    expect(notes).toContain('a location is its place name, address and coordinates');
    expect(notes).toContain('stored with the chat and sent to the business');
    expect(notes).toContain('an address in a shared location or typed in the chat reaches it');
    expect(notes).toContain('coordinates of shared locations; the incident-reporting duty');
  });

  it('do not claim Orderly never stores payment numbers, or that logs are already checked', () => {
    expect(notes).not.toContain('never asks for or stores card, bank or CNIC numbers');
    expect(notes).toContain('A number a customer types anyway is kept with the chat');
    expect(notes).not.toContain('no customer data appears in server or gateway logs');
    expect(notes).toContain('still to be confirmed in the live function and Railway logs');
    expect(notes).toContain('does not use the word AI');
  });

  it('state the operational purge as the policy does', () => {
    expect(notes).toContain('deletes activity logs (traces) and delivery receipts never linked');
    expect(notes).toContain('clears the contents of finished jobs after 14 days');
  });
});
