// Final review, fx-6 (ai-pipeline-4): staff are told an AI-error pause needs their reply, since
// nothing answers that message by itself later.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { handleTurn } from '../server/service';
import { modelFingerprint } from '../server/integrations/model-catalog';
import { createConversation } from '../src/domain/engine';
import { defaultBot } from '../src/shared/bot';
import { seedCompanies } from '../src/shared/seed';
import type { Company, Conversation } from '../src/shared/types';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generate,
  Output: { object: vi.fn() },
}));

const company = seedCompanies[0]!;
const key = 'fictional-anthropic-key';
let repo: MemoryRepository;
let configured: Company;

beforeEach(async () => {
  generate.mockReset();
  repo = new MemoryRepository();
  vi.stubEnv('APP_MODE', 'demo');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('APP_URL', 'http://127.0.0.1:5173');
  vi.stubEnv('MODEL_PRICING_JSON', '');
  vi.stubEnv('ORDERLY_PAUSE_AUTOMATION', '');
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  await repo.saveIntegration(
    company.id,
    { kind: 'anthropic', configured: true, status: 'connected', config: {} },
    encryptSecret(key),
  );
  const base: Company = {
    ...company,
    botEnabled: true,
    ai: { provider: 'anthropic', model: 'claude-haiku-5-5', monthlyBudgetUsd: 10 },
    privacy: { aiDataApproved: true, retentionDays: 0 },
    bot: { draft: { ...defaultBot, language: 'en' }, revision: 1, history: [] },
  };
  configured = {
    ...base,
    modelVerification: {
      fingerprint: modelFingerprint(base, key),
      checkedAt: new Date().toISOString(),
    },
  };
  await repo.saveCompany(configured);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function message(conversation: Conversation, text: string) {
  const current = (await repo.getConversation(company.id, conversation.id)) ?? conversation;
  const result = await handleTurn(repo, configured, current, {
    messageId: randomUUID(),
    text,
    now: new Date().toISOString(),
  });
  return { result, saved: (await repo.getConversation(company.id, conversation.id))! };
}

describe('an AI error pause', () => {
  it('tells staff this message needs their reply', async () => {
    generate.mockRejectedValue(new Error('upstream failure'));
    const customer = createConversation(
      company.id,
      '923006600999',
      'whatsapp',
      '1970-01-01T00:00:00.000Z',
    );
    const { saved } = await message(customer, 'what do you have?');
    expect(saved.limitPause?.reason).toBe('ai_error');
    const trace = (await repo.listTraces(company.id)).find((t) => t.action === 'staff_attention');
    expect(trace?.detail).toContain(
      'This message needs a staff reply; the bot answers the customer’s next message from 10 minutes on.',
    );
    expect(trace?.detail).not.toContain('tries again');
  });
});
