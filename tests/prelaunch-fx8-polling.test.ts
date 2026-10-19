// FX-8 (frontend-1): a dashboard tab left open on the Inbox must not spend the Supabase Free
// plan's requests. The list and the open chat are fetched again only when the workspace check
// brings news, receipts and AI spending no longer refetch Orders, and a hidden tab asks nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTIVITY_POLL_MS,
  CHAT_POLL_MS,
  CONFIG_POLL_MS,
  LIST_REFRESH_MS,
  newestEvent,
  pollWhileVisible,
} from '../src/lib/polling';
import { awaitingDelivery, chatBehind, conversationsChangeKey } from '../src/components/Inbox';
import { ordersChangeKey } from '../src/components/Orders';
import { seedOrders } from '../src/shared/seed';
import type { Bootstrap, Conversation, Trace } from '../src/shared/types';
import { bootstrap } from './prelaunch-e-helpers';
import {
  at,
  chat,
  fakeDocument,
  inboxTab,
  message,
  quietServer,
  START,
  trace,
} from './prelaunch-fx11-helpers';

const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('pollWhileVisible', () => {
  it('asks only while the tab is on screen, and at once when it comes back after a missed check', () => {
    const doc = fakeDocument();
    const tick = vi.fn();
    const stop = pollWhileVisible(tick, 15000);
    vi.advanceTimersByTime(45000);
    expect(tick).toHaveBeenCalledTimes(3);
    doc.show(false);
    vi.advanceTimersByTime(10 * 60000);
    expect(tick).toHaveBeenCalledTimes(3);
    doc.show(true);
    expect(tick).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(15000);
    expect(tick).toHaveBeenCalledTimes(5);
    // Hidden and shown again before a check fell due: nothing extra.
    doc.show(false);
    doc.show(true);
    expect(tick).toHaveBeenCalledTimes(5);
    stop();
    vi.advanceTimersByTime(60000);
    doc.show(false);
    doc.show(true);
    expect(tick).toHaveBeenCalledTimes(5);
  });

  it('starts nothing in a tab that opened hidden', () => {
    const doc = fakeDocument(true);
    const tick = vi.fn();
    pollWhileVisible(tick, 15000);
    vi.advanceTimersByTime(60000);
    expect(tick).not.toHaveBeenCalled();
    doc.show(true);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('keeps the agreed rhythms', () => {
    expect(ACTIVITY_POLL_MS).toBe(15000);
    expect(CHAT_POLL_MS).toBe(30000);
    expect(CONFIG_POLL_MS).toBeLessThanOrEqual(5 * 60000);
  });
});

describe('newestEvent', () => {
  it('names the newest matching event, the same however the list is ordered', () => {
    const traces = [
      trace('b', 'reply', at(10), 'c1'),
      trace('a', 'reply', at(10), 'c2'),
      trace('r', 'whatsapp.read', at(20)),
    ];
    const chats = (t: Trace) => !!t.conversationId;
    expect(newestEvent(traces, chats)).toBe('b');
    expect(newestEvent([...traces].reverse(), chats)).toBe('b');
    expect(newestEvent([], chats)).toBeNull();
    expect(newestEvent(undefined, chats)).toBeNull();
  });
});

describe('what makes the Inbox fetch its list again', () => {
  const summary = {
    orders: 3,
    pending: 1,
    value: 450000,
    conversations: 4,
    needsStaff: 1,
    monthlySpend: 1.25,
    daily: [],
  };
  const data = (extra: Partial<Bootstrap> = {}) =>
    ({ summary, traces: [trace('t1', 'reply', at(-60), 'c1')], ...extra }) as Bootstrap;

  it('ignores a check that brought the same numbers and events in new objects', () => {
    expect(conversationsChangeKey(structuredClone(data()))).toBe(conversationsChangeKey(data()));
  });

  it('ignores WhatsApp delivery receipts and events that only dropped off the list', () => {
    const before = data();
    const receipts = data({
      traces: [
        trace('r1', 'whatsapp.delivered', at(5)),
        trace('r2', 'whatsapp.read', at(6)),
        ...before.traces,
      ],
    });
    expect(conversationsChangeKey(receipts)).toBe(conversationsChangeKey(before));
    // An older event leaving the 50 recent ones is not news.
    const older = data({ traces: [trace('t0', 'reply', at(-120), 'c2'), ...before.traces] });
    expect(conversationsChangeKey({ ...older, traces: before.traces })).toBe(
      conversationsChangeKey(older),
    );
  });

  it('changes for a new message, a staff action, a new chat, a handoff or an AI reply', () => {
    const before = conversationsChangeKey(data());
    const withEvent = (t: Trace) => conversationsChangeKey(data({ traces: [t] }));
    expect(withEvent(trace('t2', 'human_mode_message_saved', at(1), 'c2'))).not.toBe(before);
    expect(withEvent(trace('t3', 'whatsapp.accepted', at(1), 'c1'))).not.toBe(before);
    expect(withEvent(trace('audit-1', 'POST /api/conversations/:id/mode', at(1)))).not.toBe(before);
    for (const change of [
      { conversations: 5 },
      { needsStaff: 2 },
      { monthlySpend: 1.26 },
    ] as Partial<typeof summary>[])
      expect(conversationsChangeKey(data({ summary: { ...summary, ...change } }))).not.toBe(before);
  });
});

describe('what makes the Orders page fetch again', () => {
  it('ignores receipts, chat events and AI spending', () => {
    const data = bootstrap({
      summary: {
        orders: 3,
        pending: 1,
        value: 450000,
        conversations: 4,
        needsStaff: 0,
        monthlySpend: 1,
        daily: [],
      },
    });
    const before = ordersChangeKey(data);
    const noisy = {
      ...structuredClone(data),
      traces: [
        trace('r1', 'whatsapp.delivered', at(1)),
        trace('r2', 'whatsapp.read', at(2)),
        trace('t1', 'reply', at(3), 'c1'),
        trace('m1', 'model.completed', at(3)),
      ],
      summary: { ...data.summary!, conversations: 5, needsStaff: 1, monthlySpend: 2 },
    };
    expect(ordersChangeKey(noisy)).toBe(before);
  });

  it('still changes for an order, the totals, or an event about an older order', () => {
    const data = bootstrap();
    expect(ordersChangeKey(structuredClone(data))).toBe(ordersChangeKey(data));
    const accepted = structuredClone(data);
    accepted.orders[0]!.status = 'accepted';
    expect(ordersChangeKey(accepted)).not.toBe(ordersChangeKey(data));
    for (const action of [
      'order.status',
      'POST /api/orders/:id/status',
      'order_followup',
      'cancel_submitted:order-9',
    ])
      expect(ordersChangeKey(bootstrap({ traces: [trace('e', action, at(1))] }))).not.toBe(
        ordersChangeKey(data),
      );
  });
});

describe('when the open chat is fetched again', () => {
  const open = chat([
    message('m1', 'customer', at(-700)),
    message('m2', 'assistant', at(-690), { delivery: 'read' }),
  ]);
  const listed = (c: Conversation) => ({ ...c, messages: c.messages.slice(-1) });

  it('only when the list shows it with news, or cannot show it', () => {
    expect(chatBehind(open, listed(open))).toBe(false);
    const newer = chat([...open.messages, message('m3', 'customer', at(-10))]);
    expect(chatBehind(open, listed(newer))).toBe(true);
    expect(chatBehind(open, { ...listed(open), mode: 'human' })).toBe(true);
    expect(chatBehind(open, { ...listed(open), updatedAt: at(-5) })).toBe(true);
    // On another page of the list, or filtered out.
    expect(chatBehind(open, undefined)).toBe(true);
  });

  it('on a timer only while a fresh reply waits for its delivery tick', () => {
    const now = START;
    expect(awaitingDelivery(open, now)).toBe(false);
    for (const delivery of [undefined, 'accepted', 'sent'] as const)
      expect(
        awaitingDelivery(chat([message('m', 'staff', at(-30), { delivery })]), now),
        String(delivery),
      ).toBe(true);
    for (const delivery of ['delivered', 'read', 'failed'] as const)
      expect(awaitingDelivery(chat([message('m', 'assistant', at(-30), { delivery })]), now)).toBe(
        false,
      );
    // Older than two minutes, a customer's own message, or a test chat: no timer.
    expect(awaitingDelivery(chat([message('m', 'assistant', at(-180))]), now)).toBe(false);
    expect(awaitingDelivery(chat([message('m', 'customer', at(-30))]), now)).toBe(false);
    expect(
      awaitingDelivery(chat([message('m', 'assistant', at(-30))], { channel: 'demo' }), now),
    ).toBe(false);
  });
});

describe('the Free-plan request budget of an Inbox tab', () => {
  it('stays within 70 requests in 10 minutes for an idle Inbox on screen with a chat open', () => {
    fakeDocument();
    const tab = inboxTab(quietServer());
    vi.advanceTimersByTime(10 * 60000);
    // Before: 40 workspace checks, 40 list fetches, 60 chat fetches and 10 alert checks.
    expect(tab.count('/activity')).toBe(40);
    // On opening, then once a minute in case of news that leaves no event (LIST_REFRESH_MS).
    expect(LIST_REFRESH_MS).toBe(60000);
    expect(tab.count('/conversations')).toBe(11);
    expect(tab.count('/conversations/c1')).toBe(1);
    expect(tab.count('/attention')).toBe(11);
    expect(tab.count('/config')).toBe(2);
    expect(tab.count()).toBeLessThanOrEqual(70);
    tab.stop();
  });

  it('asks nothing while the tab is hidden, and catches up once when shown again', () => {
    const doc = fakeDocument();
    const tab = inboxTab(quietServer());
    vi.advanceTimersByTime(1000);
    const opened = tab.count();
    doc.show(false);
    vi.advanceTimersByTime(10 * 60000);
    expect(tab.count()).toBe(opened);
    doc.show(true);
    expect(tab.count('/activity')).toBe(1);
    expect(tab.count('/config')).toBe(1);
    expect(tab.count('/attention')).toBe(2);
    tab.stop();
  });

  it('keeps alert checks, and only those, in a hidden tab with browser alerts on', () => {
    const doc = fakeDocument();
    const tab = inboxTab(quietServer(), { alertsOn: true });
    vi.advanceTimersByTime(1000);
    doc.show(false);
    vi.advanceTimersByTime(10 * 60000);
    expect(tab.count('/attention')).toBe(11);
    expect(tab.count('/activity')).toBe(0);
    tab.stop();
  });

  it('ignores receipts arriving all the time, but fetches the list and the open chat for real news', () => {
    fakeDocument();
    const server = quietServer();
    const tab = inboxTab(server);
    vi.advanceTimersByTime(1000);
    // Two minutes of WhatsApp read and delivered receipts for older replies: the list only on
    // opening and once a minute (LIST_REFRESH_MS), none for a receipt.
    for (let i = 0; i < 8; i++) {
      server.state.traces = [trace(`r${i}`, 'whatsapp.read', at(i)), ...server.state.traces];
      vi.advanceTimersByTime(ACTIVITY_POLL_MS);
    }
    expect(tab.count('/conversations')).toBe(1 + 2);
    // Another customer writes: the list is fetched again, the open chat is not.
    server.state.traces = [
      trace('t2', 'human_mode_message_saved', at(200), 'c2'),
      ...server.state.traces,
    ];
    server.state.summary = { ...server.state.summary, conversations: 2 };
    vi.advanceTimersByTime(ACTIVITY_POLL_MS);
    expect(tab.count('/conversations')).toBe(2 + 2);
    expect(tab.count('/conversations/c1')).toBe(1);
    // The open chat's customer writes and the bot answers: the chat is fetched once, then again
    // every 30 seconds only until the reply is delivered.
    const reply = message('m4', 'assistant', new Date(Date.now() + 1000).toISOString());
    server.state.conversation = chat([
      ...server.state.conversation.messages,
      message('m3', 'customer', new Date(Date.now()).toISOString()),
      reply,
    ]);
    server.state.traces = [trace('t3', 'reply', at(300), 'c1'), ...server.state.traces];
    vi.advanceTimersByTime(ACTIVITY_POLL_MS);
    expect(tab.count('/conversations/c1')).toBe(2);
    vi.advanceTimersByTime(CHAT_POLL_MS);
    expect(tab.count('/conversations/c1')).toBe(3);
    reply.delivery = 'delivered';
    vi.advanceTimersByTime(CHAT_POLL_MS);
    expect(tab.count('/conversations/c1')).toBe(4);
    vi.advanceTimersByTime(5 * 60000);
    expect(tab.count('/conversations/c1')).toBe(4);
    tab.stop();
  });
});

describe('the dashboard is wired to these rules', () => {
  it('fetches the Inbox list on news, not on every new summary object', () => {
    const inbox = source('src/components/Inbox.tsx');
    expect(inbox).toContain('const changes = conversationsChangeKey(data);');
    expect(inbox).toMatch(/\}, \[refresh, changes\]\);/);
    expect(inbox).not.toContain('[refresh, data.summary]');
    // The open chat: after a list that shows news, or on a timer while a reply waits for its tick.
    expect(inbox).toMatch(
      /const listed = result\.items\.find\(\(c\) => c\.id === open\.id\);\s*if \(chatBehind\(open, listed\)\) updateChat\.current\?\.\(\);\s*\}, \[result\]\);/,
    );
    expect(inbox).toContain('awaitingDelivery(conversation)');
    expect(inbox).toMatch(/return pollWhileVisible\(\(\) => \{[\s\S]*?\}, CHAT_POLL_MS\);/);
    expect(inbox).not.toMatch(/\}, 10000\);/);
  });

  it('pauses the workspace check in a hidden tab, and checks the emergency stop again', () => {
    const app = source('src/App.tsx');
    expect(app).toMatch(/return pollWhileVisible\(\(\) => \{\s*if \(!savesInFlight\.current\)/);
    expect(app).toContain('}, ACTIVITY_POLL_MS);');
    expect(app).not.toContain('}, 15000);');
    expect(app).toMatch(
      /pollWhileVisible\(\(\) => \{\s*void api<Configuration>\('\/config'\)\s*\.then\(\(c\) => setAutomationPaused\(!!c\.automationPaused\)\)/,
    );
    expect(app).toContain('}, CONFIG_POLL_MS);');
  });

  it('builds the Orders key from orders, totals and order events only', () => {
    const orders = source('src/components/Orders.tsx');
    expect(orders).toContain('newestEvent(data.traces, orderEvent)');
    expect(orders).not.toContain('(data.traces ?? []).map((t) => t.id)');
    expect(ordersChangeKey({ orders: seedOrders, traces: [] })).toBe(
      ordersChangeKey({ orders: structuredClone(seedOrders), traces: [] }),
    );
  });
});
