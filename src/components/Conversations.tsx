import { useEffect, useRef, useState } from 'react';
export { Inbox } from './Inbox';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Bot,
  Check,
  ChevronRight,
  MessageCircle,
  Plus,
  RotateCcw,
  Send,
  ShoppingBag,
  UserRound,
  X,
} from 'lucide-react';
import type { BotAction, Conversation, Product, TurnResult } from '../shared/types';
import { money } from '../shared/types';
import { api } from '../lib/api';
import { readTestChat, saveTestChat, testChatMatches } from '../lib/test-chat';
import type { PageResult, Message } from '../shared/types';
import { quoteCart } from '../domain/engine';
import { sellableCatalog } from '../shared/deals';
import { useNow } from '../lib/deal-form';
import { useAction, useWorkspace } from '../lib/workspace';
import { cn, label } from '../lib/utils';
import {
  ActionButton,
  Badge,
  CustomSelect,
  Empty,
  ErrorNotice,
  Field,
  Modal,
  PageHeading,
  Spinner,
  Status,
} from './ui';
import { WhyToggle } from './ReplyExplanation';

function Messages({ conversation, waiting }: { conversation?: Conversation; waiting?: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (conversation?.messages?.length || waiting)
      end.current?.scrollIntoView({ block: 'nearest' });
  }, [conversation?.messages?.length, waiting]);
  return (
    <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto bg-paper/70 p-5 sm:p-6">
      {!conversation?.messages?.length && (
        <div className="py-2 text-center sm:py-8">
          <div className="bob mx-auto mb-5 hidden size-14 -rotate-6 items-center justify-center rounded-2xl bg-ink text-brand-500 shadow-[0_16px_30px_-14px_rgb(14_6_4/0.75)] sm:flex">
            <MessageCircle className="size-7" />
          </div>
          <h3 className="panel-title text-[28px] leading-[1.05] tracking-[-0.01em]">
            Every good order starts with a hello.
          </h3>
          <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-stone-500">
            Ask for the menu, build a cart, and see how your restaurant responds.
          </p>
        </div>
      )}
      {conversation?.messages?.map((message) => (
        <div
          key={message.id}
          className={cn(
            'flex items-end gap-2.5',
            message.role === 'customer'
              ? 'bubble-in-right justify-end'
              : 'bubble-in-left justify-start',
          )}
        >
          {message.role !== 'customer' && (
            <span
              className={cn(
                'mb-0.5 flex size-7 shrink-0 items-center justify-center rounded-[10px] shadow-[0_8px_16px_-8px_rgb(14_6_4/0.6)]',
                message.role === 'staff' ? 'bg-sun text-ink' : 'bg-ink text-brand-500',
              )}
            >
              {message.role === 'staff' ? (
                <UserRound className="size-3.5" />
              ) : (
                <Bot className="size-3.5" />
              )}
            </span>
          )}
          <div
            className={cn(
              'max-w-[85%] px-4 py-3 text-[13px] leading-relaxed',
              message.role === 'customer' ? 'bubble-us' : 'bubble-them text-stone-700',
            )}
          >
            <p dir="auto" className="whitespace-pre-wrap break-words">
              {message.text}
            </p>
            <p
              className={cn(
                'mt-1.5 text-right font-mono text-[11px] tracking-[0.02em]',
                message.role === 'customer' ? 'text-cream/55' : 'text-stone-400',
              )}
            >
              {message.role === 'staff' ? 'Staff · ' : ''}
              {(() => {
                const d = new Date(message.createdAt);
                return Number.isNaN(d.getTime())
                  ? ''
                  : d.toLocaleTimeString('en-PK', {
                      hour: '2-digit',
                      minute: '2-digit',
                    });
              })()}
            </p>
            {message.role === 'assistant' && message.explanation && (
              <WhyToggle explanation={message.explanation} />
            )}
          </div>
        </div>
      ))}
      {waiting && (
        <div
          role="status"
          className="bubble-them bubble-in-left ml-[38px] w-fit px-4 py-3 text-[13px] text-stone-500"
        >
          Preparing a response…
        </div>
      )}
      <div ref={end} />
    </div>
  );
}

export function Playground({ active = true }: { active?: boolean }) {
  const { data, mutate, navigate } = useWorkspace();
  const { pending, run } = useAction();
  const [saved] = useState(() => readTestChat(data.company.id));
  const [id, setId] = useState<string | undefined>(saved.conversationId);
  const [latest, setLatest] = useState<Conversation>();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Product>();
  const [name, setName] = useState('');
  const [fulfillment, setFulfillment] = useState<'pickup' | 'delivery'>('pickup');
  const [address, setAddress] = useState('');
  const [zone, setZone] = useState(data.company.deliveryZones?.[0]?.name || '');
  const conversation = latest;
  const [testTarget, setTestTarget] = useState<'draft' | 'published'>(saved.target);
  const [restoring, setRestoring] = useState(!!saved.conversationId);
  const restoreGeneration = useRef(0);
  const [details, setDetails] = useState(false);
  // Deals are on or off by the clock: look again every minute while this page is open.
  const now = useNow(active && !!data.deals?.length);
  useEffect(() => {
    if (!saved.conversationId) return;
    let mounted = true;
    const generation = restoreGeneration.current;
    void api<Conversation>(`/conversations/${saved.conversationId}`, data.company.id)
      .then((result) => {
        if (!mounted || generation !== restoreGeneration.current) return;
        if (result.companyId !== data.company.id || result.channel !== 'demo')
          throw new Error('This saved chat is not a test conversation for this restaurant.');
        setLatest(result);
      })
      .catch((reason) => {
        if (mounted && generation === restoreGeneration.current)
          setError(
            `Could not restore the saved chat: ${(reason as Error).message} Refresh chat to start a new test.`,
          );
      })
      .finally(() => {
        if (mounted && generation === restoreGeneration.current) setRestoring(false);
      });
    return () => {
      mounted = false;
    };
  }, [data.company.id, saved.conversationId]);
  useEffect(() => {
    if (!active) {
      setDetails(false);
      setSelected(undefined);
    }
  }, [active]);
  const stale = !!latest && !testChatMatches(data.company, latest, testTarget);
  const blocked = restoring || stale || (!!id && !latest);
  const blockedReason = restoring
    ? 'Restoring your saved test chat…'
    : stale
      ? 'The bot settings changed. Refresh chat to test them.'
      : undefined;
  function resetChat(target = testTarget) {
    restoreGeneration.current++;
    saveTestChat(data.company.id, { target });
    setTestTarget(target);
    setId(undefined);
    setLatest(undefined);
    setRestoring(false);
    setError('');
    setText('');
    setName('');
    setAddress('');
    setFulfillment('pickup');
    setZone(data.company.deliveryZones?.[0]?.name || '');
    setSelected(undefined);
    setDetails(false);
  }
  /** Sends one test message; `key` picks which button shows the spinner. */
  async function send(message: string, key = 'send') {
    if (blocked) return false;
    // Refreshing the chat while the bot answers drops that answer.
    const generation = restoreGeneration.current;
    let sent = false;
    await run(key, async () => {
      setError('');
      try {
        const result = await mutate<TurnResult>(
          '/chat',
          { conversationId: id, text: message, messageId: crypto.randomUUID(), testTarget },
          undefined,
          // The error shows next to the message box instead.
          { quiet: true },
        );
        if (generation !== restoreGeneration.current) return;
        saveTestChat(data.company.id, {
          conversationId: result.conversation.id,
          target: testTarget,
        });
        setId(result.conversation.id);
        setLatest(result.conversation);
        // Keep anything typed while the bot was answering.
        setText((current) => (current === message ? '' : current));
        sent = true;
      } catch (reason) {
        if (generation === restoreGeneration.current) setError((reason as Error).message);
      }
    });
    return sent;
  }
  // The menu as the bot sells it at this moment: deals first, then the menu items. A deal
  // already in the cart stays listed even when paused or ended, so its line keeps its name.
  const catalog = sellableCatalog(
    data.company,
    data.products,
    data.deals ?? [],
    new Date(now).toISOString(),
    { keepIds: conversation?.cart.items.map((item) => item.productId) },
  );
  const onMenu = catalog.filter(
    (product) => product.deal?.state !== 'paused' && product.deal?.state !== 'ended',
  );
  let total: number | undefined;
  try {
    if (conversation?.cart.items.length)
      total = quoteCart(data.company, catalog, conversation.cart).total;
  } catch {
    /* The authoritative review will explain unavailable options. */
  }
  return (
    <>
      <PageHeading
        title="Test your bot"
        description="Try the complete ordering experience before connecting your number."
      >
        <button className="btn" onClick={() => resetChat()}>
          <RotateCcw className="size-4" />
          Refresh chat
        </button>
      </PageHeading>
      <div className="notice mb-5 grid gap-4 p-4 text-[13px] text-cream sm:grid-cols-[minmax(12rem,18rem)_1fr] sm:items-end sm:p-5">
        <Field label="Configuration to test">
          <CustomSelect
            theme="dark"
            value={testTarget}
            disabled={restoring}
            onChange={(value) => {
              resetChat(value as 'draft' | 'published');
            }}
            options={[
              {
                value: 'draft',
                label: `Saved draft · revision ${data.company.bot?.revision ?? 0}`,
              },
              {
                value: 'published',
                label: `Published · version ${data.company.bot?.published?.version ?? 'none'}`,
                disabled: !data.company.bot?.published,
              },
            ]}
          />
        </Field>
        <div className="space-y-1 text-xs leading-relaxed text-cream/65">
          <p>
            AI:{' '}
            <strong className="text-cream">
              {(data.company.ai?.provider !== 'mock' && data.company.ai?.model) || 'Not connected'}
            </strong>
            {' · '}Menu:{' '}
            <strong className="text-cream">
              {data.company.catalogSource === 'sheets' ? 'Google Sheet' : 'In-app catalog'}
            </strong>
          </p>
          <p>
            {data.company.catalogSyncedAt
              ? `Menu refreshed ${new Date(data.company.catalogSyncedAt).toLocaleString('en-PK')}. `
              : ''}
            {/* The built-in demo AI is free and local. */}
            {data.company.ai && data.company.ai.provider !== 'mock' ? 'API charges apply. ' : ''}
            No WhatsApp messages or order-Sheet rows are created.
          </p>
        </div>
      </div>
      <div className="grid gap-5 xl:grid-cols-3">
        <div className="card flex h-[calc(100dvh-6rem)] min-h-[20rem] max-h-[44rem] flex-col overflow-hidden sm:h-[calc(100dvh-23rem)] xl:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/[0.06] bg-linear-to-b from-white/70 to-white/30 px-5 py-3.5 sm:px-6">
            <div className="flex min-w-0 flex-1 basis-48 items-center gap-3">
              <div className="flex size-10 shrink-0 -rotate-6 items-center justify-center rounded-xl bg-ink text-brand-500 shadow-[0_10px_20px_-10px_rgb(14_6_4/0.75)]">
                <MessageCircle className="size-5" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-[15px] font-[650] tracking-[-0.01em] text-ink">
                  {data.company.name}
                </p>
                <p className="mt-0.5 truncate text-xs text-stone-500">
                  Preview conversation · no WhatsApp delivery
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone={data.company.ai?.provider === 'mock' ? 'amber' : 'green'}>
                {data.company.ai?.provider === 'mock' ? 'AI not connected' : data.company.ai?.model}
              </Badge>
              <button
                type="button"
                className="icon-btn-glass max-md:size-11"
                onClick={() => resetChat()}
                aria-label="Refresh chat — start a new test conversation"
                title="Refresh chat — start a new test conversation"
              >
                <RotateCcw className="size-4" />
              </button>
            </div>
          </div>
          {restoring && (
            <p
              role="status"
              className="step-in border-b border-ink/[0.04] bg-white/40 px-5 py-2.5 text-[13px] text-stone-500 sm:px-6"
            >
              Restoring your saved test conversation…
            </p>
          )}
          <Messages conversation={conversation} waiting={!!pending} />
          {conversation?.mode === 'human' && (
            <div className="step-in glow-dark border-t border-white/[0.06] bg-ink px-5 py-3 text-xs font-medium text-cream/75 sm:px-6">
              This conversation is waiting for staff.{' '}
              <button
                className="ml-1 rounded-full bg-brand-500 px-2.5 py-0.5 font-semibold text-ink shadow-[0_8px_16px_-8px_rgb(255_105_44/0.9)] transition-colors hover:bg-brand-400"
                onClick={() => navigate('inbox', conversation.id)}
              >
                Open inbox
              </button>
            </div>
          )}
          <div className="border-t border-ink/[0.06] bg-linear-to-b from-white/50 to-white/80 p-4 sm:p-5">
            <div className="stagger mb-3 flex flex-wrap gap-2">
              {['Show menu', 'Repeat my order', 'Review order', 'Talk to staff'].map((title) => (
                <button
                  key={String(title)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-ink/10 bg-white/85 px-3.5 py-1.5 text-xs font-semibold text-stone-700 shadow-[inset_0_1px_0_#fff,0_6px_14px_-10px_rgb(14_6_4/0.35)] transition-[background-color,border-color,color,translate,scale] duration-200 ease-[var(--ease-soft)] hover:-translate-y-px hover:border-brand-500/40 hover:bg-white hover:text-ink active:scale-95 disabled:opacity-50 disabled:hover:translate-y-0 aria-busy:border-ink aria-busy:bg-ink aria-busy:text-cream"
                  disabled={blocked}
                  title={blockedReason}
                  aria-busy={pending === `quick-${title}` || undefined}
                  onClick={() => void send(title, `quick-${title}`)}
                >
                  {pending === `quick-${title}` && <Spinner className="size-3.5" />}
                  {String(title)}
                </button>
              ))}
            </div>
            <ErrorNotice message={error} />
            <ErrorNotice
              message={
                stale
                  ? 'The bot configuration changed. Your previous chat is preserved. Refresh chat to test the new settings.'
                  : ''
              }
            />
            <form
              className="mt-2 flex items-center gap-1.5 rounded-full border border-ink/10 bg-white/90 p-1.5 shadow-[inset_0_1px_0_#fff,0_16px_30px_-22px_rgb(14_6_4/0.5)] transition-colors focus-within:border-brand-500/55 focus-within:shadow-[inset_0_1px_0_#fff,0_0_0_4px_rgb(255_105_44/0.14)]"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) void send(text);
              }}
            >
              <label className="sr-only" htmlFor="chat-message">
                Message your bot
              </label>
              <input
                id="chat-message"
                className="input flex-1 rounded-full border-0 bg-transparent pr-2 pl-4 shadow-none focus:bg-transparent focus:shadow-none"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Type a message… or try ‘2 biryani’"
                maxLength={2000}
                autoComplete="off"
              />
              <ActionButton
                type="submit"
                className="btn-primary size-10 shrink-0 rounded-full p-0 max-md:size-11"
                aria-label={pending === 'send' ? 'Sending message' : 'Send message'}
                disabled={blocked || (!text.trim() && pending !== 'send')}
                title={blockedReason ?? (!text.trim() ? 'Type a message first.' : undefined)}
                loading={pending === 'send'}
                loadingLabel={<span className="sr-only">Sending</span>}
              >
                <Send className="size-4" />
              </ActionButton>
            </form>
            <p className="mt-2.5 text-center text-[11px] font-medium text-stone-400">
              English · <span lang="ur">اردو</span> · Roman Urdu · Chat stays saved until you
              refresh it
            </p>
          </div>
        </div>
        <div className="space-y-5">
          <section className="card p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="panel-title flex items-center gap-2">
                <ShoppingBag className="size-4 text-brand-600" />
                Current order
              </h2>
              <span className="rounded-full bg-ink/[0.05] px-2.5 py-1 text-[11px] font-semibold tabular-nums text-stone-600">
                {conversation?.cart.items.reduce((n, i) => n + i.quantity, 0) || 0} items
              </span>
            </div>
            {!conversation?.cart.items.length ? (
              <p className="rounded-2xl border border-dashed border-ink/10 bg-paper/70 px-4 py-5 text-center text-sm text-stone-400">
                Your cart is waiting for something good.
              </p>
            ) : (
              <div className="stagger space-y-2">
                {conversation.cart.items.map((item, i) => {
                  const product = catalog.find((p) => p.id === item.productId);
                  return (
                    <div
                      key={`${item.productId}-${i}`}
                      className="flex items-center gap-3 rounded-2xl bg-white/70 p-2 pr-2.5 shadow-[0_0_0_1px_rgb(14_6_4/0.04),0_8px_18px_-14px_rgb(14_6_4/0.35)]"
                    >
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-paper text-xl">
                        {product?.emoji || '🍽️'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-ink">
                          {item.quantity} × {product?.name || 'Unavailable item'}
                        </p>
                        <p className="mt-0.5 text-xs text-stone-500">
                          {product?.deal ? (
                            dealPicks(product, item.modifierIds)
                          ) : (
                            <>
                              {product?.variants.find((v) => v.id === item.variantId)?.name}
                              {item.modifierIds.length
                                ? ` · ${item.modifierIds.length} extras`
                                : ''}
                            </>
                          )}
                        </p>
                      </div>
                      {conversation.cart.status !== 'submitted' && (
                        <button
                          className="icon-btn size-8 text-stone-400 hover:bg-red-50 hover:text-red-600"
                          aria-label={`Remove ${product?.name}`}
                          aria-busy={pending === `remove-${i}` || undefined}
                          onClick={() => void send(`Remove ${product?.name}`, `remove-${i}`)}
                        >
                          {pending === `remove-${i}` ? <Spinner /> : <X className="size-4" />}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="mt-4 border-t border-dashed border-ink/10 pt-4">
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-stone-500">
                  Total {fulfillment === 'delivery' ? 'with delivery' : ''}
                </span>
                <strong className="font-serif text-[26px] leading-none font-normal tracking-[-0.01em] tabular-nums text-ink">
                  {total !== undefined ? money(total) : '—'}
                </strong>
              </div>
              {conversation?.cart.customerName && (
                <p className="mt-3 text-xs text-stone-500">
                  {conversation.cart.customerName} ·{' '}
                  {label(conversation.cart.fulfillment || 'pickup')}
                </p>
              )}
              {conversation?.cart.status === 'submitted' ? (
                <div className="enter-pop mt-4 rounded-2xl border border-success-700/15 bg-success-700/[0.07] p-4 text-[13px] text-success-800">
                  <Check className="pop-spin mb-2 block size-6 rounded-full bg-success-700 p-1 text-white shadow-[0_8px_16px_-8px_rgb(23_124_74/0.9)]" />
                  Order received. Waiting for the restaurant.
                  <button
                    className="mt-2 block font-semibold underline decoration-success-700/40 underline-offset-2 transition-colors hover:decoration-success-700"
                    onClick={() => navigate('orders')}
                  >
                    View orders
                  </button>
                </div>
              ) : (
                <>
                  <button
                    className="btn mt-4 w-full"
                    disabled={!conversation?.cart.items.length}
                    title={!conversation?.cart.items.length ? 'Add an item first.' : undefined}
                    onClick={() => setDetails(true)}
                  >
                    Add order details
                    <ChevronRight className="size-4" />
                  </button>
                  {conversation?.cart.status === 'awaiting_confirmation' && (
                    <ActionButton
                      className="btn-primary enter-pop mt-2 w-full"
                      loading={pending === 'confirm'}
                      loadingLabel="Confirming…"
                      onClick={() => void send('Confirm order', 'confirm')}
                    >
                      <Check className="size-4" />
                      Confirm order
                    </ActionButton>
                  )}
                </>
              )}
            </div>
          </section>
          <section className="card overflow-hidden">
            <div className="border-b border-ink/[0.06] p-5">
              <h2 className="panel-title">On the menu</h2>
              <p className="mt-1 text-xs text-stone-500">
                Choose an item to add it to the conversation.
              </p>
            </div>
            <div className="stagger max-h-80 space-y-1 overflow-y-auto p-2">
              {onMenu.map((product) => (
                <button
                  key={product.id}
                  className="group flex w-full items-center gap-3 rounded-2xl p-2.5 text-left transition-colors duration-200 hover:bg-white/80 disabled:opacity-40"
                  disabled={!product.available || conversation?.cart.status === 'submitted'}
                  title={!product.available ? dealNote(product) || 'Sold out' : undefined}
                  onClick={() => setSelected(product)}
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-paper text-2xl shadow-[inset_0_0_0_1px_rgb(14_6_4/0.05)] transition-transform duration-300 ease-[var(--ease-spring)] group-enabled:group-hover:-rotate-6 group-enabled:group-hover:scale-110">
                    {product.emoji}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold text-ink">{product.name}</span>
                    <span className="mt-1 block text-xs tabular-nums text-stone-500">
                      {product.variants.length ? 'From ' : ''}
                      {money(product.price)}
                      {dealNote(product) && ` · ${dealNote(product)}`}
                    </span>
                  </span>
                  <Plus className="size-7 shrink-0 rounded-full bg-ink/[0.05] p-1.5 text-stone-500 group-enabled:group-hover:bg-brand-500 group-enabled:group-hover:text-ink transition-[background-color,color,transform] duration-300 ease-[var(--ease-soft)] group-enabled:group-hover:shadow-[0_8px_16px_-8px_rgb(255_105_44/0.9)]" />
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>
      <Modal
        open={details}
        onOpenChange={setDetails}
        title="Order details"
        description="These details are included in the final customer review."
      >
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (fulfillment === 'delivery' && (!zone.trim() || !address.trim())) {
              return;
            }
            const saved = await send(
              fulfillment === 'delivery'
                ? `My name is ${name}. I want delivery. My area is ${zone}. Address: ${address}`
                : `My name is ${name}. I want pickup.`,
              'details',
            );
            if (saved) setDetails(false);
          }}
        >
          <Field label="Customer name">
            <input
              className="input"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Fulfillment">
            <CustomSelect
              value={fulfillment}
              onChange={(val) => setFulfillment(val as 'pickup' | 'delivery')}
              options={[
                { value: 'pickup', label: 'Pickup · pay at the restaurant' },
                { value: 'delivery', label: 'Delivery · pay cash on delivery' },
              ]}
            />
          </Field>
          {fulfillment === 'delivery' && (
            <>
              <Field label="Delivery area">
                <CustomSelect
                  placeholder="Select an area"
                  required
                  value={zone}
                  onChange={(val) => setZone(val)}
                  options={(data.company.deliveryZones || []).map((z) => ({
                    value: z.name,
                    label: `${z.name} · ${money(z.fee)}`,
                  }))}
                />
              </Field>
              <Field label="Complete address">
                <textarea
                  className="input"
                  value={address}
                  required
                  onChange={(e) => setAddress(e.target.value)}
                />
              </Field>
            </>
          )}
          <ActionButton
            type="submit"
            className="btn-primary w-full"
            loading={pending === 'details'}
            loadingLabel="Saving…"
          >
            Save details
          </ActionButton>
        </form>
      </Modal>
      {selected && (
        <AddItem
          product={selected}
          loading={pending === 'add'}
          close={() => setSelected(undefined)}
          add={async (action) => {
            if (await send(addText(selected, action), 'add')) setSelected(undefined);
          }}
        />
      )}
    </>
  );
}
/** What the Add dialog sends: "Add 2 Chicken Karahi, option Full, with Extra butter". */
export function addText(product: Product, action: Extract<BotAction, { type: 'add_item' }>) {
  const variant = product.variants.find((item) => item.id === action.variantId)?.name;
  const extras = product.modifiers
    .filter((item) => action.modifierIds?.includes(item.id))
    .map((item) => item.name);
  // A deal's picks go in the same part of the message as the deal ("Add 1 Deal 1 with Sprite /
  // Fries"): after a comma or "and" the bot would read them as dishes of their own.
  const picks = product.deal ? pickNames(product, action.modifierIds ?? []) : [];
  return [
    `Add ${action.quantity} ${product.name}${picks.length ? ` with ${picks.join(' / ')}` : ''}`,
    variant ? `option ${variant}` : '',
    extras.length ? `with ${extras.join(' and ')}` : '',
    action.notes ? `note: ${action.notes}` : '',
  ]
    .filter(Boolean)
    .join(', ');
}
/** A deal's picked option names, in its choice groups' order. */
function pickNames(product: Product, optionIds: string[]): string[] {
  return (product.deal?.choices ?? []).flatMap((group) =>
    group.options.filter((option) => optionIds.includes(option.id)).map((option) => option.name),
  );
}
/** A deal line's picks as order lines word them: "Drink: Sprite, Side: Fries". */
function dealPicks(product: Product, optionIds: string[]): string {
  return (product.deal?.choices ?? [])
    .flatMap((group) =>
      group.options
        .filter((option) => optionIds.includes(option.id))
        .map((option) => `${group.name}: ${option.name}`),
    )
    .join(', ');
}
/** Why a deal on the list can't be added now, or undefined for a menu item or a deal that's on. */
function dealNote(product: Product): string | undefined {
  if (product.deal?.state === 'later')
    return product.deal.when ? `Not on now · ${product.deal.when}` : 'Not on now';
  if (product.deal?.state === 'sold_out') return 'Sold out';
  return undefined;
}

export function AddItem({
  product,
  loading,
  close,
  add,
}: {
  product: Product;
  /** The order dialog shows a failure itself, from the workspace. */
  loading: boolean;
  close: () => void;
  add: (action: Extract<BotAction, { type: 'add_item' }>) => Promise<void>;
}) {
  const [quantity, setQuantity] = useState(1);
  const [variant, setVariant] = useState(product.variants[0]?.id || '');
  const [extras, setExtras] = useState<string[]>([]);
  // A deal's pick in each choice group, by group id. Nothing is picked for the customer.
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  const choices = product.deal?.choices ?? [];
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={product.name}
      description={
        product.deal
          ? [product.description, `Includes: ${product.deal.includes.join(' · ')}`]
              .filter(Boolean)
              .join(' ')
          : product.description
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void add({
            type: 'add_item',
            productId: product.id,
            quantity,
            variantId: variant || undefined,
            modifierIds: product.deal
              ? choices.flatMap((group) => (picks[group.id] ? [picks[group.id]!] : []))
              : extras,
            notes,
          });
        }}
      >
        <Field label="Quantity">
          <input
            className="input"
            type="number"
            min={1}
            max={50}
            required
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
          />
        </Field>
        {product.variants.length > 0 && (
          <Field label="Size">
            <CustomSelect
              value={variant}
              onChange={(val) => setVariant(val)}
              options={product.variants.map((v) => ({
                value: v.id,
                label: `${v.name} · ${money(v.price)}`,
              }))}
            />
          </Field>
        )}
        {choices.map((group) => (
          <fieldset key={group.id}>
            <legend className="field-label">{group.name}</legend>
            {group.options.map((option) => (
              <label
                className="my-1 flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-transparent px-3 py-2.5 text-sm transition-colors hover:bg-white has-checked:border-brand-500/30 has-checked:bg-brand-500/[0.07]"
                key={option.id}
              >
                <span className="flex items-center gap-2.5">
                  <input
                    className="size-4 shrink-0"
                    type="radio"
                    name={`pick-${group.id}`}
                    required
                    checked={picks[group.id] === option.id}
                    onChange={() => setPicks({ ...picks, [group.id]: option.id })}
                  />
                  {option.name}
                </span>
                {option.price > 0 && (
                  <span className="font-medium tabular-nums text-stone-500">
                    + {money(option.price)}
                  </span>
                )}
              </label>
            ))}
          </fieldset>
        ))}
        {product.modifiers.length > 0 && (
          <fieldset>
            <legend className="field-label">Extras</legend>
            {product.modifiers.map((m) => (
              <label
                className="my-1 flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-transparent px-3 py-2.5 text-sm transition-colors hover:bg-white has-checked:border-brand-500/30 has-checked:bg-brand-500/[0.07]"
                key={m.id}
              >
                <span className="flex items-center gap-2.5">
                  <input
                    className="size-4 shrink-0"
                    type="checkbox"
                    checked={extras.includes(m.id)}
                    onChange={(e) =>
                      setExtras(
                        e.target.checked ? [...extras, m.id] : extras.filter((id) => id !== m.id),
                      )
                    }
                  />
                  {m.name}
                </span>
                <span className="font-medium tabular-nums text-stone-500">+ {money(m.price)}</span>
              </label>
            ))}
          </fieldset>
        )}
        <Field label="Special instructions">
          <input
            className="input"
            placeholder="For example, less spicy"
            value={notes}
            maxLength={300}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        <ActionButton
          type="submit"
          className="btn-primary w-full"
          loading={loading}
          loadingLabel="Adding…"
        >
          <Plus className="size-4" />
          Add to order
        </ActionButton>
      </form>
    </Modal>
  );
}
