import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { AiModelAdapter } from '../server/integrations/models';
import { createConversation } from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { Company, ModelInterpretation } from '../src/shared/types';

// Runs the real AI SDK and Anthropic provider with a stubbed network, so this pins the exact
// request body Anthropic receives. Nothing leaves the machine.
const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const answer: ModelInterpretation = {
  actions: [{ type: 'answer', text: '' }],
  response: { text: 'We are open all day.', askFor: 'none', groundingIds: ['business:hours'] },
};

describe('the request Anthropic receives', () => {
  let repo: MemoryRepository;
  let requests: [string, RequestInit][];
  let usage: Record<string, number>;
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-16T09:00:00.000Z'), toFake: ['Date'] });
    repo = new MemoryRepository();
    requests = [];
    usage = {
      input_tokens: 4000,
      output_tokens: 120,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    vi.stubGlobal('fetch', async (url: unknown, init: RequestInit) => {
      requests.push([String(url), init]);
      return new Response(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-5-5',
          content: [{ type: 'text', text: JSON.stringify(answer) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubEnv('APP_MODE', 'demo');
    vi.stubEnv('ORDERLY_RUNTIME', '');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('MODEL_PRICING_JSON', '');
    vi.stubEnv('PROMPT_CACHE', '');
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function interpret() {
    const configured: Company = {
      ...company,
      ai: { provider: 'anthropic', model: 'claude-haiku-5-5', monthlyBudgetUsd: 10 },
      privacy: { aiDataApproved: true, retentionDays: 0 },
    };
    await repo.saveCompany(configured);
    await repo.saveIntegration(
      company.id,
      { kind: 'anthropic', configured: true, status: 'connected', config: {} },
      encryptSecret('fictional-anthropic-key'),
    );
    const result = await new AiModelAdapter(repo).interpret(
      configured,
      products,
      createConversation(company.id, '923000000321', 'demo', new Date().toISOString()),
      'what time do you open?',
    );
    expect(requests).toHaveLength(1);
    const [url, init] = requests[0]!;
    return { url, init, body: JSON.parse(String(init.body)) as Record<string, unknown>, result };
  }

  it('sends the request captured before prompt caching', async () => {
    const { url, init, body } = await interpret();
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(new Headers(init.headers).get('anthropic-beta')).toBeNull();
    await expect(JSON.stringify(body, null, 2)).toMatchFileSnapshot(
      './__snapshots__/anthropic-request.default.json',
    );
  });
});
