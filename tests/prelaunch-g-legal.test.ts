import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGAL_LAST_UPDATED, LegalPage } from '../src/components/Legal';
import { supportEmail } from '../src/components/Public';
import { MenuPage } from '../src/components/MenuPage';

const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');
// Collapses markup and HTML entities so copy can be compared as one sentence.
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
const legal = (kind: 'privacy' | 'terms' | 'data-deletion') =>
  text(renderToStaticMarkup(createElement(LegalPage, { kind })));

describe('privacy policy matches what the software does', () => {
  const privacy = legal('privacy');

  it('names the restaurant as controller and Orderly as processing on its behalf', () => {
    expect(privacy).toContain('Each restaurant is the controller');
    expect(privacy).toContain('Orderly processes it on the restaurant’s behalf');
  });

  it('lists what is collected, including the menu page and technical data', () => {
    for (const item of [
      'your name',
      'WhatsApp number or WhatsApp ID',
      'delivery address',
      'messages you send and receive',
      'menu page',
      'email address',
      'rate-limit keys made from your IP address',
    ])
      expect(privacy).toContain(item);
  });

  it('names every service that receives customer data, with the database region', () => {
    for (const processor of [
      'Supabase',
      'Sydney, Australia',
      'Cloudflare',
      'Meta (WhatsApp)',
      'Railway',
      'only for restaurants that use the linked-phone connection',
      'OpenAI, Anthropic or Google',
      'Google Sheets',
      'Resend',
    ])
      expect(privacy).toContain(processor);
    expect(privacy).toContain('outside Pakistan');
  });

  it('says replies are automated and how to reach a person', () => {
    expect(privacy).toContain('automated assistant that uses AI');
    expect(privacy).toContain('“staff”');
  });

  it('states retention, requests, payments, incidents and changes plainly', () => {
    expect(privacy).toContain('until the restaurant deletes them');
    expect(privacy).toContain('about 90 days');
    expect(privacy).toContain('contact the restaurant you ordered from');
    expect(privacy).toContain('Orderly support helps restaurants');
    expect(privacy).toContain(
      'Orderly does not collect card numbers, bank account details or CNIC numbers',
    );
    for (const method of ['cash', 'JazzCash', 'Easypaisa', 'bank transfer'])
      expect(privacy).toContain(method);
    expect(privacy).toContain('tells the affected restaurants without undue delay');
    expect(privacy).toContain('Changes to this policy');
  });

  it('uses the one support address and a current date on every document', () => {
    expect(read('src/components/Legal.tsx')).not.toContain('@gmail.com');
    for (const kind of ['privacy', 'terms', 'data-deletion'] as const) {
      const page = legal(kind);
      expect(page).toContain(`Last updated ${LEGAL_LAST_UPDATED}`);
      expect(page).not.toContain('Effective 16 September 2026');
    }
    expect(privacy).toContain(supportEmail);
    expect(legal('data-deletion')).toContain(supportEmail);
  });

  it('marks facts only the owner can supply instead of inventing them', () => {
    // The visible marker until the owner fills it in, then their own value: either must pass,
    // or filling it in would block every backend deploy.
    const operator =
      read('src/components/Legal.tsx').match(/const OPERATOR =\s*(['"`])(.+?)\1;/)?.[2] ?? '';
    expect(operator).toMatch(/^\[OWNER TO CONFIRM: legal name and address[^\]]*\]$|^[^[\]]+$/);
  });

  it('claims no certification or guarantee', () => {
    for (const kind of ['privacy', 'terms', 'data-deletion'] as const)
      expect(legal(kind)).not.toMatch(/certified|ISO 27001|SOC 2|guarantee|100% secure/i);
  });
});

describe('terms and deletion page', () => {
  const terms = legal('terms');
  const deletion = legal('data-deletion');

  it('promises workspace deletion only as something Orderly does on request', () => {
    expect(terms).toContain('Orderly deletes a workspace on request');
    expect(terms).toContain('not from the dashboard');
    expect(deletion).toContain('Orderly does this by hand');
    for (const page of [terms, deletion, legal('privacy')])
      expect(page).not.toMatch(/(owners?|business) can delete (its|their|the) (whole )?workspace/i);
  });

  it('commits to telling businesses about security incidents', () => {
    expect(terms).toContain('Security incidents');
    expect(terms).toContain('tells the business without undue delay');
  });

  it('spells out the linked-phone risk and the AI and tax duties', () => {
    expect(terms).toContain('It is against WhatsApp’s terms');
    expect(terms).toContain('temporarily or permanently');
    expect(terms).toContain('whether prices include sales tax');
    expect(terms).toContain('paid plan whose terms do not allow the provider');
    expect(terms).toContain('Free Google Gemini keys');
    expect(terms).toContain('card numbers, bank account numbers or CNIC numbers');
  });

  it('says what deletion leaves behind', () => {
    expect(deletion).toContain('Security audit records');
    expect(deletion).toContain('backups');
    expect(deletion).toContain('WhatsApp → Linked devices');
  });
});

describe('menu page privacy link', () => {
  it('links the Privacy Policy from every state of the page, starting with loading', () => {
    const html = renderToStaticMarkup(createElement(MenuPage, { slug: 'dastarkhwan' }));
    expect(html).toContain('Opening the menu…');
    expect(html).toContain('href="/privacy"');
  });
});
