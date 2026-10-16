import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Send } from 'lucide-react';
import type { Company, Conversation, Message, PageResult } from '../shared/types';
import { resumesAfterLimit } from '../domain/engine';
import { useAction, useWorkspace } from '../lib/workspace';
import { api } from '../lib/api';
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
  Status,
} from './ui';
import { WhyToggle } from './ReplyExplanation';

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
export function deliveryLabel(conversation: Conversation, m: Message, now = Date.now()) {
  if (m.delivery) return DELIVERY_LABELS[m.delivery];
  // A fresh WhatsApp reply without a receipt is still queued or on its way.
  if (
    conversation.channel === 'whatsapp' &&
    m.role === 'assistant' &&
    now - Date.parse(m.createdAt) < 120000
  )
    return 'Sending…';
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
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);
  const end = useRef<HTMLDivElement>(null);
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
  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 200);
    return () => {
      clearTimeout(timer);
      requestId.current++;
    };
  }, [refresh, data.summary]);
  useEffect(() => {
    let active = true;
    setConversation(undefined);
    setHistoryPage(1);
    setText('');
    setError('');
    setBlocking(false);
    setBlockError('');
    if (detailId) {
      setLoading(true);
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
  useEffect(() => {
    if (!detailId) return;
    let active = true;
    const poll = setInterval(() => {
      if (document.hidden || busy) return;
      void api<Conversation>(`/conversations/${detailId}`, data.company.id)
        .then((c) => {
          if (active)
            setConversation((old) => ({
              ...c,
              messages: [
                ...new Map(
                  [...(old?.messages ?? []), ...c.messages].map((m) => [m.id, m]),
                ).values(),
              ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
            }));
        })
        .catch((e) => {
          if (active) setError(`Updates delayed: ${e.message}`);
        });
    }, 10000);
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [detailId, data.company.id, busy]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
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
    setLoading(true);
    try {
      const r = await api<PageResult<Message>>(
        `/conversations/${conversation.id}/messages?page=${historyPage + 1}`,
        data.company.id,
      );
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
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  const flags = conversation
    ? conversationFlags(conversation, Date.now(), data.company)
    : undefined;
  const pauseNote = conversation ? limitNote(conversation, Date.now(), data.company) : '';
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
      <ErrorNotice message={error} />
      <div className="card grid h-[calc(100dvh-18rem)] min-h-[24rem] max-h-[52rem] overflow-hidden md:h-[calc(100dvh-15rem)] md:grid-cols-[18rem_1fr]">
        <section
          aria-label="Conversation list"
          className={cn(
            'min-h-0 flex-col border-r border-ink/[0.06]',
            detailId ? 'hidden md:flex' : 'flex',
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
              Show sandbox conversations
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
                  onClick={() => navigate('inbox', c.id)}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="text-[13.5px] font-semibold break-words text-ink">
                      {c.customerName || c.customerPhone}
                    </strong>
                    {(c.mode === 'human' || badge) && (
                      <span className="flex flex-wrap items-center gap-1.5">
                        {c.mode === 'human' && <Status value="human" />}
                        {badge === 'blocked' && <Badge tone="red">Blocked</Badge>}
                        {badge === 'limit' && <Badge tone="amber">AI limit</Badge>}
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
            {!result.items.length && (
              <Empty
                title="No conversations"
                description="Customer messages appear here after WhatsApp is connected. Use the sandbox filter to see tests."
              />
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink/[0.06] p-3 text-xs text-stone-500">
            <button className="btn" disabled={page === 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <span>
              {result.total} total · {page}
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
          className={cn('min-h-0 min-w-0 flex-col', detailId ? 'flex' : 'hidden md:flex')}
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
                </div>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-canvas/50 bg-[radial-gradient(rgb(14_6_4/0.07)_1px,transparent_1.5px)] bg-[length:18px_18px] p-4 sm:px-6">
                {hasOlder && (
                  <button
                    className="btn mx-auto shrink-0"
                    disabled={loading}
                    onClick={() => void older()}
                  >
                    Load older messages
                  </button>
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
                  Replying pauses this conversation’s bot. Free-form WhatsApp replies require an
                  open 24-hour customer service window.
                </p>
              </form>
            </>
          ) : (
            <Empty
              title={loading ? 'Loading conversation…' : 'Choose a conversation'}
              description="Select a customer to read the history and reply."
            />
          )}
        </section>
      </div>
    </>
  );
}
