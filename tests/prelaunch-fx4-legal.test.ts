// The privacy policy and the compliance notes say what the code keeps, sends and purges, and
// filling in the owner's placeholders keeps CI green.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LegalPage } from '../src/components/Legal';
import { ownerFact, ownerFactProblems, withOwnerFact } from './prelaunch-fx9-helpers';

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

const backup = read('docs/BACKUP-AND-RESTORE.md');

// What `npm test` checks about the owner's facts (ownerFactProblems) is shared with the fx9 tests,
// which try every way the owner may write them (tests/prelaunch-fx9-helpers.ts).
describe('owner facts in the legal pages', () => {
  const source = read('src/components/Legal.tsx');

  it('are filled in before the dashboard publishes them, and a mistake still fails CI', () => {
    expect(source).not.toContain('OWNER TO CONFIRM');
    expect(ownerFactProblems(source)).toEqual([]);
    expect(ownerFactProblems(withOwnerFact(source, 'ONE_OFF_COPY_DAYS', "'a month'"))).toEqual([
      'ONE_OFF_COPY_DAYS is a month, not a number of days',
    ]);
  });

  it('render the operator and the one-off copy period wherever the pages state them', () => {
    const operator = ownerFact(source, 'OPERATOR');
    const copyDays = ownerFact(source, 'ONE_OFF_COPY_DAYS');
    expect(operator).toBeTruthy();
    expect(copyDays).toMatch(/^\d+$/);
    expect(privacy).toContain(`Orderly is run by ${operator}.`);
    expect(legal('terms')).toContain(`run by ${operator}.`);
    expect(privacy).toContain(`such a copy is deleted within ${copyDays} days.`);
    expect(deletion).toContain(`is deleted within ${copyDays} days of being made.`);
    expect(legal('terms')).toContain(`is deleted within ${copyDays} days of being made.`);
    // The erase dialog in the dashboard says the same.
    expect(read('src/components/CustomerData.tsx')).toContain(
      `a one-off copy saved before a database update is deleted within ${copyDays} days.`,
    );
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

  // The owner keeps no regular backups (19 October 2026), so the pages claim none.
  it('says Orderly keeps no regular backups, and nothing about copies it does not make', () => {
    expect(privacy).toContain('Orderly keeps no regular backups of its database.');
    for (const page of [privacy, deletion, legal('terms')])
      expect(page).not.toMatch(/two newest copies|recycle bin|backups are kept for|backups expire/);
    expect(read('src/components/CustomerData.tsx')).not.toContain('encrypted backups expire');
    // The other deletion screens no longer ask restaurants to handle Orderly's backups.
    for (const file of ['src/components/Operations.tsx', 'src/components/RetentionSettings.tsx'])
      expect(read(file).replace(/\s+/g, ' '), file).not.toMatch(/and backups (require|separately)/);
    // The guide's nightly task is not running, and says to change the policy before starting it.
    expect(backup).toContain('the privacy policy says Orderly keeps no regular backups');
    // The runbook and README no longer rely on backups that expire on their own.
    expect(read('docs/INCIDENT-RUNBOOK.md')).not.toMatch(
      /expires with the others|backups until they expire/,
    );
    expect(read('README.md')).not.toContain('the pilot stays on Free with a nightly');
  });

  it('does not claim no IP address is stored, since sign-ins record one', () => {
    expect(privacy).not.toContain('so the raw IP address is not stored.');
    expect(privacy).toContain('records the IP address and browser of each dashboard sign-in');
  });

  it('words payment as the bot and the menu page do', () => {
    // What customers are told today: cash at pickup or on delivery.
    expect(read('src/domain/engine.ts')).toContain('Payment is cash ${order.fulfillment');
    // The menu page words payment through src/lib/payments.ts: cash only keeps 'pay in cash'
    // and 'Pay cash on delivery/at pickup'; transfers appear only when the restaurant takes them.
    const menu = read('src/components/MenuPage.tsx');
    expect(menu).toContain('paymentSentence(paymentMethodsOf(restaurant)');
    expect(menu).toContain('paymentShort(paymentMethodsOf(restaurant))');
    const payments = read('src/lib/payments.ts');
    expect(payments).toContain("return 'pay in cash'");
    expect(payments).toContain(
      'type “staff” in WhatsApp and restaurant staff will send the details.',
    );
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
    // The notice now says "AI assistant", in the words of the disclosure rule.
    expect(notes).not.toContain('does not use the word AI');
    expect(notes).toContain(
      `The notice itself uses the rule's word: "<Restaurant>'s AI assistant"`,
    );
  });

  it('state the operational purge as the policy does', () => {
    expect(notes).toContain('deletes activity logs (traces) and delivery receipts never linked');
    expect(notes).toContain('clears the contents of finished jobs after 14 days');
  });
});
