// customer-wording-4: the Agent flow page and the compliance notes word a transfer as the chat
// does: the customer types "staff", and restaurant staff send the payment details.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryRepository } from '../server/repository';
import { buildAgentFlow } from '../server/agent-flow';
import { orderReceivedText } from '../src/domain/engine';
import { seedCompanies } from '../src/shared/seed';
import type { Company, Order, PaymentMethod } from '../src/shared/types';

// Windows checkouts may have CRLF line endings; prose is compared with its line breaks collapsed.
const prose = (file: string) =>
  readFileSync(join(process.cwd(), file), 'utf8').replace(/\s+/g, ' ');

describe('a transfer is worded as the chat words it', () => {
  const company = seedCompanies[0]!;
  const methods: PaymentMethod[] = ['cash', 'jazzcash'];
  const transfers: Company = { ...company, paymentMethods: methods };
  beforeEach(() => {
    vi.stubEnv('APP_MODE', 'demo');
    vi.stubEnv('ORDERLY_RUNTIME', '');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('MODEL_PRICING_JSON', '');
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  });
  afterEach(() => vi.unstubAllEnvs());

  it('tells the customer to type “staff”, and staff send the details, everywhere', async () => {
    const order = { reference: 'A1B2', total: 900, fulfillment: 'pickup' } as Order;
    const chat = orderReceivedText('en', order, methods);
    expect(chat).toContain(
      'type “staff” here and restaurant staff will send the payment details and confirm the transfer themselves',
    );
    const flow = await buildAgentFlow(new MemoryRepository(), transfers, 'owner');
    const fixed = flow.nodes.find((node) => node.id === 'knowledge')!.fixed ?? [];
    const rule = fixed.find((line) => line.startsWith('Payment options are'))!;
    expect(rule).toContain(
      'the customer types “staff” in the chat, and restaurant staff send the payment details and confirm the transfer themselves',
    );
    const notes = prose('docs/COMPLIANCE-NOTES-2026-10-18.md');
    expect(notes).toContain(
      'has the order confirmation tell customers to type "staff", so restaurant staff send the payment details and confirm the transfer themselves',
    );
    expect(notes).toContain(
      'then names them and tells the customer to type "staff", so restaurant staff send the payment details and confirm the transfer themselves',
    );
    for (const stale of ['share the payment details', 'shares its payment details']) {
      expect(rule).not.toContain(stale);
      expect(notes).not.toContain(stale);
    }
    // Cash only keeps its words.
    const cashOnly = await buildAgentFlow(new MemoryRepository(), company, 'owner');
    expect(cashOnly.nodes.find((node) => node.id === 'knowledge')!.fixed).toContain(
      'Payment options are cash on pickup or delivery.',
    );
  });
});
