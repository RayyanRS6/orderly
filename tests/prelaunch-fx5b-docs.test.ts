// The deployment guide, README and gateway guides describe the reminder, late order codes, the
// spam limits, worker leases, payment methods, gateway codes and pairing approval as the code
// does them.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIN_WORKER_LEASE_SECONDS, workerLeaseMs } from '../server/config';
import { pairingAllowed } from '../server/whatsapp/routes';
import { AI_LIMIT_DEFAULTS, AI_LIMIT_RANGES } from '../src/shared/models';
import { seedCompanies } from '../src/shared/seed';
import type { WhatsAppConnection } from '../src/shared/whatsapp';

// Windows checkouts may have CRLF line endings; prose is compared with its line breaks collapsed.
const read = (file: string) =>
  readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');
const prose = (file: string) => read(file).replace(/\s+/g, ' ');
const deployment = prose('docs/DEPLOYMENT.md');

afterEach(() => vi.unstubAllEnvs());

describe('the deployment guide', () => {
  it('words the order reminder as it is sent, with no claim that the order was flagged', () => {
    expect(deployment).toContain(
      'the customer gets one message saying the order is still waiting for the restaurant and that they will get a message here when the restaurant accepts or declines it',
    );
    expect(deployment).not.toContain('flagged');
    expect(read('server/service.ts')).toContain(
      'is still waiting for the restaurant to accept it. You’ll get a message here when they accept or decline it.',
    );
  });

  it('says a late menu-page code is shown again and must be sent again', () => {
    expect(deployment).toContain(
      'A code that reaches Orderly 10 minutes to 2 hours late (after an outage) is never placed by itself: the customer is shown the order again and asked to send the code once more',
    );
    expect(read('server/menu.ts')).toContain('To place it, send this code again:');
    expect(deployment).toContain(
      'that summary is timed from when it is sent, so the customer\'s next on-time "confirm" places the order',
    );
  });

  it('says the per-minute limit is editable in Bot settings, with its real range', () => {
    const [min, max] = AI_LIMIT_RANGES.messagesPerCustomerPerMinute;
    expect(deployment).toContain(
      `each editable per restaurant in **Bot settings → AI model → Limits** (the per-minute one is **Messages per customer per minute**, ${min} to ${max})`,
    );
    expect(deployment).toContain(
      `one person sending ${AI_LIMIT_DEFAULTS.messagesPerCustomerPerMinute} messages in a minute`,
    );
    expect(read('src/components/BotSettings.tsx')).toContain(
      'label="Messages per customer per minute"',
    );
  });

  it('gives the worker lease limits the server applies', () => {
    expect(deployment).toContain(
      `The server takes whole seconds from \`${MIN_WORKER_LEASE_SECONDS}\` to \`900\`; any other value (shorter, longer or not a whole number) falls back to \`180\``,
    );
    for (const [value, ms] of [
      ['159', 180_000],
      ['160', 160_000],
      ['900', 900_000],
      ['901', 180_000],
      ['200.5', 180_000],
    ] as const) {
      vi.stubEnv('WORKER_LEASE_SECONDS', value);
      expect(workerLeaseMs(), value).toBe(ms);
    }
  });

  it('describes payment methods, with cash at pickup or on delivery by default', () => {
    expect(deployment).toContain(
      'by default the order confirmation and the menu page tell customers to pay cash at pickup or on delivery',
    );
    expect(deployment).toContain('payment methods setting (`paymentMethods`');
    expect(deployment).toContain(
      'says the restaurant will share the payment details and confirm the transfer itself',
    );
    expect(deployment).toContain('replies come from the restaurant’s AI assistant');
    const readme = prose('README.md');
    expect(readme).toContain('A restaurant can also list JazzCash, Easypaisa or bank transfer');
    const notes = prose('docs/COMPLIANCE-NOTES-2026-10-18.md');
    expect(notes).toContain('the AI is told never to give or ask for account numbers');
  });

  it('explains the two gateway codes as the gateway uses them', () => {
    expect(deployment).toContain(
      '`PAIRING_EXPIRED`: a pairing nobody finished has ended and freed its place on the gateway',
    );
    expect(deployment).toContain(
      '`SESSION_CAPACITY_REACHED`: the gateway already runs `GATEWAY_MAX_SESSIONS` numbers',
    );
    const supervisor = read('gateway/src/supervisor.ts');
    expect(supervisor).toContain("this.park(session, 'SESSION_CAPACITY_REACHED')");
    expect(supervisor).toContain("session.errorCode === 'SESSION_CAPACITY_REACHED'");
    expect(supervisor).toContain("this.park(session, 'PAIRING_EXPIRED')");
  });
});

describe('the gateway guides on pairing approval', () => {
  const company = seedCompanies[0]!;
  const linked = (status: WhatsAppConnection['status']): WhatsAppConnection => ({
    id: '5f0c9a59-3c1e-4c55-9c7c-2f3d1a4b5c6d',
    companyId: company.id,
    provider: 'baileys',
    generation: 1,
    revision: 1,
    status,
    updatedAt: '2026-10-18T09:00:00.000Z',
  });

  it('say a revoke blocks every pairing, and only a phone still in use pairs without approval', () => {
    const railway = prose('gateway/RAILWAY.md');
    expect(railway).toContain(
      'An admin revoke (`{"allowed": false}`, recorded as `admin.linked_device.revoked`) blocks every further pairing for that business, including pairing its own phone again',
    );
    expect(railway).toContain(
      'only a business from before approvals whose linked phone is still in use (connected, connecting, reconnecting or waiting for its pairing to finish) may pair it again without approval',
    );
    expect(prose('gateway/README.md')).toContain(
      'An admin revoke blocks every further pairing for that business',
    );
    // As the server decides it.
    const revoked = { ...company, linkedDeviceAllowed: false };
    for (const status of ['connected', 'reconnecting', 'awaiting_pairing'] as const) {
      expect(pairingAllowed(revoked, linked(status)), status).toBe(false);
      expect(pairingAllowed(company, linked(status)), status).toBe(true);
    }
    for (const status of ['disconnected', 'logged_out', 'error'] as const)
      expect(pairingAllowed(company, linked(status)), status).toBe(false);
    expect(pairingAllowed({ ...company, linkedDeviceAllowed: true })).toBe(true);
  });
});
