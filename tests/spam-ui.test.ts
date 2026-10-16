import { describe, expect, it } from 'vitest';
import { conversationFlags, limitNote } from '../src/components/Inbox';
import { describeAlert } from '../src/components/StaffAlerts';
import { clockTime } from '../src/components/ui';
import { seedCompanies, seedConversations } from '../src/shared/seed';
import type { AiLimitKind, Conversation, StaffAttention } from '../src/shared/types';

const now = Date.parse('2026-10-16T10:20:00.000Z');
const until = '2026-10-16T11:00:00.000Z';
const paused = (
  reason: AiLimitKind,
  extra: Partial<Conversation> = {},
  limit = 30,
): Conversation => ({
  ...seedConversations[0]!,
  channel: 'whatsapp',
  customerPhone: '+923001234567',
  mode: 'human',
  limitPause: { reason, at: '2026-10-16T10:05:00.000Z', until, limit },
  ...extra,
});

describe('clockTime', () => {
  it('writes a time of day the way the notes read it', () => {
    expect(clockTime(until)).toMatch(/^\d{1,2}:\d{2} (am|pm)$/);
    expect(clockTime('not a date')).toBe('');
    expect(clockTime(undefined)).toBe('');
  });
});

describe('Inbox spam-protection flags', () => {
  it('marks a blocked chat and offers only unblocking', () => {
    const flags = conversationFlags(
      paused('hourly', { blocked: { at: '2026-10-16T10:10:00.000Z', blockId: 'b1' } }),
      now,
    );
    expect(flags.badge).toBe('blocked');
    expect(flags.blocked).toBe(true);
    expect(flags.canBlock).toBe(false);
    expect(flags.limitNote).toBe(false);
  });

  it('marks a chat the bot paused for a limit', () => {
    const flags = conversationFlags(paused('customer'), now);
    expect(flags.badge).toBe('limit');
    expect(flags.limitNote).toBe(true);
    expect(flags.limitOver).toBe(false);
    expect(flags.canBlock).toBe(true);
    expect(conversationFlags(paused('customer'), Date.parse(until) + 1000).limitOver).toBe(true);
  });

  it('drops the limit badge once staff decided', () => {
    // Back with the bot, or a staff member wrote after the pause began.
    expect(conversationFlags(paused('hourly', { mode: 'bot' }), now).badge).toBeUndefined();
    const replied = paused('hourly');
    replied.messages = [
      ...replied.messages,
      {
        id: 's1',
        role: 'staff',
        text: 'Hi, how can I help?',
        createdAt: '2026-10-16T10:15:00.000Z',
      },
    ];
    expect(conversationFlags(replied, now).badge).toBeUndefined();
    expect(limitNote(replied, now)).toBe('');
    // An automatic notice is not a staff decision.
    const noticed = paused('hourly');
    noticed.messages = [
      ...noticed.messages,
      {
        id: 'n1',
        role: 'staff',
        text: 'Order accepted',
        createdAt: '2026-10-16T10:15:00.000Z',
        notice: true,
      },
    ];
    expect(conversationFlags(noticed, now).badge).toBe('limit');
  });

  it('lets the bot-off note speak first', () => {
    const both = paused('hourly', { botPausedAt: '2026-10-16T10:06:00.000Z' });
    expect(conversationFlags(both, now).badge).toBe('limit');
    expect(conversationFlags(both, now).limitNote).toBe(false);
    expect(limitNote(both, now)).toBe('');
  });

  it('offers blocking only for WhatsApp chats with a number', () => {
    expect(conversationFlags({ ...paused('hourly'), channel: 'demo' }, now).canBlock).toBe(false);
    expect(conversationFlags({ ...paused('hourly'), customerPhone: '' }, now).canBlock).toBe(false);
    expect(
      conversationFlags(
        {
          ...paused('hourly'),
          customerPhone: '',
          whatsappAddress: {
            connectionId: 'c',
            generation: 1,
            provider: 'baileys',
            peer: '12345678@lid',
          },
        },
        now,
      ).canBlock,
    ).toBe(true);
  });
});

describe('limitNote', () => {
  const back = clockTime(until);
  it('explains each limit before the pause ends', () => {
    expect(limitNote(paused('hourly'), now)).toBe(
      `AI paused: this hour’s AI replies were used up. The bot answers again from about ${back}, or sooner if you raise the limit.`,
    );
    expect(limitNote(paused('customer'), now)).toBe(
      `AI paused: this customer reached their AI replies for the hour. The bot answers them again from about ${back}.`,
    );
    expect(limitNote(paused('monthly'), now)).toBe(
      'AI paused: the monthly AI limit was reached. The bot answers again once the limit is raised or a new month starts.',
    );
  });

  it('says the next message is answered once the pause is over', () => {
    for (const reason of ['hourly', 'customer', 'monthly'] as const)
      expect(limitNote(paused(reason), Date.parse(until))).toBe(
        'The bot will answer this customer’s next message.',
      );
  });

  it('says the next message is answered once the owner raised that limit', () => {
    const raisedHourly = { ai: { ...seedCompanies[0]!.ai }, aiLimits: { repliesPerHour: 500 } };
    expect(limitNote(paused('hourly', {}, 300), now, raisedHourly)).toBe(
      'The bot will answer this customer’s next message.',
    );
    // Not raised above the limit the pause was made with: still paused.
    const same = { ai: { ...seedCompanies[0]!.ai }, aiLimits: { repliesPerHour: 300 } };
    expect(limitNote(paused('hourly', {}, 300), now, same)).toContain('AI paused');
    const raisedMonthly = { ai: { ...seedCompanies[0]!.ai, monthlyBudgetUsd: 50 } };
    expect(limitNote(paused('monthly', {}, 10), now, raisedMonthly)).toBe(
      'The bot will answer this customer’s next message.',
    );
  });

  it('is empty for chats without a limit pause', () => {
    expect(limitNote({ ...seedConversations[0]!, mode: 'human' }, now)).toBe('');
  });
});

describe('Staff alert labels', () => {
  type Item = StaffAttention['items'][number];
  const item = (extra: Partial<Item>): Item => ({
    id: 'x',
    kind: 'order',
    entityId: 'company-1',
    createdAt: '2026-10-16T10:00:00.000Z',
    ...extra,
  });

  it('describes reached AI limits and opens Bot settings', () => {
    const resetsAt = '2026-10-16T11:00:00.000Z';
    expect(describeAlert(item({ kind: 'limit', scope: 'hourly', resetsAt }))).toEqual({
      label: `Hourly AI limit reached · back at ${clockTime(resetsAt)}`,
      page: 'bot',
    });
    expect(describeAlert(item({ kind: 'limit', scope: 'monthly', resetsAt }))).toEqual({
      label: 'Monthly AI limit reached',
      page: 'bot',
    });
    expect(describeAlert(item({ kind: 'limit' }))).toEqual({
      label: 'AI limit reached',
      page: 'bot',
    });
  });

  it('keeps the other alerts as before', () => {
    expect(describeAlert(item({ kind: 'order', entityId: 'o1' }))).toEqual({
      label: 'Order awaiting confirmation',
      page: 'orders',
      id: 'o1',
    });
    expect(describeAlert(item({ kind: 'handoff', entityId: 'c1' })).page).toBe('inbox');
    expect(describeAlert(item({ kind: 'job' })).id).toBeUndefined();
    expect(describeAlert(item({ kind: 'budget' })).label).toBe('AI budget at 80% or more');
  });

  it('does not crash on an alert kind from a newer server', () => {
    const unknown = { ...item({}), kind: 'something_new' } as unknown as Item;
    expect(describeAlert(unknown)).toEqual({
      label: 'Something needs attention',
      page: 'activity',
    });
  });
});
