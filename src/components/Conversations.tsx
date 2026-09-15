import { useEffect, useRef, useState } from 'react';
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
import { quoteCart } from '../domain/engine';
import { useWorkspace } from '../lib/workspace';
import { cn, label } from '../lib/utils';
import { Badge, CustomSelect, Empty, ErrorNotice, Field, Modal, PageHeading, Status } from './ui';

function Messages({ conversation, waiting }: { conversation?: Conversation; waiting?: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [conversation?.messages.length, waiting]);
  return (
    <div className="min-h-72 flex-1 space-y-5 overflow-y-auto bg-stone-50/60 p-5 sm:p-6">
      {!conversation?.messages.length && (
        <div className="py-14 text-center">
          <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl border border-emerald-100 bg-emerald-50 text-emerald-800">
            <MessageCircle className="size-7" />
          </div>
          <h3 className="text-lg font-semibold">Every good order starts with a hello.</h3>
          <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-stone-500">
            Ask for the menu, build a cart, and see how your restaurant responds.
          </p>
        </div>
      )}
      {conversation?.messages.map((message) => (
        <div
          key={message.id}
          className={cn(
            'flex gap-2.5',
            message.role === 'customer' ? 'justify-end' : 'justify-start',
          )}
        >
          {message.role !== 'customer' && (
            <span className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-white text-emerald-800 shadow-xs">
              {message.role === 'staff' ? (
                <UserRound className="size-3.5" />
              ) : (
                <Bot className="size-3.5" />
              )}
            </span>
          )}
          <div
            className={cn(
              'max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed',
              message.role === 'customer'
                ? 'rounded-tr-sm bg-emerald-800 text-white'
                : 'rounded-tl-sm border border-stone-200 bg-white text-stone-700',
            )}
          >
            <p dir="auto" className="whitespace-pre-wrap break-words">
              {message.text}
            </p>
            <p
              className={cn(
                'mt-2 text-right text-[10px]',
                message.role === 'customer' ? 'text-emerald-200' : 'text-stone-400',
              )}
            >
              {message.role === 'staff' ? 'Staff · ' : ''}
              {new Date(message.createdAt).toLocaleTimeString('en-PK', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
          </div>
        </div>
      ))}
      {waiting && (
        <div
          role="status"
          className="w-fit rounded-2xl rounded-tl-sm border border-stone-200 bg-white px-4 py-3 text-sm text-stone-500"
        >
          Preparing a response…
        </div>
      )}
      <div ref={end} />
    </div>
  );
}

export function Playground() {
  const { data, mutate, busy, navigate } = useWorkspace();
  const [id, setId] = useState<string>();
  const [latest, setLatest] = useState<Conversation>();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Product>();
  const [name, setName] = useState('');
  const [fulfillment, setFulfillment] = useState<'pickup' | 'delivery'>('pickup');
  const [address, setAddress] = useState('');
  const [zone, setZone] = useState(data.company.deliveryZones[0]?.name || '');
  const conversation = data.conversations.find((c) => c.id === id) ?? latest;
  const [details, setDetails] = useState(false);
  async function send(message: string, action?: BotAction) {
    if (busy) return false;
    setError('');
    try {
      const result = await mutate<TurnResult>('/chat', {
        conversationId: id,
        text: message,
        messageId: crypto.randomUUID(),
        action,
      });
      setId(result.conversation.id);
      setLatest(result.conversation);
      setText('');
      return true;
    } catch (reason) {
      setError((reason as Error).message);
      return false;
    }
  }
  let total: number | undefined;
  try {
    if (conversation?.cart.items.length)
      total = quoteCart(data.company, data.products, conversation.cart).total;
  } catch {
    /* The authoritative review will explain unavailable options. */
  }
  return (
    <>
      <PageHeading
        title="Test your bot"
        description="Try the complete ordering experience before connecting your number."
      >
        <button
          className="btn rounded-full shadow-xs"
          disabled={busy}
          onClick={() => {
            setId(undefined);
            setLatest(undefined);
            setError('');
          }}
        >
          <RotateCcw className="size-4" />
          New conversation
        </button>
      </PageHeading>
      <div className="grid gap-5 xl:grid-cols-3">
        <div className="card flex h-[44rem] min-h-0 flex-col overflow-hidden xl:col-span-2 rounded-3xl border border-stone-200/80 shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b border-stone-100 bg-white px-5 sm:px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-800 shadow-2xs">
                <MessageCircle className="size-5" />
              </div>
              <div>
                <p className="text-sm font-bold text-stone-900">{data.company.name}</p>
                <p className="mt-0.5 text-xs text-stone-400">
                  Preview conversation · no WhatsApp delivery
                </p>
              </div>
            </div>
            <Badge tone="green">
              {data.company.ai.provider === 'mock' ? 'Demo bot' : label(data.company.ai.provider)}
            </Badge>
          </div>
          <Messages conversation={conversation} waiting={busy} />
          {conversation?.mode === 'human' && (
            <div className="border-t border-amber-200/80 bg-amber-50 px-5 py-3 text-xs text-amber-900 font-medium">
              This conversation is waiting for staff.{' '}
              <button className="font-bold underline ml-1" onClick={() => navigate('inbox')}>
                Open inbox
              </button>
            </div>
          )}
          <div className="border-t border-stone-100 bg-white p-4 sm:p-5">
            <div className="mb-3 flex flex-wrap gap-2">
              {[
                ['Show menu', { type: 'menu' }],
                ['Review order', { type: 'review' }],
                ['Talk to staff', { type: 'handoff' }],
              ].map(([title, action]) => (
                <button
                  key={String(title)}
                  className="rounded-full border border-stone-200/90 bg-stone-50/80 hover:bg-stone-100 hover:border-stone-300 px-3.5 py-1.5 text-xs font-semibold text-stone-700 shadow-2xs transition-all disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void send(String(title), action as BotAction)}
                >
                  {String(title)}
                </button>
              ))}
            </div>
            <ErrorNotice message={error} />
            <form
              className="mt-2 flex gap-2"
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
                className="input rounded-full pl-4 pr-4 py-2 bg-stone-50/80 focus:bg-white"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Type a message… or try ‘2 biryani’"
                maxLength={2000}
                autoComplete="off"
              />
              <button
                className="btn btn-primary rounded-full px-4 shadow-xs"
                aria-label="Send message"
                disabled={busy || !text.trim()}
              >
                <Send className="size-4" />
              </button>
            </form>
            <p className="mt-2 text-center text-[10px] font-medium text-stone-400">
              English · اردو · Roman Urdu
            </p>
          </div>
        </div>
        <div className="space-y-5">
          <section className="card p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <ShoppingBag className="size-4" />
                Current order
              </h2>
              <span className="text-xs tabular-nums text-stone-400">
                {conversation?.cart.items.reduce((n, i) => n + i.quantity, 0) || 0} items
              </span>
            </div>
            {!conversation?.cart.items.length ? (
              <p className="py-5 text-center text-sm text-stone-400">
                Your cart is waiting for something good.
              </p>
            ) : (
              <div className="space-y-3">
                {conversation.cart.items.map((item, i) => {
                  const product = data.products.find((p) => p.id === item.productId);
                  return (
                    <div key={`${item.productId}-${i}`} className="flex items-start gap-3">
                      <span className="text-xl">{product?.emoji || '🍽️'}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">
                          {item.quantity} × {product?.name || 'Unavailable item'}
                        </p>
                        <p className="mt-1 text-xs text-stone-500">
                          {product?.variants.find((v) => v.id === item.variantId)?.name}
                          {item.modifierIds.length ? ` · ${item.modifierIds.length} extras` : ''}
                        </p>
                      </div>
                      {conversation.cart.status !== 'submitted' && (
                        <button
                          className="text-stone-400 hover:text-red-600"
                          aria-label={`Remove ${product?.name}`}
                          disabled={busy}
                          onClick={() =>
                            void send(`Remove ${product?.name}`, {
                              type: 'remove_item',
                              productId: item.productId,
                            })
                          }
                        >
                          <X className="size-4" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="mt-4 border-t border-stone-100 pt-4">
              <div className="flex justify-between text-sm">
                <span className="text-stone-500">
                  Total {fulfillment === 'delivery' ? 'with delivery' : ''}
                </span>
                <strong className="tabular-nums">{total !== undefined ? money(total) : '—'}</strong>
              </div>
              {conversation?.cart.customerName && (
                <p className="mt-3 text-xs text-stone-500">
                  {conversation.cart.customerName} ·{' '}
                  {label(conversation.cart.fulfillment || 'pickup')}
                </p>
              )}
              {conversation?.cart.status === 'submitted' ? (
                <div className="mt-4 rounded-2xl border border-emerald-200/80 bg-emerald-50/80 p-4 text-sm text-emerald-800">
                  <Check className="mb-1 size-4" />
                  Order received. Waiting for the restaurant.
                  <button
                    className="mt-2 block font-semibold underline"
                    onClick={() => navigate('orders')}
                  >
                    View orders
                  </button>
                </div>
              ) : (
                <>
                  <button
                    className="btn rounded-full mt-4 w-full shadow-xs"
                    disabled={busy || !conversation?.cart.items.length}
                    onClick={() => setDetails(true)}
                  >
                    Add order details
                    <ChevronRight className="size-4" />
                  </button>
                  {conversation?.cart.status === 'awaiting_confirmation' && (
                    <button
                      className="btn btn-primary rounded-full mt-2 w-full shadow-xs"
                      disabled={busy}
                      onClick={() =>
                        void send('Confirm order', {
                          type: 'confirm',
                          revision: conversation.cart.reviewedRevision,
                        })
                      }
                    >
                      <Check className="size-4" />
                      Confirm order
                    </button>
                  )}
                </>
              )}
            </div>
          </section>
          <section className="card overflow-hidden">
            <div className="border-b border-stone-100 p-5">
              <h2 className="text-sm font-semibold">On the menu</h2>
              <p className="mt-1 text-xs text-stone-500">
                Choose an item to add it to the conversation.
              </p>
            </div>
            <div className="max-h-80 overflow-y-auto">
              {data.products.map((product) => (
                <button
                  key={product.id}
                  className="flex w-full items-center gap-3 border-b border-stone-100 p-4 text-left hover:bg-stone-50 disabled:opacity-40"
                  disabled={!product.available || busy || conversation?.cart.status === 'submitted'}
                  onClick={() => setSelected(product)}
                >
                  <span className="flex size-10 items-center justify-center rounded-2xl bg-stone-100 text-2xl shadow-2xs">
                    {product.emoji}
                  </span>
                  <span className="flex-1">
                    <span className="block text-sm font-medium">{product.name}</span>
                    <span className="mt-1 block text-xs tabular-nums text-stone-500">
                      {product.variants.length ? 'From ' : ''}
                      {money(product.price)}
                    </span>
                  </span>
                  <Plus className="size-4 text-stone-400" />
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
            const saved = await send('Here are my order details', {
              type: 'set_details',
              customerName: name,
              fulfillment,
              ...(fulfillment === 'delivery' ? { address, zone } : {}),
            });
            if (saved) setDetails(false);
          }}
        >
          <Field label="Customer name">
            <input
              className="input rounded-xl"
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
                  value={zone}
                  onChange={(val) => setZone(val)}
                  options={[
                    { value: '', label: 'Select an area' },
                    ...data.company.deliveryZones.map((z) => ({
                      value: z.name,
                      label: `${z.name} · ${money(z.fee)}`,
                    })),
                  ]}
                />
              </Field>
              <Field label="Complete address">
                <textarea
                  className="input rounded-xl"
                  value={address}
                  required
                  onChange={(e) => setAddress(e.target.value)}
                />
              </Field>
            </>
          )}
          <button className="btn btn-primary rounded-full w-full shadow-xs" disabled={busy}>
            Save details
          </button>
        </form>
      </Modal>
      {selected && (
        <AddItem
          product={selected}
          busy={busy}
          close={() => setSelected(undefined)}
          add={async (action) => {
            if (await send(`Add ${selected.name}`, action)) setSelected(undefined);
          }}
        />
      )}
    </>
  );
}
function AddItem({
  product,
  busy,
  close,
  add,
}: {
  product: Product;
  busy: boolean;
  close: () => void;
  add: (action: BotAction) => Promise<void>;
}) {
  const [quantity, setQuantity] = useState(1);
  const [variant, setVariant] = useState(product.variants[0]?.id || '');
  const [extras, setExtras] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={product.name}
      description={product.description}
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
            modifierIds: extras,
            notes,
          });
        }}
      >
        <Field label="Quantity">
          <input
            className="input rounded-xl"
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
        {product.modifiers.length > 0 && (
          <fieldset>
            <legend className="field-label">Extras</legend>
            {product.modifiers.map((m) => (
              <label className="my-2 flex items-center justify-between text-sm" key={m.id}>
                <span className="flex gap-2">
                  <input
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
                <span className="text-stone-500 font-medium">+ {money(m.price)}</span>
              </label>
            ))}
          </fieldset>
        )}
        <Field label="Special instructions">
          <input
            className="input rounded-xl"
            placeholder="For example, less spicy"
            value={notes}
            maxLength={300}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        <button className="btn btn-primary rounded-full w-full shadow-xs" disabled={busy}>
          <Plus className="size-4" />
          Add to order
        </button>
      </form>
    </Modal>
  );
}

export function Inbox() {
  const { data, mutate, busy, navigate } = useWorkspace();
  const [id, setId] = useState(data.conversations[0]?.id);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const conversation = data.conversations.find((c) => c.id === id);
  async function act(path: string, body: unknown) {
    setError('');
    try {
      await mutate(path, body);
      return true;
    } catch (reason) {
      setError((reason as Error).message);
      return false;
    }
  }
  return (
    <>
      <PageHeading
        title="Inbox"
        description="Every conversation, with a person ready when it matters."
      >
        <Badge tone="neutral">{data.conversations.length} conversations</Badge>
      </PageHeading>
      <div className="card grid min-h-[38rem] overflow-hidden rounded-3xl border border-stone-200/80 shadow-xs md:grid-cols-3">
        <div className="max-h-[42rem] overflow-y-auto border-b border-stone-200/80 md:border-b-0 md:border-r">
          <div className="border-b border-stone-100 px-5 py-4 text-[11px] font-bold tracking-wider text-stone-500 uppercase">
            RECENT CONVERSATIONS
          </div>
          {!data.conversations.length ? (
            <Empty
              title="Your inbox is ready"
              description="Start a test conversation to see it here."
              action="Test your bot"
              onAction={() => navigate('playground')}
            />
          ) : (
            data.conversations.map((c) => (
              <button
                key={c.id}
                className={cn(
                  'w-full border-b border-stone-100/80 px-5 py-4 text-left transition-colors hover:bg-stone-50/80',
                  c.id === id && 'bg-emerald-50/70 border-l-4 border-l-emerald-700',
                )}
                onClick={() => {
                  setId(c.id);
                  setText('');
                  setError('');
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-bold text-stone-900">
                    {c.customerName || 'Guest'}
                  </span>
                  {c.mode === 'human' && <Badge tone="amber">Needs you</Badge>}
                </div>
                <p className="mt-1.5 truncate text-xs text-stone-500">
                  {c.messages.at(-1)?.text || 'New conversation'}
                </p>
                <div className="mt-2.5 flex items-center gap-2 text-[11px] text-stone-400 font-medium">
                  <MessageCircle className="size-3 text-emerald-600" />
                  {c.channel === 'demo' ? 'Test conversation' : 'WhatsApp'}
                  <span>·</span>
                  {label(c.language)}
                </div>
              </button>
            ))
          )}
        </div>
        <div className="flex h-[42rem] min-h-0 flex-col md:col-span-2">
          {conversation ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-100 bg-white px-5 sm:px-6 py-4">
                <div>
                  <p className="font-bold text-stone-900">{conversation.customerName}</p>
                  <p className="mt-0.5 text-xs text-stone-400">{conversation.customerPhone}</p>
                </div>
                <button
                  className="btn rounded-full shadow-xs"
                  disabled={busy}
                  onClick={() =>
                    void act(`/conversations/${conversation.id}/mode`, {
                      mode: conversation.mode === 'bot' ? 'human' : 'bot',
                    })
                  }
                >
                  {conversation.mode === 'bot' ? (
                    <UserRound className="size-4" />
                  ) : (
                    <Bot className="size-4" />
                  )}
                  {conversation.mode === 'bot' ? 'Take over' : 'Resume bot'}
                </button>
              </div>
              <Messages conversation={conversation} />
              <div className="border-t border-stone-100 bg-white p-4 sm:p-5">
                <ErrorNotice message={error} />
                <form
                  className="flex gap-2"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!text.trim()) return;
                    if (await act(`/conversations/${conversation.id}/reply`, { text })) setText('');
                  }}
                >
                  <label className="sr-only" htmlFor="staff-reply">
                    Reply as restaurant staff
                  </label>
                  <input
                    id="staff-reply"
                    className="input rounded-full pl-4 pr-4 py-2 bg-stone-50/80 focus:bg-white"
                    placeholder="Reply as restaurant staff…"
                    value={text}
                    maxLength={2000}
                    onChange={(e) => setText(e.target.value)}
                  />
                  <button
                    className="btn btn-primary rounded-full px-4 shadow-xs"
                    aria-label="Send staff reply"
                    disabled={busy || !text.trim()}
                  >
                    <Send className="size-4" />
                  </button>
                </form>
                <p className="mt-2 text-xs text-stone-400">
                  Sending a staff reply pauses the bot for this conversation.
                </p>
              </div>
            </>
          ) : (
            <Empty
              title="Choose a conversation"
              description="Select a customer on the left to read and reply."
            />
          )}
        </div>
      </div>
    </>
  );
}
