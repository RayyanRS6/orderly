// The takeover clock on the whole migration chain: waiting_since in
// 202610200001_prelaunch_fixes.sql counts a customer waiting for staff from staff's takeover
// (humanSince) when that is later than their message, for the bell and email alerts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createConversation } from '../src/domain/engine';
import { seedCompanies } from '../src/shared/seed';
import type { Conversation, Message, StaffAttention } from '../src/shared/types';
import { migratedDb } from './helpers/migrated-db';

const company = seedCompanies[0]!;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
let t: Awaited<ReturnType<typeof migratedDb>>;
const scalar = <T = unknown>(text: string, args: unknown[] = []) => t.scalar<T>(text, args);
const rpc = <T = unknown>(name: string, args: unknown[] = []) => t.rpc<T>(name, args);
beforeAll(async () => {
  t = await migratedDb();
}, 30000);
beforeEach(() => t.reset());
afterAll(() => t.db.close());

async function chat(phone: string, extra: Partial<Conversation> = {}) {
  const c = {
    ...createConversation(company.id, `${phone}:${randomUUID()}`, 'whatsapp', minutesAgo(60)),
    customerPhone: phone,
    ...extra,
    version: 1,
  };
  expect(await rpc('save_conversation', [c, 0])).toBe(true);
  return c;
}

describe('the takeover clock (waiting_since with humanSince)', () => {
  const message = (role: Message['role'], text: string, createdAt: string): Message => ({
    id: randomUUID(),
    role,
    text,
    createdAt,
  });
  const since = async (c: Conversation) => {
    const item = (await rpc<StaffAttention>('staff_attention', [company.id])).items.find(
      (a) => a.id === `handoff:${c.id}`,
    );
    return item && Date.parse(item.createdAt);
  };
  const overdue = (minutes: number) => rpc<boolean>('has_overdue_attention', [company.id, minutes]);

  it('counts from the takeover when the bot had answered the customer before it', async () => {
    const asked = minutesAgo(120);
    const takenOver = minutesAgo(2);
    const c = await chat('923001110001', {
      mode: 'human',
      humanSince: takenOver,
      messages: [
        message('customer', 'Do you deliver?', asked),
        message('assistant', 'Yes.', asked),
      ],
      updatedAt: takenOver,
    });
    expect(await since(c)).toBe(Date.parse(takenOver));
    expect(await overdue(10)).toBe(false);
    // Without the takeover time the same chat counts from the customer's message.
    const old = await chat('923001110002', {
      mode: 'human',
      messages: [message('customer', 'Do you deliver?', asked)],
      updatedAt: takenOver,
    });
    expect(await since(old)).toBe(Date.parse(asked));
    expect(await overdue(10)).toBe(true);
  });

  it('counts from a customer message written after the takeover', async () => {
    const takenOver = minutesAgo(30);
    const asked = minutesAgo(12);
    const c = await chat('923001110003', {
      mode: 'human',
      humanSince: takenOver,
      messages: [message('customer', 'Hello?', asked)],
      updatedAt: asked,
    });
    expect(await since(c)).toBe(Date.parse(asked));
    expect(await overdue(10)).toBe(true);
    expect(await overdue(15)).toBe(false);
  });

  it('keeps the two-argument form for callers that pass no takeover time', async () => {
    const asked = minutesAgo(20);
    expect(
      await scalar<boolean>(
        'select public.waiting_since($1::jsonb,now())=$2::timestamptz as value',
        [JSON.stringify([message('customer', 'Hi', asked)]), asked],
      ),
    ).toBe(true);
  });
});
