import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { AiModelAdapter } from '../server/integrations/models';
import { createConversation } from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { Company, ModelInterpretation } from '../src/shared/types';

// Runs the real AI SDK and OpenAI provider with a stubbed network: this pins the request body
// OpenAI's Responses API receives. Nothing leaves the machine.
const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const answer: ModelInterpretation = {
  actions: [{ type: 'menu' }],
  response: { text: 'Here is our menu.', askFor: 'items' },
};

describe('F43/F73: the request OpenAI receives', () => {
  let repo: MemoryRepository;
  let requests: [string, RequestInit][];
  beforeEach(() => {
    repo = new MemoryRepository();
    requests = [];
    vi.stubGlobal('fetch', async (url: unknown, init: RequestInit) => {
      requests.push([String(url), init]);
      return new Response(
        JSON.stringify({
          id: 'resp_test',
          object: 'response',
          created_at: 1760000000,
          status: 'completed',
          model: 'gpt-5.4-mini',
          output: [
            {
              type: 'message',
              id: 'msg_test',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: JSON.stringify(answer), annotations: [] }],
            },
          ],
          usage: { input_tokens: 900, output_tokens: 40 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubEnv('APP_MODE', 'demo');
    vi.stubEnv('ORDERLY_RUNTIME', '');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('MODEL_PRICING_JSON', '');
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('asks OpenAI not to store the call, without strict schema mode, and reads the reply', async () => {
    const configured: Company = {
      ...company,
      ai: { provider: 'openai', model: 'gpt-5.4-mini', monthlyBudgetUsd: 10 },
      privacy: { aiDataApproved: true, retentionDays: 0 },
    };
    await repo.saveCompany(configured);
    await repo.saveIntegration(
      company.id,
      { kind: 'openai', configured: true, status: 'connected', config: {} },
      encryptSecret('fictional-openai-key'),
    );
    const result = await new AiModelAdapter(repo).interpret(
      configured,
      products,
      createConversation(company.id, '923000000321', 'demo', new Date().toISOString()),
      'menu please',
    );
    expect(requests).toHaveLength(1);
    const [url, init] = requests[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(String(init.body)) as {
      store?: boolean;
      include?: string[];
      text?: { format?: { type?: string; strict?: boolean } };
    };
    // No 30-day copy of customer conversations at OpenAI.
    expect(body.store).toBe(false);
    // A reasoning model still gets its reasoning back without stored state.
    expect(body.include).toContain('reasoning.encrypted_content');
    // OpenAI's strict mode refuses optional fields and oneOf; Orderly checks the reply itself.
    expect(body.text?.format).toMatchObject({ type: 'json_schema', strict: false });
    expect(result.actions).toEqual(answer.actions);
    const [ledger] = await repo.listUsage(company.id);
    expect(ledger).toMatchObject({ inputTokens: 900, outputTokens: 40, estimated: false });
  });
});
