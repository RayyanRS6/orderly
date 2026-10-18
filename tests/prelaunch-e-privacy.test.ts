import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { erasedMessage, NO_CUSTOMER_RECORDS, SecuritySettings } from '../src/components/Operations';
import { supportEmail } from '../src/components/Public';
import { seedCompanies } from '../src/shared/seed';
import { bootstrap, render } from './prelaunch-e-helpers';

const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');

describe('customer data requests', () => {
  it('reports what was really removed, and the server’s words when nothing matched', () => {
    expect(erasedMessage(1)).toBe(
      'Removed 1 conversation and their orders from Orderly’s active database.',
    );
    expect(erasedMessage(3)).toMatch(/^Removed 3 conversations/);
    expect(source('server/management.ts')).toContain(`'${NO_CUSTOMER_RECORDS}'`);
  });

  it('keeps the deletion dialog open on "No records found", and the export shows it as a note', () => {
    const page = source('src/components/Operations.tsx');
    expect(page).toContain('if (e instanceof ApiError && e.status === 404) return e.message;');
    expect(page).toMatch(/notify\(erasedMessage\(r\.deleted\)\);[\s\S]*?setEraseError\(/);
  });

  it('names the support address from the Contact page', () => {
    const html = render(
      SecuritySettings,
      bootstrap({ company: { ...seedCompanies[0]!, botEnabled: false } }),
      'security',
    );
    expect(html).toContain(`href="mailto:${supportEmail}"`);
    expect(source('src/components/Operations.tsx')).not.toMatch(/mailto:[a-z0-9]/i);
  });
});
