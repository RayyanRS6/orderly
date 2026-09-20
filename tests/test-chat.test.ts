import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readTestChat, saveTestChat, testChatMatches } from '../src/lib/test-chat';
import { botSchema } from '../server/validation';
import { defaultBot, MAX_BOT_INSTRUCTIONS } from '../src/shared/bot';
import { createConversation, processTurn } from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import { MemoryRepository } from '../server/repository';
import { createApp } from '../server/app';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('expanded operator instructions', () => {
  it('accepts 20,000 characters and rejects overflow instead of silently truncating', () => {
    const instructions = 'x'.repeat(MAX_BOT_INSTRUCTIONS);
    expect(botSchema.parse({ ...defaultBot, instructions }).instructions).toBe(instructions);
    expect(botSchema.safeParse({ ...defaultBot, instructions: instructions + 'x' }).success).toBe(
      false,
    );
  });
  it('round trips long step-by-step instructions through draft storage and publication', async () => {
    vi.stubEnv('APP_MODE', 'demo');
    vi.stubEnv('ORDERLY_RUNTIME', '');
    vi.stubEnv('VERCEL', '');
    const company = seedCompanies[0]!;
    const repo = new MemoryRepository();
    const app = createApp(repo);
    const instructions = 'Answer the current question before continuing. '.repeat(350).trim();
    const headers = { 'x-company-id': company.id, 'Content-Type': 'application/json' };
    const saved = await app.request('http://localhost/api/bot/draft', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ config: { ...defaultBot, instructions }, revision: 0 }),
    });
    expect(saved.status).toBe(200);
    expect((await repo.getCompany(company.id))?.bot?.draft.instructions).toBe(instructions);
    const published = await app.request('http://localhost/api/bot/publish', {
      method: 'POST',
      headers,
      body: JSON.stringify({ revision: 1 }),
    });
    expect(published.status).toBe(200);
    expect((await repo.getCompany(company.id))?.bot?.published?.config.instructions).toBe(
      instructions,
    );
  });
});

describe('persistent test chat pointer', () => {
  it('remembers each restaurant independently and refresh clears only its active pointer', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const first = randomUUID(),
      second = randomUUID(),
      id = randomUUID();
    saveTestChat(first, { conversationId: id, target: 'published' });
    saveTestChat(second, { conversationId: randomUUID(), target: 'draft' });
    expect(readTestChat(first)).toEqual({ conversationId: id, target: 'published' });
    expect(
      [...values.values()].every((value) => !value.includes('messages') && !value.includes('cart')),
    ).toBe(true);
    saveTestChat(first, { target: 'published' });
    expect(readTestChat(first)).toEqual({ target: 'published' });
    expect(readTestChat(second).conversationId).toBeDefined();
  });
  it('survives disabled storage and ignores invalid stored IDs', () => {
    const companyId = randomUUID(),
      conversationId = randomUUID();
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw Error('disabled');
      },
      setItem: () => {
        throw Error('disabled');
      },
    });
    saveTestChat(companyId, { conversationId, target: 'draft' });
    expect(readTestChat(companyId).conversationId).toBe(conversationId);
    vi.stubGlobal('sessionStorage', {
      getItem: () => JSON.stringify({ target: 'draft', conversationId: '../other' }),
    });
    expect(readTestChat(randomUUID())).toEqual({ target: 'draft' });
  });
  it('does not invalidate a draft test for a catalog timestamp or unrelated publication change', () => {
    const company = seedCompanies[0]!;
    const c = processTurn(
      company,
      seedProducts,
      createConversation(company.id, 'demo', 'demo', new Date().toISOString()),
      {
        messageId: randomUUID(),
        text: 'menu',
        now: new Date().toISOString(),
        action: { type: 'menu' },
      },
    ).conversation;
    expect(
      testChatMatches({ ...company, catalogSyncedAt: new Date().toISOString() }, c, 'draft'),
    ).toBe(true);
    expect(
      testChatMatches({ ...company, ai: { ...company.ai, model: 'changed' } }, c, 'draft'),
    ).toBe(false);
    expect(testChatMatches({ ...company, id: randomUUID() }, c, 'draft')).toBe(false);
    expect(testChatMatches(company, { ...c, channel: 'whatsapp' }, 'draft')).toBe(false);
    expect(testChatMatches(company, c, 'published')).toBe(false);
  });
});
