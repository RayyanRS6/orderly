import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Send } from 'lucide-react';
import type { Conversation, Message, PageResult } from '../shared/types';
import { useWorkspace } from '../lib/workspace';
import { api } from '../lib/api';
import { cn, shortDate } from '../lib/utils';
import { CustomSelect, Empty, ErrorNotice, PageHeading, Status } from './ui';

export function Inbox() {
  const { data, mutate, busy, navigate, detailId } = useWorkspace();
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
  async function act(path: string, body: unknown) {
    setError('');
    try {
      const c = await mutate<Conversation>(path, body);
      setConversation(c);
      await refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }
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
  return (
    <>
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
            <label className="flex items-center gap-2 text-xs">
              <input
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
          <div className="min-h-0 flex-1 overflow-y-auto">
            {result.items.map((c) => (
              <button
                key={c.id}
                className={cn(
                  'w-full border-b border-ink/[0.05] p-4 text-left hover:bg-white/50',
                  c.id === detailId && 'bg-white/80',
                )}
                onClick={() => navigate('inbox', c.id)}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-sm break-words">
                    {c.customerName || c.customerPhone}
                  </strong>
                  {c.mode === 'human' && <Status value="human" />}
                </div>
                <p className="mt-2 truncate text-xs text-stone-500">
                  {c.messages.at(-1)?.text || 'New conversation'}
                </p>
                <p className="mt-2 text-xs text-stone-400">
                  {c.channel === 'demo' ? 'Sandbox' : 'WhatsApp'} · {shortDate(c.updatedAt)}
                </p>
              </button>
            ))}
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
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/[0.06] p-4">
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    className="icon-btn md:hidden"
                    aria-label="Back to conversations"
                    onClick={() => navigate('inbox')}
                  >
                    <ArrowLeft className="size-5" />
                  </button>
                  <div className="min-w-0">
                    <strong className="block truncate text-sm">
                      {conversation.customerName || 'Customer'}
                    </strong>
                    <p className="text-xs text-stone-500">{conversation.customerPhone}</p>
                  </div>
                </div>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    void act(`/conversations/${conversation.id}/mode`, {
                      mode: conversation.mode === 'bot' ? 'human' : 'bot',
                    })
                  }
                >
                  {conversation.mode === 'bot' ? 'Take over' : 'Resume bot'}
                </button>
              </div>
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-canvas/50 p-4">
                {hasOlder && (
                  <button className="btn mx-auto" disabled={loading} onClick={() => void older()}>
                    Load older messages
                  </button>
                )}
                {conversation.messages.map((m) => (
                  <div
                    key={m.id}
                    className={cn(
                      'max-w-[90%] rounded-xl border p-3 text-[13px]',
                      m.role === 'customer'
                        ? 'ml-auto border-ink bg-ink text-cream'
                        : 'border-white bg-white/80',
                    )}
                  >
                    <p dir="auto" className="whitespace-pre-wrap break-words">
                      {m.text}
                    </p>
                    <p
                      className={cn(
                        'mt-2 text-xs',
                        m.role === 'customer' ? 'text-cream/50' : 'text-stone-500',
                      )}
                    >
                      {m.role === 'staff' ? 'Staff · ' : ''}
                      {shortDate(m.createdAt)}
                      {m.delivery && ` · ${m.delivery}`}
                    </p>
                    {m.deliveryError && (
                      <p className="mt-2 text-xs text-red-700">{m.deliveryError}</p>
                    )}
                  </div>
                ))}
                <div ref={end} />
              </div>
              <form
                className="border-t border-ink/[0.06] p-4"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (
                    text.trim() &&
                    (await act(`/conversations/${conversation.id}/reply`, { text }))
                  )
                    setText('');
                }}
              >
                <div className="flex gap-2">
                  <input
                    className="input min-w-0"
                    aria-label="Reply as restaurant staff"
                    placeholder="Reply as staff…"
                    value={text}
                    maxLength={2000}
                    onChange={(e) => setText(e.target.value)}
                  />
                  <button
                    className="btn btn-primary shrink-0"
                    aria-label="Send staff reply"
                    disabled={busy || !text.trim()}
                  >
                    <Send className="size-4" />
                  </button>
                </div>
                <p className="mt-2 text-xs text-stone-500">
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
