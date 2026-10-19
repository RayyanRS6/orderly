import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../server/repository';
import { encryptSecret, PublicError } from '../server/security';
import { handleTurn } from '../server/service';
import { readiness } from '../server/readiness';
import { GoogleSheetsAdapter } from '../server/integrations/sheets';
import { createConversation, processTurn } from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotAction, Company, Conversation } from '../src/shared/types';

// A business whose menu comes from a Google Sheet, answered by the built-in rules.
const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
let repo: MemoryRepository;
let read: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  repo = new MemoryRepository();
  vi.stubEnv('APP_MODE', 'demo');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  await repo.saveIntegration(
    company.id,
    {
      kind: 'sheets',
      configured: true,
      status: 'connected',
      config: { spreadsheetId: 'sheet-id', catalogSheet: 'Menu' },
    },
    encryptSecret('unused-private-key'),
  );
  read = vi
    .spyOn(GoogleSheetsAdapter.prototype, 'readCatalog')
    .mockRejectedValue(new PublicError('Row 14 is invalid: price “1,200” is not a number.', 422));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const sheetMenu = async (minutesAgo?: number): Promise<Company> => {
  const configured: Company = {
    ...company,
    catalogSource: 'sheets',
    catalogSyncedAt:
      minutesAgo === undefined
        ? undefined
        : new Date(Date.now() - minutesAgo * 60000).toISOString(),
  };
  await repo.saveCompany(configured);
  return configured;
};
let phoneCounter = 0;
const newCustomer = () =>
  createConversation(
    company.id,
    `9230077${String(++phoneCounter).padStart(5, '0')}`,
    'whatsapp',
    '1970-01-01T00:00:00.000Z',
  );
async function message(configured: Company, conversation: Conversation, text: string) {
  const current = (await repo.getConversation(company.id, conversation.id)) ?? conversation;
  const result = await handleTurn(repo, configured, current, {
    messageId: randomUUID(),
    text,
    now: new Date().toISOString(),
  });
  return { result, saved: (await repo.getConversation(company.id, conversation.id))! };
}
const sheets = async () =>
  (await repo.getIntegrations(company.id)).find((i) => i.kind === 'sheets')!;

describe('G1.1: a menu Sheet that cannot be read', () => {
  it('keeps answering from the menu last read, shows why, and tries at most once a minute', async () => {
    // Refreshes are limited per clock minute: both chats at a fixed mid-minute time.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T09:00:30.000Z'));
    const configured = await sheetMenu(5);
    const { result, saved } = await message(configured, newCustomer(), 'menu');
    expect(saved.mode).toBe('bot');
    expect(result.reply).toContain('Chicken Biryani');
    expect(read).toHaveBeenCalledTimes(1);
    expect(await sheets()).toMatchObject({
      status: 'connected',
      error: 'Menu refresh failed: Row 14 is invalid: price “1,200” is not a number.',
    });
    // Settings can still be saved with the bot on: the connection still counts as tested.
    expect((await readiness(repo, configured)).find((c) => c.id === 'sheets')?.ready).toBe(true);
    const trace = (await repo.listTraces(company.id)).find((t) => t.action === 'menu_sync_stale');
    expect(trace?.detail).toContain('Row 14 is invalid');
    // The last good refresh time is unchanged.
    expect((await repo.getCompany(company.id))!.catalogSyncedAt).toBe(configured.catalogSyncedAt);
    // Other chats in the same minute do not read the Sheet again.
    expect((await message(configured, newCustomer(), 'menu')).saved.mode).toBe('bot');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('clears the note once the Sheet can be read again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T10:00:00.000Z'));
    const configured = await sheetMenu(5);
    await message(configured, newCustomer(), 'menu');
    expect((await sheets()).error).toContain('Menu refresh failed');
    read.mockResolvedValue(products);
    vi.setSystemTime(new Date('2026-10-18T10:01:30.000Z'));
    await message(configured, newCustomer(), 'menu');
    expect(read).toHaveBeenCalledTimes(2);
    expect((await sheets()).error).toBeUndefined();
    expect((await sheets()).status).toBe('connected');
  });

  it.each([
    ['was never read', undefined],
    ['was last read more than 12 hours ago', 13 * 60],
  ])('hands the chat to staff when the menu %s', async (_case, minutesAgo) => {
    const configured = await sheetMenu(minutesAgo);
    const { saved, result } = await message(configured, newCustomer(), 'menu');
    expect(saved.mode).toBe('human');
    expect(result.explanation?.notice).toBe('menu_sync');
  });

  it('cancels a waiting order without reading the Sheet', async () => {
    const configured = await sheetMenu(5);
    let c: Conversation = { ...newCustomer(), version: 0 };
    const step = (action: BotAction) => {
      const result = processTurn(configured, products, c, {
        messageId: randomUUID(),
        text: action.type === 'confirm' ? 'confirm' : 'step',
        action,
        now: new Date().toISOString(),
      });
      c = result.conversation;
      return result;
    };
    step({ type: 'add_item', productId: products[0]!.id, quantity: 1 });
    step({ type: 'set_details', customerName: 'Ali Raza', fulfillment: 'pickup' });
    step({ type: 'review' });
    const placed = step({ type: 'confirm' });
    c.version = 1;
    await repo.commitTurn(company.id, c, 0, placed.order);
    const { result } = await message(configured, c, 'cancel please');
    expect(result.order?.status).toBe('cancelled');
    expect(read).not.toHaveBeenCalled();
  });
});
