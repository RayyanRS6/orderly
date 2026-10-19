// FX-11 (frontend-1, sweep P2): a new customer message or a staff reply from the restaurant's
// phone never stays invisible in the Inbox. Events are dated when the customer sent the message,
// so the Inbox treats any event it has not seen as news (not only the newest one); it asks for
// the list once a minute regardless, for news that leaves no event; and a list or chat request
// that failed is asked again at the next workspace check. An idle Inbox stays within the
// Supabase Free plan's budget.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVITY_POLL_MS, LIST_REFRESH_MS, noteNewEvents } from '../src/lib/polling';
import { conversationNews, conversationsChangeKey } from '../src/components/Inbox';
import type { Bootstrap } from '../src/shared/types';
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
const summary = {
  orders: 3,
  pending: 0,
  value: 450000,
  conversations: 2,
  needsStaff: 1,
  monthlySpend: 1,
  daily: [],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('which workspace checks bring news for the Inbox', () => {
  const before = [trace('other', 'reply', at(28), 'c2'), trace('t1', 'reply', at(-60), 'c1')];

  it('catches a customer message recorded late, behind a newer event', () => {
    const seen = new Set<string>();
    expect(conversationNews(seen, before)).toBe(true);
    // The customer wrote at 0:10 into a chat already with staff; Orderly recorded it after
    // another chat's reply of 0:28. Nothing in the summary changes either.
    const late = [before[0]!, trace('late', 'human_mode_message_saved', at(10), 'c1'), before[1]!];
    const key = (traces: Bootstrap['traces']) => conversationsChangeKey({ summary, traces });
    expect(key(late)).toBe(key(before));
    expect(conversationNews(seen, late)).toBe(true);
    // Only once.
    expect(conversationNews(seen, structuredClone(late))).toBe(false);
  });

  it('ignores delivery receipts, events seen before, and events that only dropped off the list', () => {
    const seen = new Set<string>();
    conversationNews(seen, before);
    expect(
      conversationNews(seen, [
        trace('r1', 'whatsapp.delivered', at(40)),
        trace('r2', 'whatsapp.read', at(41)),
        ...before,
      ]),
    ).toBe(false);
    expect(conversationNews(seen, before.slice(0, 1))).toBe(false);
    expect(conversationNews(seen, undefined)).toBe(false);
  });

  it('forgets old ids after a long day without treating the current list as news', () => {
    const seen = new Set<string>();
    const all = () => true;
    for (let i = 0; i < 1001; i++)
      expect(noteNewEvents(seen, [trace(`e${i}`, 'reply', at(i), 'c1')], all)).toBe(true);
    expect(seen.size).toBeLessThanOrEqual(1000);
    expect(noteNewEvents(seen, [trace('e1000', 'reply', at(1000), 'c1')], all)).toBe(false);
  });
});

// The open chat, handed to staff: a new message there changes no summary number.
function withStaff() {
  const server = quietServer();
  server.state.conversation = { ...server.state.conversation, mode: 'human' };
  server.state.summary = { ...server.state.summary, needsStaff: 1 };
  return server;
}
const shows = (tab: ReturnType<typeof inboxTab>, id: string) =>
  tab.open().messages.some((m) => m.id === id);

describe('the open chat in the Inbox', () => {
  it('shows a customer message recorded late at the next workspace check', () => {
    fakeDocument();
    const server = withStaff();
    const tab = inboxTab(server);
    // Another chat's reply comes in at 0:28.
    vi.advanceTimersByTime(28000);
    server.state.traces = [trace('other', 'reply', at(28), 'c2'), ...server.state.traces];
    vi.advanceTimersByTime(4000);
    const keyBefore = conversationsChangeKey(server.activity());
    // The customer's message, sent at 0:10, is recorded at 0:32.
    server.state.conversation = chat(
      [...server.state.conversation.messages, message('m3', 'customer', at(10))],
      { mode: 'human' },
    );
    server.state.traces = [
      server.state.traces[0]!,
      trace('late', 'human_mode_message_saved', at(10), 'c1'),
      ...server.state.traces.slice(1),
    ];
    expect(conversationsChangeKey(server.activity())).toBe(keyBefore);
    expect(shows(tab, 'm3')).toBe(false);
    // The next check is at 0:45, well before the once-a-minute list.
    vi.advanceTimersByTime(ACTIVITY_POLL_MS);
    expect(shows(tab, 'm3')).toBe(true);
    tab.stop();
  });

  it('shows a staff reply sent from the restaurant phone within a minute, though it leaves no event', () => {
    fakeDocument();
    const server = withStaff();
    const tab = inboxTab(server);
    vi.advanceTimersByTime(1000);
    // Saved from the phone: no event, no summary number changes.
    server.state.conversation = chat(
      [...server.state.conversation.messages, message('s1', 'staff', at(1))],
      { mode: 'human' },
    );
    vi.advanceTimersByTime(LIST_REFRESH_MS - 2000);
    expect(shows(tab, 's1')).toBe(false);
    expect(tab.count('/conversations/c1')).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(shows(tab, 's1')).toBe(true);
    tab.stop();
  });

  it('asks for the list again at the next check after it failed, not only after more news', () => {
    fakeDocument();
    const server = quietServer();
    const tab = inboxTab(server);
    vi.advanceTimersByTime(1000);
    expect(tab.count('/conversations')).toBe(1);
    // The customer writes while the list request fails.
    server.state.down.list = true;
    server.state.conversation = chat([
      ...server.state.conversation.messages,
      message('m3', 'customer', at(5)),
    ]);
    server.state.traces = [
      trace('t3', 'human_mode_message_saved', at(5), 'c1'),
      ...server.state.traces,
    ];
    vi.advanceTimersByTime(ACTIVITY_POLL_MS);
    expect(tab.count('/conversations')).toBe(2);
    expect(shows(tab, 'm3')).toBe(false);
    // Still failing at the next check: asked once more, no faster.
    vi.advanceTimersByTime(ACTIVITY_POLL_MS);
    expect(tab.count('/conversations')).toBe(3);
    server.state.down.list = false;
    vi.advanceTimersByTime(ACTIVITY_POLL_MS);
    expect(tab.count('/conversations')).toBe(4);
    expect(shows(tab, 'm3')).toBe(true);
    // Working again: no more asking until news or the minute is up.
    vi.advanceTimersByTime(ACTIVITY_POLL_MS);
    expect(tab.count('/conversations')).toBe(4);
    tab.stop();
  });

  it('asks for the open chat again at the next check after it failed', () => {
    fakeDocument();
    const server = quietServer();
    const tab = inboxTab(server);
    vi.advanceTimersByTime(1000);
    server.state.down.chat = true;
    server.state.conversation = chat([
      ...server.state.conversation.messages,
      message('m3', 'customer', at(5)),
    ]);
    server.state.traces = [
      trace('t3', 'human_mode_message_saved', at(5), 'c1'),
      ...server.state.traces,
    ];
    vi.advanceTimersByTime(ACTIVITY_POLL_MS);
    // The list showed the chat behind; asking for the chat failed.
    expect(tab.count('/conversations/c1')).toBe(2);
    expect(shows(tab, 'm3')).toBe(false);
    server.state.down.chat = false;
    vi.advanceTimersByTime(ACTIVITY_POLL_MS);
    expect(tab.count('/conversations/c1')).toBe(3);
    expect(shows(tab, 'm3')).toBe(true);
    vi.advanceTimersByTime(ACTIVITY_POLL_MS);
    expect(tab.count('/conversations/c1')).toBe(3);
    tab.stop();
  });
});

describe('the Free-plan request budget with the once-a-minute list', () => {
  it('stays under 100 requests in 10 minutes even when the open chat is on another page', () => {
    fakeDocument();
    const server = quietServer();
    server.state.listed = false;
    const tab = inboxTab(server);
    vi.advanceTimersByTime(10 * 60000);
    expect(tab.count('/conversations')).toBe(11);
    // A chat the list does not show can't be compared, so each list asks for it too.
    expect(tab.count('/conversations/c1')).toBe(12);
    expect(tab.count()).toBeLessThan(100);
    tab.stop();
  });

  it('asks nothing in a hidden tab, and for the list once when shown again', () => {
    const doc = fakeDocument();
    const tab = inboxTab(quietServer());
    vi.advanceTimersByTime(1000);
    const opened = tab.count('/conversations');
    doc.show(false);
    vi.advanceTimersByTime(10 * 60000);
    expect(tab.count('/conversations')).toBe(opened);
    doc.show(true);
    expect(tab.count('/conversations')).toBe(opened + 1);
    tab.stop();
  });

  it('skips the minute’s list when news brought one shortly before', () => {
    fakeDocument();
    const server = quietServer();
    const tab = inboxTab(server);
    vi.advanceTimersByTime(40000);
    server.state.traces = [trace('t2', 'reply', at(40), 'c2'), ...server.state.traces];
    server.state.summary = { ...server.state.summary, conversations: 2 };
    vi.advanceTimersByTime(21000);
    // On opening, and after the news of the 0:45 check; the list due at 1:00 is skipped.
    expect(tab.count('/conversations')).toBe(2);
    vi.advanceTimersByTime(LIST_REFRESH_MS);
    expect(tab.count('/conversations')).toBe(3);
    tab.stop();
  });
});

describe('the Inbox is wired to these rules', () => {
  const inbox = source('src/components/Inbox.tsx');

  it('treats an event it has not seen as news, and asks again after a failure', () => {
    expect(inbox).toMatch(
      /const fresh = conversationNews\(seenEvents, data\.traces\);[\s\S]*?if \(!asked && \(fresh \|\| listFailed\.current\)\) void refresh\(\);\s*if \(chatFailed\.current\) updateChat\.current\?\.\(\);\s*\}, \[data\.traces, changes\]\);/,
    );
    // The key above already asks for the list when it changed.
    expect(inbox).toMatch(
      /const asked = keySeen\.current !== changes;\s*keySeen\.current = changes;/,
    );
    expect(inbox).toMatch(/listFailed\.current = \(e as Error\)\.message;/);
    expect(inbox).toMatch(/if \(!active\) return;\s*chatFailed\.current = true;/);
    expect(inbox).toMatch(/if \(!active\) return;\s*chatFailed\.current = false;/);
  });

  it('asks for the list once a minute while on screen, unless it just came', () => {
    expect(inbox).toMatch(
      /pollWhileVisible\(\(\) => \{\s*if \(!busyNow\.current && Date\.now\(\) - listAt\.current >= LIST_REFRESH_MS \/ 2\) void refresh\(\);\s*\}, LIST_REFRESH_MS\)/,
    );
    expect(inbox).toMatch(
      /const request = \+\+requestId\.current;\s*listAt\.current = Date\.now\(\);/,
    );
  });
});
