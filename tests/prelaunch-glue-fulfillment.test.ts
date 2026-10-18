// Pickup and delivery as customers can actually choose them (F37): the readiness check and what
// the AI is told, both from offeredFulfillment, as the chat and the menu page use it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { AiModelAdapter } from '../server/integrations/models';
import { readiness } from '../server/readiness';
import { createConversation } from '../src/domain/engine';
import { defaultBot } from '../src/shared/bot';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotConfig, Company, ModelInterpretation } from '../src/shared/types';
import { systemText } from './helpers/model-call';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generate,
  Output: { object: vi.fn() },
}));

const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const answer: ModelInterpretation = {
  actions: [{ type: 'answer', text: '' }],
  response: { text: 'We are open all day.', askFor: 'none', groundingIds: ['business:hours'] },
};
const published = (fulfillment: BotConfig['fulfillment']): Company['bot'] => {
  const bot = { ...defaultBot, fulfillment };
  return {
    draft: bot,
    revision: 1,
    history: [],
    published: {
      version: 1,
      config: bot,
      publishedAt: new Date().toISOString(),
      publishedBy: 'test',
    },
  };
};
let repo: MemoryRepository;
beforeEach(async () => {
  generate.mockReset();
  generate.mockResolvedValue({ output: answer, usage: { inputTokens: 2000, outputTokens: 300 } });
  repo = new MemoryRepository();
  vi.stubEnv('APP_MODE', 'demo');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('MODEL_PRICING_JSON', '');
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  await repo.saveIntegration(
    company.id,
    { kind: 'anthropic', configured: true, status: 'connected', config: {} },
    encryptSecret('fictional-anthropic-key'),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the delivery-area readiness check', () => {
  const ready = async (fields: Partial<Company>) =>
    (await readiness(repo, { ...company, ...fields })).find((c) => c.id === 'fulfillment');

  it('flags only delivery-only without a delivery area', async () => {
    expect(await ready({ bot: published('delivery'), deliveryZones: [] })).toEqual({
      id: 'fulfillment',
      label: 'Add a delivery area, or offer pickup',
      ready: false,
    });
    // "Pickup and delivery" without an area is pickup only, which works.
    expect((await ready({ bot: published('both'), deliveryZones: [] }))!.ready).toBe(true);
    expect((await ready({ bot: published('pickup'), deliveryZones: [] }))!.ready).toBe(true);
    expect((await ready({ bot: published('delivery') }))!.ready).toBe(true);
    expect((await ready({}))!.ready).toBe(true);
  });
});

describe('the fulfillment the AI is told about', () => {
  async function told(
    fulfillment: BotConfig['fulfillment'],
    deliveryZones = company.deliveryZones,
  ) {
    const configured: Company = {
      ...company,
      deliveryZones,
      ai: { provider: 'anthropic', model: 'claude-haiku-5-5', monthlyBudgetUsd: 10 },
      privacy: { aiDataApproved: true, retentionDays: 0 },
      bot: published(fulfillment),
    };
    await repo.saveCompany(configured);
    await new AiModelAdapter(repo).interpret(
      configured,
      products,
      createConversation(company.id, '923000000321', 'demo', new Date().toISOString()),
      'do you deliver?',
    );
    const system = systemText((generate.mock.calls.at(-1)![0] as { system: unknown }).system);
    return /"fulfillment":"([a-z]+)"/.exec(system)?.[1];
  }

  it('is what customers can actually choose', async () => {
    expect(await told('both')).toBe('both');
    expect(await told('delivery')).toBe('delivery');
    expect(await told('pickup', [])).toBe('pickup');
    // "Pickup and delivery" without a delivery area is pickup only.
    expect(await told('both', [])).toBe('pickup');
    // Delivery only without an area offers nothing, never "delivery".
    expect(await told('delivery', [])).toBe('none');
  });
});
