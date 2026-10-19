import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Send } from 'lucide-react';
import type { Bootstrap, Company, Conversation, Message, PageResult, Trace } from '../shared/types';
import { resumesAfterLimit } from '../domain/engine';
import { useAction, useWorkspace } from '../lib/workspace';
import { api } from '../lib/api';
import { CHAT_POLL_MS, newestEvent, pollWhileVisible } from '../lib/polling';
import { cn, shortDate } from '../lib/utils';
import {
  ActionButton,
  Badge,
  clockTime,
  ConfirmDialog,
  CustomSelect,
  Empty,
  ErrorNotice,
  PageHeading,
  Spinner,
  Status,
} from './ui';
import { WhyToggle } from './ReplyExplanation';
import { CustomerDataActions } from './CustomerData';

type FlagSource = Pick<
  Conversation,
  | 'channel'
  | 'mode'
  | 'blocked'
  | 'limitPause'
  | 'botPausedAt'
  | 'customerPhone'
  | 'whatsappAddress'
  | 'messages'
>;
/**
 * Which spam-protection badge and note a chat shows. `limitPaused` means an AI limit
 * stopped the bot and no staff member has decided anything since; the server clears the
 * pause when staff reply or switch the chat, so a staff message after it is a decision too.
 */
export function conversationFlags(
  c: FlagSource,
  now = Date.now(),
  company?: Pick<Company, 'ai' | 'aiLimits'>,
) {
  const blocked = !!c.blocked;
  const pause = c.limitPause;
  const staffWrote =
    !!pause &&
    !!c.messages?.some((m) => m.role === 'staff' && !m.notice && m.createdAt >= pause.at);
  const limitPaused = !blocked && c.mode === 'human' && !!pause && !staffWrote;
  return {
    badge: blocked ? ('blocked' as const) : limitPaused ? ('limit' as const) : undefined,
    blocked,
    // The bot-off note comes first: while the bot is off it would not answer anyway.
    limitNote: limitPaused && !c.botPausedAt,
    // Past the pause, or once the owner raised that limit, the bot answers the customer's
    // next message (the server's own rule, resumesAfterLimit).
    limitOver:
      limitPaused &&
      !!pause &&
      (Date.parse(pause.until) <= now || (!!company && resumesAfterLimit(c, company, now))),
    // Test chats have no number to block; the server also refuses chats without one.
    canBlock:
      !blocked && c.channel === 'whatsapp' && !!(c.customerPhone || c.whatsappAddress?.peer),
  };
}
/**
 * The list badge of a chat the bot paused: an AI limit (raising it in Bot settings helps), or
 * one of the pauses a limit does not explain and raising one does not end.
 */
export function pauseBadge(reason?: NonNullable<Conversation['limitPause']>['reason']) {
  if (reason === 'burst') return 'Many messages';
  if (reason === 'ai_error') return 'AI error';
  if (reason === 'late') return 'Late message';
  return 'AI limit';
}
/** The note shown above a chat the bot paused for an AI limit. Empty when there is none. */
export function limitNote(
  c: FlagSource,
  now = Date.now(),
  company?: Pick<Company, 'ai' | 'aiLimits'>,
) {
  const flags = conversationFlags(c, now, company);
  const pause = c.limitPause;
  if (!flags.limitNote || !pause) return '';
  if (flags.limitOver) return 'The bot will answer this customer’s next message.';
  const back = clockTime(pause.until);
  if (pause.reason === 'monthly')
    return 'AI paused: the monthly AI limit was reached. The bot answers again once the limit is raised or a new month starts.';
  if (pause.reason === 'customer')
    return `AI paused: this customer reached their AI replies for the hour. The bot answers them again${back ? ` from about ${back}` : ' within the hour'}.`;
  // A late message pauses only until its own time, so the note above already applies to it.
  if (pause.reason === 'burst')
    return `AI paused: this customer sent many messages at once. The bot answers them again${back ? ` from about ${back}` : ' shortly'}.`;
  if (pause.reason === 'ai_error')
    return `AI paused: the AI model could not answer. The bot answers this customer’s next message${back ? ` from about ${back}` : ' shortly'}.`;
  return `AI paused: this hour’s AI replies were used up. The bot answers again${back ? ` from about ${back}` : ' next hour'}, or sooner if you raise the limit.`;
}

// The same words and ticks the customer's WhatsApp shows.
const DELIVERY_LABELS: Record<NonNullable<Message['delivery']>, string> = {
  accepted: 'Sent ✓',
  sent: 'Sent ✓',
  delivered: 'Delivered ✓✓',
  read: 'Read ✓✓',
  failed: 'Not delivered',
};
// How long a fresh reply is watched for its delivery tick.
const SENDING_MS = 120000;
export function deliveryLabel(conversation: Conversation, m: Message, now = Date.now()) {
  if (m.delivery) return DELIVERY_LABELS[m.delivery];
  // A fresh WhatsApp reply without a receipt is still queued or on its way.
  if (
    conversation.channel === 'whatsapp' &&
    m.role === 'assistant' &&
    now - Date.parse(m.createdAt) < SENDING_MS
  )
    return 'Sending…';
}

/** WhatsApp's delivery receipts (sent, delivered, read) name no chat and change no list. */
const receipt = (t: Trace) => t.action.startsWith('whatsapp.') && !t.conversationId;
/**
 * Changes when the workspace check (every 15 seconds) brings news about conversations: a new
 * chat, one moving to or from staff, an AI reply, or any other new event except a delivery
 * receipt. The list and the open chat are fetched again only then.
 */
export function conversationsChangeKey(data: Pick<Bootstrap, 'summary' | 'traces'>) {
  const s = data.summary;
  return JSON.stringify([
    s ? [s.conversations, s.needsStaff, s.monthlySpend] : null,
    newestEvent(data.traces, (t) => !receipt(t)),
  ]);
}
type ChatState = Pick<Conversation, 'updatedAt' | 'mode' | 'messages'>;
/**
 * Whether the list shows news the open chat lacks: a newer message or change, or a move to or
 * from staff. A chat the list does not show (another page or filter) can't be compared, so it
 * counts as behind.
 */
export function chatBehind(open: ChatState, listed?: ChatState) {
  if (!listed) return true;
  const last = listed.messages.at(-1);
  return (
    listed.updatedAt > open.updatedAt ||
    listed.mode !== open.mode ||
    (!!last && !open.messages.some((m) => m.id === last.id))
  );
}
/** Whether a reply sent in the last 2 minutes still waits for WhatsApp to report it delivered. */
export function awaitingDelivery(c: Pick<Conversation, 'channel' | 'messages'>, now = Date.now()) {
  return (
    c.channel === 'whatsapp' &&
    c.messages.some(
      (m) =>
        m.role !== 'customer' &&
        (!m.delivery || m.delivery === 'accepted' || m.delivery === 'sent') &&
        now - Date.parse(m.createdAt) < SENDING_MS,
    )
  );
}

export function Inbox() {
  // `busy` only pauses the background check for new messages while a change saves.
  const { data, mutate, busy, navigate, detailId } = useWorkspace();
  const { pending, run } = useAction();
  const [blocking, setBlocking] = useState(false);
  const [blockError, setBlockError] = useState('');
  // The chat on screen. A save that finishes after staff opened another chat must not
  // show its answer (or its error) on that other chat.
  const shown = useRef(detailId);
  useEffect(() => {
    shown.current = detailId;
  }, [detailId]);
  const [result, setResult] = useState<PageResult<Conversation>>({
    items: data.conversations,
    total: data.summary?.conversations ?? data.conversations.length,
    page: 1,
    pageSize: 30,
  });
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [sandbox, setSandbox] = useState(data.mode === 'demo');
  const [conversation, setConversation] = useState<Conversation>();
  const [historyPage, setHistoryPage] = useState(1);
  const [hasOlder, setHasOlder] = useState(false);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  // A deep link starts out loading, so phones don't flash the list first.
  const [loading, setLoading] = useState(!!detailId);
  const requestId = useRef(0);
  const end = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const refresh = useCallback(async () => {
    const request = ++requestId.current;
    try {
      const r = await api<PageResult<Conversation>>(
        `/conversations?page=${page}&pageSize=30&search=${encodeURIComponent(search)}&status=${status}&sandbox=${sandbox}`,
        data.company.id,
      );
      if (requestId.current === request) setResult(r);
    } catch (e) {
      if (requestId.current === request) setError((e as Error).message);
    }
  }, [data.company.id, page, search, status, sandbox]);
  // The workspace check brings a new summary object every 15 seconds even when nothing
  // changed: ask for the list again only when it brought news about conversations.
  const changes = conversationsChangeKey(data);
  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 200);
    return () => {
      clearTimeout(timer);
      requestId.current++;
    };
  }, [refresh, changes]);
  useEffect(() => {
    let active = true;
    setConversation(undefined);
    setHistoryPage(1);
    setText('');
    setError('');
    setBlocking(false);
    setBlockError('');
    // Also clears a load that was cut short by going back to the list.
    setLoading(!!detailId);
    if (detailId) {
      api<Conversation>(`/conversations/${detailId}`, data.company.id)
        .then((c) => {
          if (active) {
            setConversation(c);
            setHasOlder(c.messages.length >= 100);
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }
    return () => {
      active = false;
    };
  }, [detailId, data.company.id]);
  // Only a chat that loaded is checked for new messages: one that failed to load keeps its
  // own error instead of turning into "Updates delayed".
  const loaded = !!detailId && conversation?.id === detailId;
  // Asks for the open chat again and adds what is new. Set while a loaded chat is on screen.
  const updateChat = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (!detailId || !loaded) return;
    let active = true;
    updateChat.current = () =>
      void api<Conversation>(`/conversations/${detailId}`, data.company.id)
        .then((c) => {
          if (!active) return;
          // Back online: an earlier delay notice no longer applies.
          setError((e) => (e.startsWith('Updates delayed') ? '' : e));
          setConversation((old) => ({
            ...c,
            messages: [
              ...new Map([...(old?.messages ?? []), ...c.messages].map((m) => [m.id, m])).values(),
            ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
          }));
        })
        .catch((e) => {
          if (active) setError(`Updates delayed: ${e.message}`);
        });
    return () => {
      active = false;
      updateChat.current = undefined;
    };
  }, [detailId, loaded, data.company.id]);
  // The list is fetched again only after news: when it shows the open chat with a newer message
  // or change than the one on screen, ask for the chat too. Only a new list result asks.
  const openChat = useRef(conversation);
  openChat.current = conversation;
  useEffect(() => {
    const open = openChat.current;
    if (!open || open.id !== shown.current) return;
    const listed = result.items.find((c) => c.id === open.id);
    if (chatBehind(open, listed)) updateChat.current?.();
  }, [result]);
  // A fresh reply shows "Sending…" or "Sent ✓" until WhatsApp reports it delivered: only then
  // is the chat asked again on a timer, every 30 seconds while this tab is on screen and
  // nothing is being saved.
  const busyNow = useRef(busy);
  busyNow.current = busy;
  const waitingForTick = loaded && !!conversation && awaitingDelivery(conversation);
  useEffect(() => {
    if (!waitingForTick) return;
    return pollWhileVisible(() => {
      if (!busyNow.current) updateChat.current?.();
    }, CHAT_POLL_MS);
  }, [waitingForTick, detailId]);
  // Only the message list scrolls to the newest message: on phones the page is taller than
  // the screen, and scrollIntoView would also move the page staff are reading.
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [conversation?.messages.at(-1)?.id]);
  // A failure shows as a notification, so the pressed button only needs its spinner.
  const act = (key: string, path: string, body: unknown, success?: string) =>
    run(key, async () => {
      const c = await mutate<Conversation>(path, body, undefined, { success });
      if (shown.current === c.id) setConversation(c);
      await refresh();
    });
  // The confirmation shows a failure itself and closes only once the number is blocked.
  const block = () => {
    const target = conversation?.id;
    if (!target) return;
    setBlockError('');
    void run('block', async () => {
      try {
        const c = await mutate<Conversation>(
          `/conversations/${target}/block`,
          { blocked: true },
          undefined,
          { dialog: true, success: 'Number blocked. Their messages will be ignored.' },
        );
        if (shown.current === target) {
          setConversation(c);
          setBlocking(false);
        }
        await refresh();
      } catch (e) {
        if (shown.current === target) setBlockError((e as Error).message);
      }
    });
  };
  async function older() {
    if (!conversation) return;
    const id = conversation.id;
    setLoading(true);
    try {
      const r = await api<PageResult<Message>>(
        `/conversations/${id}/messages?page=${historyPage + 1}`,
        data.company.id,
      );
      // Staff opened another chat meanwhile: these messages and this loading state aren't its.
      if (shown.current !== id) return;
      setConversation((c) =>
        c
          ? {
              ...c,
              messages: [
                ...new Map([...r.items.reverse(), ...c.messages].map((m) => [m.id, m])).values(),
              ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
            }
          : c,
      );
      setHistoryPage(historyPage + 1);
      setHasOlder((historyPage + 1) * 100 < r.total);
    } catch (e) {
      if (shown.current === id) setError((e as Error).message);
    } finally {
      if (shown.current === id) setLoading(false);
    }
  }
  const flags = conversation
    ? conversationFlags(conversation, Date.now(), data.company)
    : undefined;
  const pauseNote = conversation ? limitNote(conversation, Date.now(), data.company) : '';
  // Phones show one pane: the thread while a chat loads or is open, otherwise the list (also
  // after a failed load, so the error isn't followed by an empty "Choose a conversation").
  const showThread = !!detailId && (!!conversation || loading);
  // The server's own rule; only the hint changes, since this device's clock may be off.
  const windowClosed =
    conversation?.channel === 'whatsapp' &&
    Date.now() - Date.parse(conversation.lastInboundAt) >= 86400000;
  const filtered = !!search || status !== 'all';
  const keepWithStaff = (id: string) =>
    void act(
      'keep',
      `/conversations/${id}/mode`,
      { mode: 'human' },
      'This chat stays with staff.',
    ).catch(() => undefined);
  return (
    <>
      <ConfirmDialog
        open={blocking}
        onOpenChange={(open) => {
          setBlocking(open);
          setBlockError('');
        }}
        title="Block this number?"
        description={`Messages from ${
          conversation?.customerPhone || 'this WhatsApp contact'
        } will be ignored and not saved: no replies and no AI. Replies already waiting to be sent to it are not sent. You can unblock it any time from this chat or from Security & privacy.`}
        confirmLabel="Block number"
        busy={pending === 'block'}
        busyLabel="Blocking…"
        error={blockError}
        onConfirm={block}
      />
      <PageHeading
        title="Inbox"
        description="Read customer messages, take over and track delivery outcomes."
      />
      <div className="mb-4 empty:hidden">
        <ErrorNotice message={error} onDismiss={() => setError('')} />
      </div>
      <div
        className={cn(
          'card grid h-[calc(100dvh-18rem)] min-h-[24rem] max-h-[52rem] overflow-hidden md:h-[calc(100dvh-15rem)] md:grid-cols-[18rem_1fr]',
          // On phones an open chat grows with its header instead of squeezing the messages.
          showThread && 'max-md:h-auto max-md:max-h-none',
        )}
      >
        <section
          aria-label="Conversation list"
          className={cn(
            'min-h-0 min-w-0 flex-col border-r border-ink/[0.06]',
            showThread ? 'hidden md:flex' : 'flex',
          )}
        >
          <div className="space-y-3 border-b border-ink/[0.06] p-4">
            <input
              className="input"
              aria-label="Search conversations"
              placeholder="Name or phone…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
            <CustomSelect
              aria-label="Conversation filter"
              value={status}
              onChange={(v) => {
                setStatus(v);
                setPage(1);
              }}
              options={[
                { value: 'all', label: 'All conversations' },
                { value: 'human', label: 'Needs staff' },
                { value: 'bot', label: 'Bot conversations' },
              ]}
            />
            <label className="flex w-fit cursor-pointer items-center gap-2.5 text-xs font-medium text-stone-600">
              <input
                className="toggle"
                type="checkbox"
                checked={sandbox}
                onChange={(e) => {
                  setSandbox(e.target.checked);
                  setPage(1);
                }}
              />
              Show sandbox conversations only
            </label>
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
            {result.items.map((c) => {
              const { badge } = conversationFlags(c);
              return (
                <button
                  key={c.id}
                  className={cn(
                    'w-full rounded-2xl p-3.5 text-left transition-[background-color,box-shadow] duration-200 hover:bg-white/60',
                    c.id === detailId &&
                      'bg-white shadow-[inset_3px_0_0_var(--color-brand-500),0_0_0_1px_rgb(14_6_4/0.06),0_12px_22px_-16px_rgb(14_6_4/0.45)] hover:bg-white',
                  )}
                  aria-current={c.id === detailId ? 'true' : undefined}
                  onClick={() => navigate('inbox', c.id)}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="min-w-0 text-[13.5px] font-semibold break-words text-ink">
                      {c.customerName || c.customerPhone || 'WhatsApp contact'}
                    </strong>
                    {(c.mode === 'human' || badge) && (
                      <span className="flex flex-wrap items-center gap-1.5">
                        {c.mode === 'human' && <Status value="human" />}
                        {badge === 'blocked' && <Badge tone="red">Blocked</Badge>}
                        {badge === 'limit' && (
                          <Badge tone="amber">{pauseBadge(c.limitPause?.reason)}</Badge>
                        )}
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 truncate text-xs text-stone-500">
                    {c.messages.at(-1)?.text || 'New conversation'}
                  </p>
                  <p className="mt-1.5 text-[11px] text-stone-400">
                    {c.channel === 'demo' ? 'Sandbox' : 'WhatsApp'} · {shortDate(c.updatedAt)}
                  </p>
                </button>
              );
            })}
            {!result.items.length &&
              (filtered ? (
                <Empty
                  title="No matching conversations"
                  description="Try another name, number or filter."
                />
              ) : (
                <Empty
                  title="No conversations"
                  description="Customer messages appear here after WhatsApp is connected. Use the sandbox filter to see tests."
                />
              ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink/[0.06] p-3 text-xs text-stone-500">
            <button className="btn" disabled={page === 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            {/* Wraps onto two lines between the buttons in the narrow desktop column. */}
            <span className="min-w-0 flex-1 text-center tabular-nums">
              {result.total} {result.total === 1 ? 'conversation' : 'conversations'} · Page {page}{' '}
              of {Math.max(1, Math.ceil(result.total / 30))}
            </span>
            <button
              className="btn"
              disabled={page * 30 >= result.total}
              onClick={() => setPage(page + 1)}
            >
              Next
            </button>
          </div>
        </section>
        <section
          aria-label="Conversation messages"
          className={cn('min-h-0 min-w-0 flex-col', showThread ? 'flex' : 'hidden md:flex')}
        >
          {conversation ? (
            <>
              <div className="step-in flex flex-wrap items-center justify-between gap-3 border-b border-ink/[0.06] bg-white/40 px-4 py-3.5">
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    className="icon-btn md:hidden"
                    aria-label="Back to conversations"
                    onClick={() => navigate('inbox')}
                  >
                    <ArrowLeft className="size-5" />
                  </button>
                  <div className="min-w-0">
                    <strong className="block truncate font-serif text-[24px] leading-[1.2] font-normal tracking-[-0.005em] text-ink">
                      {conversation.customerName || 'Customer'}
                    </strong>
                    <p className="mt-0.5 font-mono text-[11px] tracking-[0.02em] text-stone-500">
                      {conversation.customerPhone || 'WhatsApp contact · phone number not shared'}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {flags?.blocked ? (
                    // A blocked chat has nothing for the bot or staff to do but unblock.
                    <>
                      <span className="rounded-xl bg-red-600/10 px-3 py-1.5 text-xs leading-relaxed text-red-800">
                        Blocked. Messages from this number are ignored.
                      </span>
                      <ActionButton
                        loading={pending === 'unblock'}
                        loadingLabel="Unblocking…"
                        onClick={() =>
                          void act(
                            'unblock',
                            `/conversations/${conversation.id}/block`,
                            { blocked: false },
                            'Number unblocked. The bot will answer them again.',
                          ).catch(() => undefined)
                        }
                      >
                        Unblock
                      </ActionButton>
                    </>
                  ) : (
                    <>
                      {conversation.mode === 'human' && conversation.botPausedAt && (
                        <>
                          <span className="rounded-xl bg-sun/20 px-3 py-1.5 text-xs leading-relaxed text-stone-700">
                            Waiting for staff while the bot is off. The bot answers again once it is
                            on.
                          </span>
                          <ActionButton
                            loading={pending === 'keep'}
                            loadingLabel="Saving…"
                            onClick={() => keepWithStaff(conversation.id)}
                          >
                            Keep with staff
                          </ActionButton>
                        </>
                      )}
                      {pauseNote && (
                        <>
                          <span className="rounded-xl bg-sun/20 px-3 py-1.5 text-xs leading-relaxed text-stone-700">
                            {pauseNote}
                          </span>
                          <ActionButton
                            loading={pending === 'keep'}
                            loadingLabel="Saving…"
                            onClick={() => keepWithStaff(conversation.id)}
                          >
                            Keep with staff
                          </ActionButton>
                        </>
                      )}
                      <ActionButton
                        className={conversation.mode === 'bot' ? 'btn-ink' : 'btn-primary'}
                        loading={pending === 'mode'}
                        loadingLabel={conversation.mode === 'bot' ? 'Taking over…' : 'Resuming…'}
                        onClick={() =>
                          void act(
                            'mode',
                            `/conversations/${conversation.id}/mode`,
                            { mode: conversation.mode === 'bot' ? 'human' : 'bot' },
                            conversation.mode === 'bot'
                              ? 'You’re handling this chat. The bot stays quiet here.'
                              : 'The bot is answering this chat again.',
                          ).catch(() => undefined)
                        }
                      >
                        {conversation.mode === 'bot' ? 'Take over' : 'Resume bot'}
                      </ActionButton>
                      {flags?.canBlock && (
                        <button
                          className="btn btn-quiet text-red-700 hover:bg-red-50 hover:text-red-800"
                          onClick={() => {
                            setBlockError('');
                            setBlocking(true);
                          }}
                        >
                          Block number
                        </button>
                      )}
                    </>
                  )}
                  {/* Owners only; also for a chat whose number WhatsApp never shared. */}
                  <CustomerDataActions
                    key={conversation.id}
                    conversation={conversation}
                    onErased={(id) => {
                      // The chat is gone: back to the list, unless staff opened another one.
                      if (shown.current === id) navigate('inbox', undefined, { keepScroll: true });
                      void refresh();
                    }}
                  />
                </div>
              </div>
              {/* New messages are announced; older history loading in at the top is not. */}
              <div
                ref={logRef}
                role="log"
                aria-busy={loading || undefined}
                className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-canvas/50 bg-[radial-gradient(rgb(14_6_4/0.07)_1px,transparent_1.5px)] bg-[length:18px_18px] p-4 max-md:max-h-[60dvh] max-md:min-h-56 max-md:flex-none sm:px-6"
              >
                {hasOlder && (
                  <ActionButton
                    className="mx-auto shrink-0"
                    loading={loading}
                    onClick={() => void older()}
                  >
                    Load older messages
                  </ActionButton>
                )}
                {conversation.messages.map((m) => (
                  <div
                    key={m.id}
                    className={cn(
                      'w-fit max-w-[85%] shrink-0 p-3 text-[13px] leading-[1.45]',
                      m.role === 'customer'
                        ? 'bubble-us bubble-in-right ml-auto'
                        : m.role === 'staff'
                          ? 'bubble-them bubble-in-left bg-brand-50'
                          : 'bubble-them bubble-in-left',
                    )}
                  >
                    <p dir="auto" className="whitespace-pre-wrap break-words">
                      {m.text}
                    </p>
                    <p
                      className={cn(
                        'mt-1.5 text-[11px]',
                        m.role === 'customer' ? 'text-cream/60' : 'text-stone-400',
                      )}
                    >
                      {m.role === 'staff' ? 'Staff · ' : ''}
                      {shortDate(m.createdAt)}
                      {deliveryLabel(conversation, m) && ` · ${deliveryLabel(conversation, m)}`}
                    </p>
                    {m.deliveryError && (
                      <p className="mt-2 rounded-lg bg-red-600/10 px-2 py-1 text-[11.5px] font-medium text-red-700">
                        {m.deliveryError}
                      </p>
                    )}
                    {m.role === 'assistant' && m.explanation && (
                      <WhyToggle explanation={m.explanation} />
                    )}
                  </div>
                ))}
                <div ref={end} />
              </div>
              <form
                className="border-t border-ink/[0.06] bg-white/40 p-3 sm:p-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  const sent = text;
                  if (!sent.trim()) return;
                  void act('reply', `/conversations/${conversation.id}/reply`, { text: sent })
                    // Keep anything typed while the reply was sending.
                    .then((ran) => ran && setText((current) => (current === sent ? '' : current)))
                    .catch(() => undefined);
                }}
              >
                <div className="flex items-center gap-2 rounded-full border border-ink/10 bg-white p-1 pl-1.5 shadow-[0_12px_24px_-18px_rgb(14_6_4/0.5)] transition-[border-color,box-shadow] duration-200 focus-within:border-brand-500/50 focus-within:shadow-[0_0_0_4px_var(--accent-muted)]">
                  <input
                    className="input min-w-0 rounded-full border-transparent bg-transparent shadow-none hover:border-transparent focus:border-transparent focus:bg-transparent focus:shadow-none"
                    aria-label="Reply as restaurant staff"
                    placeholder="Reply as staff…"
                    value={text}
                    maxLength={2000}
                    onChange={(e) => setText(e.target.value)}
                  />
                  <ActionButton
                    type="submit"
                    className="btn-primary size-11 shrink-0 p-0 md:size-10"
                    aria-label={pending === 'reply' ? 'Sending staff reply' : 'Send staff reply'}
                    title={!text.trim() ? 'Type a reply first.' : undefined}
                    disabled={!text.trim() && pending !== 'reply'}
                    loading={pending === 'reply'}
                    loadingLabel={<span className="sr-only">Sending</span>}
                  >
                    <Send className="size-4" />
                  </ActionButton>
                </div>
                <p className="mt-2 px-3 text-[11.5px] leading-relaxed text-stone-500">
                  {windowClosed
                    ? 'The reply window has closed. Wait for the customer to message or send an approved status update.'
                    : 'Replying pauses this conversation’s bot. Free-form WhatsApp replies require an open 24-hour customer service window.'}
                </p>
              </form>
            </>
          ) : loading ? (
            <p
              role="status"
              className="flex flex-1 items-center justify-center gap-2 text-sm text-stone-500"
            >
              <Spinner />
              Loading conversation…
            </p>
          ) : (
            <Empty
              title="Choose a conversation"
              description="Select a customer to read the history and reply."
            />
          )}
        </section>
      </div>
    </>
  );
}
