// ai-pipeline-1: one customer sending 25 messages within a minute pauses only them for 15
// minutes. The minute is counted by when the messages were sent, so a flood queued behind slow
// replies is still caught.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../server/security';
import { modelFingerprint } from '../server/integrations/model-catalog';
import { createConversation } from '../src/domain/engine';
import { defaultBot } from '../src/shared/bot';
import type { Company, ModelInterpretation } from '../src/shared/types';
import { company, turnStore } from './helpers/fx2-turns';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generate,
  Output: { object: vi.fn() },
}));

const { repo, chat, say } = turnStore();
const BURST =
  'You’ve sent a lot of messages at once, so automatic replies are paused for 15 minutes. Our team can still see your messages.';
const menu: ModelInterpretation = {
  actions: [{ type: 'menu' }],
  response: { text: 'Here is our menu.', askFor: 'items' },
};
let configured: Company;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T10:00:00.000Z'));
  generate.mockReset();
  generate.mockResolvedValue({ output: menu, usage: { inputTokens: 1200, outputTokens: 80 } });
  const key = 'fictional-anthropic-key';
  await repo().saveIntegration(
    company.id,
    { kind: 'anthropic', configured: true, status: 'connected', config: {} },
    encryptSecret(key),
  );
  const base: Company = {
    ...company,
    botEnabled: true,
    ai: { provider: 'anthropic', model: 'claude-haiku-5-5', monthlyBudgetUsd: 10 },
    aiLimits: { repliesPerHour: 1000, repliesPerCustomerPerHour: 100 },
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
  await repo().saveCompany(configured);
});

describe('ai-pipeline-1: the burst limit counts messages by when they were sent', () => {
  it('pauses a backlog of 25 messages sent within seconds, though each answer takes 3 s', async () => {
    const customer = chat();
    const sent = Date.parse('2026-10-20T10:00:00.000Z');
    for (let i = 0; i < 24; i++) {
      // Answered 3 s apart, sent 0.4 s apart: a queue that grows behind slow replies.
      vi.setSystemTime(new Date(sent + 3000 * i + 2000));
      const turn = await say(configured, customer, 'what do you have?', {
        now: new Date(sent + 400 * i).toISOString(),
      });
      expect(turn.saved.mode, `message ${i + 1}`).toBe('bot');
    }
    expect(generate).toHaveBeenCalledTimes(24);
    vi.setSystemTime(new Date(sent + 3000 * 24 + 2000));
    const paused = await say(configured, customer, 'what do you have?', {
      now: new Date(sent + 400 * 24).toISOString(),
    });
    expect(paused.result.reply).toBe(BURST);
    expect(paused.saved.limitPause).toMatchObject({
      reason: 'burst',
      // 15 minutes from when the pause was decided, and it ends by itself.
      until: new Date(sent + 3000 * 24 + 2000 + 15 * 60000).toISOString(),
    });
    expect(generate).toHaveBeenCalledTimes(24);
  });

  it('does not pause 30 messages sent 3 s apart, even when they are all answered at once', async () => {
    const customer = chat();
    const sent = Date.parse('2026-10-20T09:55:00.000Z');
    for (let i = 0; i < 30; i++) {
      const turn = await say(configured, customer, 'what do you have?', {
        now: new Date(sent + 3000 * i).toISOString(),
      });
      expect(turn.saved.mode, `message ${i + 1}`).toBe('bot');
    }
    expect(generate).toHaveBeenCalledTimes(30);
  });

  it('ai-pipeline-8d: never pauses a test chat, whatever the per-minute setting', async () => {
    configured = {
      ...configured,
      aiLimits: { ...configured.aiLimits!, messagesPerCustomerPerMinute: 5 },
    };
    await repo().saveCompany(configured);
    const test = createConversation(company.id, 'demo-burst', 'demo', new Date().toISOString());
    for (let i = 0; i < 8; i++)
      expect((await say(configured, test, 'what do you have?')).saved.mode).toBe('bot');
    expect(generate).toHaveBeenCalledTimes(8);
  });
});
