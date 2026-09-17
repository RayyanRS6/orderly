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
import type { PageResult, Message } from '../shared/types';
import { quoteCart } from '../domain/engine';
import { useWorkspace } from '../lib/workspace';
import { cn, label } from '../lib/utils';
import { Badge, CustomSelect, Empty, ErrorNotice, Field, Modal, PageHeading, Status } from './ui';

function Messages({ conversation, waiting }: { conversation?: Conversation; waiting?: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (conversation?.messages?.length || waiting)
      end.current?.scrollIntoView({ block: 'nearest' });
  }, [conversation?.messages?.length, waiting]);
  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto bg-canvas/50 p-5 sm:p-6">
      {!conversation?.messages?.length && (
        <div className="py-2 text-center sm:py-8">
          <div className="mx-auto mb-4 hidden size-14 items-center justify-center rounded-xl bg-ink text-brand-500 sm:flex">
            <MessageCircle className="size-7" />
          </div>
          <h3 className="panel-title">Every good order starts with a hello.</h3>
          <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-stone-500">
            Ask for the menu, build a cart, and see how your restaurant responds.
          </p>
        </div>
      )}
      {conversation?.messages?.map((message) => (
        <div
          key={message.id}
          className={cn(
            'flex gap-2.5',
            message.role === 'customer' ? 'justify-end' : 'justify-start',
          )}
        >
          {message.role !== 'customer' && (
            <span className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-lg bg-ink-soft text-brand-500">
              {message.role === 'staff' ? (
                <UserRound className="size-3.5" />
              ) : (
                <Bot className="size-3.5" />
              )}
            </span>
          )}
          <div
            className={cn(
              'max-w-[85%] rounded-xl px-4 py-3 text-[13px] leading-relaxed',
              message.role === 'customer'
                ? 'rounded-tr-sm bg-ink text-cream'
                : 'rounded-tl-sm border border-white bg-white/80 text-stone-700',
            )}
          >
            <p dir="auto" className="whitespace-pre-wrap break-words">
              {message.text}
            </p>
            <p
              className={cn(
                'mt-2 text-right text-[10px]',
                message.role === 'customer' ? 'text-cream/50' : 'text-stone-400',
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
          </div>
        </div>
      ))}
      {waiting && (
        <div
          role="status"
          className="w-fit rounded-xl rounded-tl-sm border border-white bg-white/80 px-4 py-3 text-[13px] text-stone-500"
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
  const [zone, setZone] = useState(data.company.deliveryZones?.[0]?.name || '');
  const conversation = latest;
  const [useLiveModel, setUseLiveModel] = useState(false);
  const [useDraft, setUseDraft] = useState(true);
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
        useLiveModel,
        useDraft,
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
          className="btn"
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
      <div className="notice mb-4 flex flex-wrap gap-x-6 gap-y-4 p-4 text-[13px] text-cream">
        <label className="flex cursor-pointer items-center gap-2.5">
          <input
            className="toggle"
            type="checkbox"
            checked={useDraft}
            onChange={(e) => {
              setUseDraft(e.target.checked);
              setId(undefined);
              setLatest(undefined);
            }}
          />
          Use saved draft
        </label>
        <label className="flex cursor-pointer items-center gap-2.5">
          <input
            className="toggle"
            type="checkbox"
            checked={useLiveModel}
            onChange={(e) => setUseLiveModel(e.target.checked)}
            disabled={data.company.ai?.provider === 'mock'}
          />
          Use selected AI model (API charges apply)
        </label>
        <span className="w-full text-xs text-cream/50">
          Sandbox only: no WhatsApp sends or Sheet writes. Use fictional details.
          <span className="hidden sm:inline">
            {' '}
            Free local rules test structured buttons; enable AI to test natural language, goal and
            instructions.
          </span>
        </span>
      </div>
      <div className="grid gap-5 xl:grid-cols-3">
        <div className="card flex h-[calc(100dvh-29rem)] min-h-[20rem] max-h-[44rem] flex-col overflow-hidden sm:h-[calc(100dvh-23rem)] xl:col-span-2">
          <div className="flex items-center justify-between gap-3 border-b border-ink/[0.06] px-5 sm:px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-[10px] bg-ink text-brand-500">
                <MessageCircle className="size-5" />
              </div>
              <div>
                <p className="text-[14.5px] font-semibold text-ink">{data.company.name}</p>
                <p className="mt-0.5 text-xs text-stone-400">
                  Preview conversation · no WhatsApp delivery
                </p>
              </div>
            </div>
            <Badge tone="green">{useLiveModel ? data.company.ai?.model : 'Local rules'}</Badge>
          </div>
          <Messages conversation={conversation} waiting={busy} />
          {conversation?.mode === 'human' && (
            <div className="border-t border-white/[0.06] bg-ink px-5 py-3 text-xs text-cream/75 font-medium">
              This conversation is waiting for staff.{' '}
              <button
                className="font-semibold text-brand-500 hover:text-brand-400 ml-1"
                onClick={() => navigate('inbox')}
              >
                Open inbox
              </button>
            </div>
          )}
          <div className="border-t border-ink/[0.06] p-4 sm:p-5">
            <div className="mb-3 flex flex-wrap gap-2">
              {[
                ['Show menu', { type: 'menu' }],
                ['Review order', { type: 'review' }],
                ['Talk to staff', { type: 'handoff' }],
              ].map(([title, action]) => (
                <button
                  key={String(title)}
                  className="rounded-[9px] border border-ink/8 bg-white/70 hover:bg-white hover:border-ink/14 px-3.5 py-1.5 text-xs font-semibold text-stone-700 hover:text-ink transition-all disabled:opacity-50"
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
                className="input pl-4 pr-4"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Type a message… or try ‘2 biryani’"
                maxLength={2000}
                autoComplete="off"
              />
              <button
                className="btn btn-primary px-4"
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
              <h2 className="panel-title flex items-center gap-2">
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
            <div className="mt-4 border-t border-ink/[0.06] pt-4">
              <div className="flex justify-between text-sm">
                <span className="text-stone-500">
                  Total {fulfillment === 'delivery' ? 'with delivery' : ''}
                </span>
                <strong className="tabular-nums text-ink">
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
                <div className="mt-4 rounded-xl border border-success-700/15 bg-success-700/[0.07] p-4 text-[13px] text-success-800">
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
                    className="btn mt-4 w-full"
                    disabled={busy || !conversation?.cart.items.length}
                    onClick={() => setDetails(true)}
                  >
                    Add order details
                    <ChevronRight className="size-4" />
                  </button>
                  {conversation?.cart.status === 'awaiting_confirmation' && (
                    <button
                      className="btn btn-primary mt-2 w-full"
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
            <div className="border-b border-ink/[0.06] p-5">
              <h2 className="panel-title">On the menu</h2>
              <p className="mt-1 text-xs text-stone-500">
                Choose an item to add it to the conversation.
              </p>
            </div>
            <div className="max-h-80 overflow-y-auto">
              {data.products.map((product) => (
                <button
                  key={product.id}
                  className="flex w-full items-center gap-3 border-b border-ink/[0.05] p-4 text-left hover:bg-white/50 disabled:opacity-40"
                  disabled={!product.available || busy || conversation?.cart.status === 'submitted'}
                  onClick={() => setSelected(product)}
                >
                  <span className="flex size-10 items-center justify-center rounded-[10px] bg-ink/5 text-2xl">
                    {product.emoji}
                  </span>
                  <span className="flex-1">
                    <span className="block text-[13px] font-semibold text-ink">{product.name}</span>
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
            if (fulfillment === 'delivery' && (!zone.trim() || !address.trim())) {
              return;
            }
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
          <button className="btn btn-primary w-full" disabled={busy}>
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
            className="input"
            placeholder="For example, less spicy"
            value={notes}
            maxLength={300}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        <button className="btn btn-primary w-full" disabled={busy}>
          <Plus className="size-4" />
          Add to order
        </button>
      </form>
    </Modal>
  );
}
