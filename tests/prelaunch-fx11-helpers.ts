// A dashboard tab on the Inbox with a chat open, wired the way App, StaffAlerts and the Inbox
// wire the polling helpers (the source checks in prelaunch-fx8-polling and prelaunch-fx11-inbox
// hold them to it). Used with vi.useFakeTimers() and a stubbed `document`.
import { vi } from 'vitest';
import {
  ACTIVITY_POLL_MS,
  CHAT_POLL_MS,
  CONFIG_POLL_MS,
  LIST_REFRESH_MS,
  pollWhileVisible,
} from '../src/lib/polling';
import {
  awaitingDelivery,
  chatBehind,
  conversationNews,
  conversationsChangeKey,
} from '../src/components/Inbox';
import { ALERT_POLL_MS, shouldPollAlerts } from '../src/components/StaffAlerts';
import { seedConversations } from '../src/shared/seed';
import type { Bootstrap, Conversation, Message, Trace } from '../src/shared/types';

export const START = Date.parse('2026-10-19T10:00:00.000Z');
export const at = (seconds: number) => new Date(START + seconds * 1000).toISOString();
export const trace = (
  id: string,
  action: string,
  createdAt: string,
  conversationId?: string,
): Trace => ({
  id,
  companyId: 'company-1',
  action,
  detail: '',
  createdAt,
  ...(conversationId && { conversationId }),
});

// A stand-in for the browser tab: whether it is hidden, and its visibilitychange listeners.
export function fakeDocument(hidden = false) {
  const listeners = new Set<() => void>();
  const doc = {
    hidden,
    addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
    show(next: boolean) {
      doc.hidden = !next;
      for (const fn of [...listeners]) fn();
    },
  };
  vi.stubGlobal('document', doc);
  return doc;
}

export const chat = (messages: Message[], extra: Partial<Conversation> = {}): Conversation => ({
  ...seedConversations[0]!,
  id: 'c1',
  channel: 'whatsapp',
  mode: 'bot',
  messages,
  updatedAt: messages.at(-1)!.createdAt,
  ...extra,
});
export const message = (
  id: string,
  role: Message['role'],
  createdAt: string,
  extra: Partial<Message> = {},
) => ({ id, role, text: id, createdAt, ...extra }) as Message;

/**
 * The tab's requests, in order. `server` answers like the backend, with new objects each time;
 * `list` and `chat` throw for a failed request. The workspace check every 15 seconds, the
 * emergency-stop check, the alerts check once a minute, and the Inbox: the list after news (a new
 * change key, or an event it had not seen), once a minute regardless, and again at the next check
 * after a failure; the open chat when a list shows it behind, while a reply waits for its tick,
 * and again at the next check after a failure.
 */
export function inboxTab(
  server: {
    activity: () => Pick<Bootstrap, 'summary' | 'traces'>;
    list: () => Conversation[];
    chat: () => Conversation;
  },
  { alertsOn = false } = {},
) {
  const calls: string[] = [];
  const stops: (() => void)[] = [];
  let data = server.activity();
  // App: the workspace check, and the emergency-stop check.
  stops.push(
    pollWhileVisible(() => {
      calls.push('/activity');
      data = { ...data, ...server.activity() };
      inboxSaw();
    }, ACTIVITY_POLL_MS),
    pollWhileVisible(() => calls.push('/config'), CONFIG_POLL_MS),
  );
  // StaffAlerts: at once, then a minute after each answer; a hidden tab waits unless alerts are on.
  let waiting = false;
  let alertTimer: ReturnType<typeof setTimeout> | undefined;
  const alerts = () => {
    if (!shouldPollAlerts(document.hidden, alertsOn)) {
      waiting = true;
      return;
    }
    calls.push('/attention');
    alertTimer = setTimeout(alerts, ALERT_POLL_MS);
  };
  const shown = () => {
    if (document.hidden || !waiting) return;
    waiting = false;
    clearTimeout(alertTimer);
    alerts();
  };
  document.addEventListener('visibilitychange', shown);
  alerts();
  // Inbox: the chat from the link, and the list 200 ms after opening or after a new key.
  let open = server.chat();
  calls.push('/conversations/c1');
  const seen = new Set<string>();
  conversationNews(seen, data.traces);
  let key = conversationsChangeKey(data);
  let listAt = 0;
  let listFailed = false;
  let chatFailed = false;
  let listTimer = setTimeout(list, 200);
  function inboxSaw() {
    const fresh = conversationNews(seen, data.traces);
    const next = conversationsChangeKey(data);
    if (next !== key) {
      key = next;
      clearTimeout(listTimer);
      listTimer = setTimeout(list, 200);
    } else if (fresh || listFailed) list();
    if (chatFailed) updateChat();
  }
  stops.push(
    pollWhileVisible(() => {
      if (Date.now() - listAt >= LIST_REFRESH_MS / 2) list();
    }, LIST_REFRESH_MS),
  );
  function list() {
    calls.push('/conversations');
    listAt = Date.now();
    let items: Conversation[];
    try {
      items = server.list();
    } catch {
      listFailed = true;
      return;
    }
    listFailed = false;
    if (
      chatBehind(
        open,
        items.find((c) => c.id === open.id),
      )
    )
      updateChat();
  }
  let stopTicks: (() => void) | undefined;
  function updateChat() {
    calls.push('/conversations/c1');
    try {
      open = server.chat();
    } catch {
      chatFailed = true;
      return;
    }
    chatFailed = false;
    watchTicks();
  }
  function watchTicks() {
    const waitingForTick = awaitingDelivery(open);
    if (waitingForTick && !stopTicks) stopTicks = pollWhileVisible(updateChat, CHAT_POLL_MS);
    if (!waitingForTick && stopTicks) {
      stopTicks();
      stopTicks = undefined;
    }
  }
  watchTicks();
  return {
    count: (path?: string) => (path ? calls.filter((c) => c === path).length : calls.length),
    /** The open chat as this tab shows it. */
    open: () => open,
    stop() {
      for (const stop of stops) stop();
      stopTicks?.();
      clearTimeout(alertTimer);
      clearTimeout(listTimer);
      document.removeEventListener('visibilitychange', shown);
    },
  };
}

// A quiet restaurant: nothing new arrives while the tab is open. `down` makes the list or the
// chat request fail; `listed: false` puts the open chat on another page of the list.
export function quietServer() {
  const conversation = chat([
    message('m1', 'customer', at(-700)),
    message('m2', 'assistant', at(-690), { delivery: 'read' }),
  ]);
  const state = {
    summary: {
      orders: 3,
      pending: 0,
      value: 450000,
      conversations: 1,
      needsStaff: 0,
      monthlySpend: 1,
      daily: [],
    },
    traces: [trace('t1', 'reply', at(-690), 'c1')],
    conversation,
    down: { list: false, chat: false },
    listed: true,
  };
  return {
    state,
    activity: () => structuredClone({ summary: state.summary, traces: state.traces }),
    list: () => {
      if (state.down.list) throw new Error('offline');
      return state.listed
        ? [
            {
              ...structuredClone(state.conversation),
              messages: state.conversation.messages.slice(-1),
            },
          ]
        : [];
    },
    chat: () => {
      if (state.down.chat) throw new Error('offline');
      return structuredClone(state.conversation);
    },
  };
}
