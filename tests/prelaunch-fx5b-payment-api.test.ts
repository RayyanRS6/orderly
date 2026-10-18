// Payment methods are saved with the other business settings, and the AI is told about them.
// A cash-only business sends the AI exactly the words it always did, so its prompt cache holds.
// Local demo store, mocked AI SDK, no network.
import { describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../server/security';
import { AiModelAdapter } from '../server/integrations/models';
import { createConversation } from '../src/domain/engine';
import { seedProducts } from '../src/shared/seed';
import type { Company, ModelInterpretation, PaymentMethod } from '../src/shared/types';
import { company, demoApp } from './helpers/demo-app';
import { promptObject, systemText } from './helpers/model-call';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generate,
  Output: { object: vi.fn() },
}));

const app = demoApp();
const repo = () => app.repo();
const stored = async () => (await repo().getCompany(company.id))!;
const bootstrapCompany = async () =>
  ((await (await app.request('/bootstrap')).json()) as { company: Company }).company;
const save = (body: unknown) => app.request(`/companies/${company.id}`, { method: 'PUT', body });
const CASH_RULE =
  'Do not invent payment capabilities: current checkout records cash at pickup/on delivery, not card links or UPI.';

describe('saving payment methods', () => {
  it('saves the chosen methods and returns them with the settings', async () => {
    const copy = await bootstrapCompany();
    expect(copy.paymentMethods).toBeUndefined();
    const saved = await save({ ...copy, paymentMethods: ['cash', 'jazzcash', 'bank_transfer'] });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as Company).paymentMethods).toEqual([
      'cash',
      'jazzcash',
      'bank_transfer',
    ]);
    expect((await stored()).paymentMethods).toEqual(['cash', 'jazzcash', 'bank_transfer']);
    expect((await bootstrapCompany()).paymentMethods).toEqual([
      'cash',
      'jazzcash',
      'bank_transfer',
    ]);
  });

  it('refuses no method, a repeated one or one Orderly does not know', async () => {
    const copy = await bootstrapCompany();
    for (const [paymentMethods, error] of [
      [[], 'paymentMethods: Choose at least one way customers can pay.'],
      [['cash', 'cash'], 'paymentMethods: Choose each payment method only once.'],
      [['cash', 'upi'], 'paymentMethods.1:'],
      ['cash', 'paymentMethods: Choose how customers can pay.'],
    ] as const) {
      const refused = await save({ ...copy, paymentMethods });
      expect(refused.status, JSON.stringify(paymentMethods)).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toContain(error);
    }
    expect((await stored()).paymentMethods).toBeUndefined();
  });

  it('keeps the stored choice when a dashboard from before the setting saves', async () => {
    await repo().saveCompany({ ...company, paymentMethods: ['cash', 'easypaisa'] });
    const { paymentMethods: _left, ...older } = await bootstrapCompany();
    expect((await save({ ...older, name: 'Renamed' })).status).toBe(200);
    expect(await stored()).toMatchObject({
      name: 'Renamed',
      paymentMethods: ['cash', 'easypaisa'],
    });
  });
});

describe('what the AI is told about payment', () => {
  const products = seedProducts.filter((p) => p.companyId === company.id);
  const answer: ModelInterpretation = {
    actions: [{ type: 'answer', text: '' }],
    response: { text: 'We are open all day.', askFor: 'none', groundingIds: ['business:hours'] },
  };
  async function call(methods?: PaymentMethod[]) {
    const configured: Company = {
      ...company,
      ...(methods && { paymentMethods: methods }),
      ai: { provider: 'anthropic', model: 'claude-haiku-5-5', monthlyBudgetUsd: 10 },
      privacy: { aiDataApproved: true, retentionDays: 0 },
    };
    await repo().saveCompany(configured);
    await repo().saveIntegration(
      company.id,
      { kind: 'anthropic', configured: true, status: 'connected', config: {} },
      encryptSecret('fictional-anthropic-key'),
    );
    generate.mockReset();
    generate.mockResolvedValue({ output: answer, usage: { inputTokens: 2000, outputTokens: 300 } });
    await new AiModelAdapter(repo()).interpret(
      configured,
      products,
      createConversation(company.id, '923000000321', 'demo', new Date().toISOString()),
      'do you take jazzcash?',
    );
    const sent = generate.mock.calls[0]![0] as { system: unknown; prompt: string };
    return { system: systemText(sent.system), prompt: sent.prompt };
  }

  it('sends a cash-only business the same bytes, set or not', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-16T09:00:00.000Z'), toFake: ['Date'] });
    try {
      const unset = await call();
      expect(unset.system).toContain(CASH_RULE);
      const business = promptObject(unset).business as Record<string, unknown>;
      expect(business.paymentCapabilities).toEqual(['cash_at_pickup', 'cash_on_delivery']);
      expect(await call([])).toEqual(unset);
      expect(await call(['cash'])).toEqual(unset);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells the AI about transfers, and never to give or ask for account numbers', async () => {
    const { system, prompt } = await call(['bank_transfer', 'cash', 'jazzcash', 'easypaisa']);
    expect(system).not.toContain(CASH_RULE);
    expect(system).toContain(
      'Do not invent payment capabilities: customers may pay only as business.paymentCapabilities lists, never by card links or UPI. For a JazzCash, Easypaisa or bank transfer the restaurant shares its own payment details and confirms the transfer itself: never give, invent or ask for account, card or CNIC numbers, and never say a payment was received.',
    );
    expect(
      (promptObject({ prompt }).business as Record<string, unknown>).paymentCapabilities,
    ).toEqual([
      'cash_at_pickup',
      'cash_on_delivery',
      'jazzcash_transfer',
      'easypaisa_transfer',
      'bank_transfer',
    ]);
    const transfersOnly = await call(['easypaisa']);
    expect(
      (promptObject(transfersOnly).business as Record<string, unknown>).paymentCapabilities,
    ).toEqual(['easypaisa_transfer']);
  });
});
