import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  MapPin,
  MessageCircle,
  Minus,
  Phone,
  Plus,
  RefreshCw,
  ShoppingBag,
  Truck,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { money, type CartItem } from '../shared/types';
import {
  waMeUrl,
  type MenuSession,
  type PublicMenu,
  type PublicMenuItem,
  type WebCart,
} from '../shared/menu';
import {
  addLine,
  count,
  loadCart,
  loadToken,
  previewQuote,
  saveCart,
  saveToken,
  setQuantity,
} from '../lib/menu-cart';
import { ActionButton, Badge, CustomSelect, ErrorNotice, Field, Spinner } from './ui-basic';
import { cn } from '../lib/utils';

// The public menu page (/m/<slug>). Its own small chunk: no dialog library, no workspace,
// no looping motion, and photos load only when scrolled to. Old phones and WhatsApp's
// in-app browser open it. A personal link (#t=…, sent by the bot) orders in one tap into the
// customer's own chat; otherwise the customer confirms the order from WhatsApp with a code.

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function hoursText({ start, end, days }: PublicMenu['restaurant']['openingHours']) {
  const when =
    days.length === 7
      ? 'Every day'
      : [...days]
          .sort((a, b) => a - b)
          .map((day) => DAYS[day])
          .join(', ') || 'Closed';
  return start === end ? `${when} · open all day` : `${when} · ${start}–${end}`;
}
const LINK_ENDED = 'This link has expired. Send “menu” in WhatsApp to get a fresh one.';
const ENDED_STATES = ['expired', 'used', 'stale', 'invalid'];
interface Placed {
  reference: string;
  total: number;
  alreadyPlaced: boolean;
  whatsappUrl?: string;
}
interface Drafted {
  code: string;
  expiresAt: string;
  whatsappUrl: string;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="canvas-glow min-h-dvh text-ink">
      <main className="mx-auto max-w-2xl px-4 pt-6 pb-32 sm:pt-10">{children}</main>
    </div>
  );
}

function Photo({ item }: { item: PublicMenuItem }) {
  const [broken, setBroken] = useState(false);
  return item.imageUrl && !broken ? (
    <img
      src={item.imageUrl}
      alt=""
      width={88}
      height={88}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className={cn(
        'size-22 shrink-0 rounded-2xl bg-paper object-cover',
        !item.available && 'opacity-60 grayscale',
      )}
      onError={() => setBroken(true)}
    />
  ) : (
    <div
      aria-hidden
      className={cn(
        'flex size-22 shrink-0 items-center justify-center rounded-2xl bg-paper text-[38px]',
        !item.available && 'opacity-60 grayscale',
      )}
    >
      {item.emoji || '🍽️'}
    </div>
  );
}

function Stepper({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
}) {
  return (
    <div className="inline-flex items-center gap-1 rounded-full bg-white/80 p-0.5">
      <button
        type="button"
        className="icon-btn size-8"
        aria-label={`One less ${label}`}
        onClick={() => onChange(value - 1)}
      >
        <Minus className="size-3.5" />
      </button>
      <span
        className="min-w-6 text-center text-[13px] font-semibold tabular-nums"
        aria-live="polite"
      >
        {value}
      </span>
      <button
        type="button"
        className="icon-btn size-8"
        aria-label={`One more ${label}`}
        disabled={value >= 50}
        onClick={() => onChange(value + 1)}
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}

/** Options for one dish, chosen in place: a required option, extras and how many. */
function OptionPicker({
  item,
  onAdd,
}: {
  item: PublicMenuItem;
  onAdd: (line: Omit<CartItem, 'notes'>) => void;
}) {
  const [variantId, setVariantId] = useState(item.variants[0]?.id);
  const [extras, setExtras] = useState<string[]>([]);
  const [quantity, setQuantityValue] = useState(1);
  const unit =
    (item.variants.find((v) => v.id === variantId)?.price ?? item.price) +
    item.modifiers.filter((m) => extras.includes(m.id)).reduce((sum, m) => sum + m.price, 0);
  return (
    <div className="mt-3 space-y-3 rounded-2xl bg-paper p-3">
      {item.variants.length > 0 && (
        <div className="tab-group flex-wrap" role="group" aria-label={`Choose ${item.name}`}>
          {item.variants.map((variant) => (
            <button
              key={variant.id}
              type="button"
              className="tab-btn"
              aria-pressed={variant.id === variantId}
              onClick={() => setVariantId(variant.id)}
            >
              {variant.name} · {money(variant.price)}
            </button>
          ))}
        </div>
      )}
      {item.modifiers.length > 0 && (
        <fieldset className="space-y-1.5">
          <legend className="field-label">Extras</legend>
          {item.modifiers.map((extra) => (
            <label key={extra.id} className="flex items-center gap-2.5 text-[13px] text-stone-700">
              <input
                type="checkbox"
                className="size-4 accent-brand-600"
                checked={extras.includes(extra.id)}
                onChange={(e) =>
                  setExtras((list) =>
                    e.target.checked ? [...list, extra.id] : list.filter((id) => id !== extra.id),
                  )
                }
              />
              <span className="flex-1">{extra.name}</span>
              <span className="tabular-nums text-stone-500">+{money(extra.price)}</span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Stepper
          value={quantity}
          label={item.name}
          onChange={(value) => setQuantityValue(Math.max(1, Math.min(50, value)))}
        />
        <button
          type="button"
          className="btn btn-primary"
          onClick={() =>
            onAdd({
              productId: item.id,
              quantity,
              ...(variantId && { variantId }),
              modifierIds: extras,
            })
          }
        >
          <Plus className="size-4" />
          Add · {money(unit * quantity)}
        </button>
      </div>
    </div>
  );
}

function ItemCard({
  item,
  ordering,
  inCart,
  picking,
  onPick,
  onAdd,
}: {
  item: PublicMenuItem;
  ordering: boolean;
  inCart: number;
  picking: boolean;
  onPick: (open: boolean) => void;
  onAdd: (line: Omit<CartItem, 'notes'>) => void;
}) {
  const options = item.variants.length > 0 || item.modifiers.length > 0;
  return (
    <article className="card p-4">
      <div className="flex gap-4">
        <Photo item={item} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-[15px] leading-snug font-semibold text-ink">{item.name}</h3>
            {!item.available ? (
              <Badge>Sold out</Badge>
            ) : inCart > 0 ? (
              <Badge tone="green">{inCart} in order</Badge>
            ) : null}
          </div>
          {item.description && (
            <p className="mt-1 text-[12.5px] leading-relaxed text-stone-500">{item.description}</p>
          )}
          <p className="mt-2 text-[13.5px] font-semibold tabular-nums text-brand-800">
            {money(item.price)}
          </p>
          {item.variants.length > 0 && (
            <p className="mt-1 text-xs leading-relaxed text-stone-600">
              {item.variants.map((v) => `${v.name} ${money(v.price)}`).join(' · ')}
            </p>
          )}
          {item.modifiers.length > 0 && (
            <p className="mt-1 text-xs leading-relaxed text-stone-500">
              Extras: {item.modifiers.map((m) => `${m.name} +${money(m.price)}`).join(', ')}
            </p>
          )}
          {ordering && item.available && (
            <button
              type="button"
              className="btn mt-3 min-h-9 px-4"
              aria-expanded={options ? picking : undefined}
              onClick={() =>
                options
                  ? onPick(!picking)
                  : onAdd({ productId: item.id, quantity: 1, modifierIds: [] })
              }
            >
              <Plus className="size-4" />
              {options ? (picking ? 'Close' : 'Choose') : 'Add'}
            </button>
          )}
        </div>
      </div>
      {ordering && picking && options && (
        <OptionPicker
          item={item}
          onAdd={(line) => {
            onAdd(line);
            onPick(false);
          }}
        />
      )}
    </article>
  );
}

function Banner({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="mb-5 rounded-2xl border border-brand-500/20 bg-brand-500/10 px-4 py-3 text-[13px] font-medium text-brand-800"
    >
      {children}
    </div>
  );
}

export function MenuPage({ slug }: { slug: string }) {
  const [menu, setMenu] = useState<PublicMenu>();
  const [failure, setFailure] = useState<{ message: string; missing: boolean }>();
  const [attempt, setAttempt] = useState(0);
  const [token, setToken] = useState<string>();
  const [session, setSession] = useState<MenuSession>();
  const [linkNote, setLinkNote] = useState('');
  const [cart, setCart] = useState<CartItem[]>(() => loadCart(slug));
  const [picking, setPicking] = useState<string>();
  const [checkout, setCheckout] = useState(false);
  const [fulfillment, setFulfillment] = useState<WebCart['fulfillment']>('pickup');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [zone, setZone] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [placed, setPlaced] = useState<Placed>();
  const [phone, setPhone] = useState('');
  const [drafted, setDrafted] = useState<Drafted>();
  const placing = useRef(false);

  useEffect(() => {
    let live = true;
    api<PublicMenu>(`/public/menu/${slug}`).then(
      (value) => {
        if (!live) return;
        setMenu(value);
        setFailure(undefined);
        document.title = `${value.restaurant.name} menu`;
        if (value.restaurant.fulfillment === 'delivery') setFulfillment('delivery');
      },
      (e: Error) => {
        if (live)
          setFailure({ message: e.message, missing: e instanceof ApiError && e.status === 404 });
      },
    );
    return () => {
      live = false;
    };
  }, [slug, attempt]);

  // A personal link: keep its token for this tab only, take it out of the address bar (so it
  // is not shared by accident), then ask what it can do.
  useEffect(() => {
    let live = true;
    const fromLink = /(?:^#|&)t=([A-Za-z0-9_-]{20,200})/.exec(window.location.hash)?.[1];
    if (fromLink) {
      saveToken(slug, fromLink);
      try {
        history.replaceState(null, '', window.location.pathname);
      } catch {
        // The address bar keeps the link; the page still works.
      }
    }
    const value = fromLink ?? loadToken(slug);
    if (!value) return;
    setToken(value);
    api<MenuSession>(`/public/menu/${slug}/session`, undefined, { token: value }).then(
      (result) => {
        if (!live) return;
        if (ENDED_STATES.includes(result.state)) {
          // An old link: the page carries on as if it was opened without one.
          saveToken(slug);
          setToken(undefined);
          setLinkNote(
            result.state === 'used' && result.reference
              ? `You already ordered with this link (${result.reference}). Send “menu” in WhatsApp to get a fresh one.`
              : LINK_ENDED,
          );
          return;
        }
        setSession(result);
        if (result.name) setName((current) => current || result.name!);
      },
      () => {
        if (live) setToken(undefined);
      },
    );
    return () => {
      live = false;
    };
  }, [slug]);

  useEffect(() => saveCart(slug, cart), [slug, cart]);

  useEffect(() => {
    const close = () => setCheckout(false);
    window.addEventListener('popstate', close);
    return () => window.removeEventListener('popstate', close);
  }, []);

  if (!menu)
    return (
      <Shell>
        {failure ? (
          <div className="card p-6 text-center">
            <h1 className="panel-title">
              {failure.missing ? 'Menu not found' : 'The menu didn’t load'}
            </h1>
            <p className="mt-2 text-[13.5px] text-stone-500">
              {failure.missing
                ? 'This menu isn’t available right now. Ask the restaurant for a new link.'
                : failure.message}
            </p>
            {!failure.missing && (
              <button className="btn mt-5" onClick={() => setAttempt((n) => n + 1)}>
                <RefreshCw className="size-4" />
                Try again
              </button>
            )}
          </div>
        ) : (
          <p className="flex items-center justify-center gap-2 py-24 text-sm text-stone-500">
            <Spinner />
            Opening the menu…
          </p>
        )}
      </Shell>
    );

  const { restaurant, ordering } = menu;
  const whatsapp =
    session?.whatsappUrl ??
    (ordering.whatsappNumber
      ? waMeUrl(ordering.whatsappNumber, 'Hi! I’d like to order.')
      : undefined);
  // A personal link orders in one tap into its chat. Without one (Instagram, a QR code, or an
  // old link) the customer types their number and confirms from WhatsApp with a code. A link
  // into a chat staff are handling, or a blocked one, only shows the menu.
  const linkReady = session?.state === 'ready' && !!token;
  const viewOnlyLink = !!token && session?.state !== 'ready';
  const mode: 'link' | 'public' | undefined = linkReady
    ? 'link'
    : !token && ordering.publicOrdering
      ? 'public'
      : undefined;
  const canOrder = !!mode && !placed && !drafted && !viewOnlyLink;
  const items = menu.categories.flatMap((category) => category.items);
  const priced = previewQuote(menu, {
    items: cart,
    fulfillment,
    zone: fulfillment === 'delivery' ? zone : undefined,
  });
  const itemsOnly = previewQuote(menu, { items: cart, fulfillment: 'pickup' });
  const quantityOf = (id: string) =>
    cart.filter((line) => line.productId === id).reduce((sum, line) => sum + line.quantity, 0);
  const add = (line: Omit<CartItem, 'notes'>) => {
    setCart((current) => addLine(current, line));
    setNotice('');
  };
  const openCheckout = () => {
    setCheckout(true);
    setError('');
    try {
      history.pushState({ menuCheckout: true }, '');
    } catch {
      // Back then leaves the page instead of the checkout; the Back button still works.
    }
    window.scrollTo(0, 0);
  };
  const closeCheckout = () => {
    if ((history.state as { menuCheckout?: boolean } | null)?.menuCheckout) history.back();
    else setCheckout(false);
  };
  const reloadMenu = () =>
    api<PublicMenu>(`/public/menu/${slug}`, undefined, undefined, undefined, {
      cache: 'no-store',
    }).then(setMenu, () => undefined);
  const linkEnded = (message = LINK_ENDED) => {
    saveToken(slug);
    setToken(undefined);
    setSession(undefined);
    setLinkNote(message);
    setCheckout(false);
  };

  async function placeOrder() {
    if (placing.current) return;
    setError('');
    if (name.trim().length < 2) return setError('Please add your name.');
    if (fulfillment === 'delivery' && !zone) return setError('Please choose your delivery area.');
    if (fulfillment === 'delivery' && address.trim().length < 5)
      return setError('Please add your full delivery address.');
    if (mode === 'public' && phone.replace(/\D/g, '').length < 10)
      return setError('Please enter your WhatsApp number, for example 0300 1234567.');
    if (!priced.quote) return setError(priced.error ?? 'Please check your order.');
    const web: WebCart = {
      items: cart,
      fulfillment,
      customerName: name.trim(),
      ...(fulfillment === 'delivery' && { address: address.trim(), zone }),
    };
    placing.current = true;
    setBusy(true);
    try {
      if (mode === 'public') {
        setDrafted(
          await api<Drafted>(`/public/menu/${slug}/drafts`, undefined, {
            phone: phone.trim(),
            cart: web,
            expectedTotal: priced.quote.total,
          }),
        );
      } else {
        setPlaced(
          await api<Placed>(`/public/menu/${slug}/orders`, undefined, {
            token,
            cart: web,
            expectedTotal: priced.quote.total,
          }),
        );
        saveToken(slug);
      }
      setCart([]);
      setNotice('');
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      if (code === 'price_changed') {
        await reloadMenu();
        setNotice(e instanceof Error ? e.message : '');
      } else if (code && ENDED_STATES.includes(code)) linkEnded();
      else if (mode === 'public' && ['no_whatsapp', 'bot_off', 'closed'].includes(code ?? '')) {
        // Ordering just stopped: the refreshed menu says why.
        await reloadMenu();
        setCheckout(false);
      } else if (
        code === 'staff' ||
        code === 'blocked' ||
        code === 'bot_off' ||
        code === 'closed'
      ) {
        setSession((current) => current && { ...current, state: code });
        setCheckout(false);
      } else
        setError(
          e instanceof ApiError
            ? e.message
            : 'We couldn’t reach the restaurant. Check your connection and try again.',
        );
    } finally {
      placing.current = false;
      setBusy(false);
    }
  }

  if (drafted)
    return (
      <Shell>
        <section className="card p-6 text-center" role="status">
          <MessageCircle className="mx-auto size-10 text-brand-600" />
          <h1 className="panel-title mt-3">
            Almost done! Send your order code from WhatsApp to place it.
          </h1>
          <a
            className="btn btn-primary mt-5 min-h-12 w-full text-[15px]"
            href={drafted.whatsappUrl}
            rel="noopener noreferrer"
          >
            <MessageCircle className="size-5" />
            Confirm on WhatsApp
          </a>
          <p className="mt-5 font-mono text-[26px] font-semibold tracking-[0.12em] text-ink">
            {drafted.code}
          </p>
          <p className="mt-3 text-[13px] leading-relaxed text-stone-500">
            Your order is placed only after you send the message. The code works for 30 minutes.
          </p>
        </section>
      </Shell>
    );

  if (placed)
    return (
      <Shell>
        <section className="card p-6 text-center" role="status">
          <CheckCircle2 className="mx-auto size-10 text-success-700" />
          <h1 className="panel-title mt-3">Order {placed.reference} received!</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-stone-600">
            {placed.alreadyPlaced
              ? 'This order was already sent to the restaurant.'
              : 'We’ve sent the details to your WhatsApp.'}{' '}
            The restaurant will confirm soon.
          </p>
          <p className="mt-1 text-[13px] text-stone-500">
            Total {money(placed.total)} · pay in cash
          </p>
          {(placed.whatsappUrl ?? whatsapp) && (
            <a
              className="btn btn-ink mt-5 w-full"
              href={placed.whatsappUrl ?? whatsapp}
              rel="noopener noreferrer"
            >
              <MessageCircle className="size-4" />
              Open WhatsApp
            </a>
          )}
        </section>
      </Shell>
    );

  if (checkout && canOrder)
    return (
      <Shell>
        <button type="button" className="btn btn-quiet -ml-3 mb-3" onClick={closeCheckout}>
          <ArrowLeft className="size-4" />
          Back to menu
        </button>
        <h1 className="page-title mb-5">Your order</h1>
        {notice && <Banner>{notice}</Banner>}
        <section className="card mb-4 divide-y divide-ink/[0.06] px-4">
          {cart.map((line, index) => {
            const item = items.find((i) => i.id === line.productId);
            const quoted = itemsOnly.quote?.items[index];
            const options = [
              item?.variants.find((v) => v.id === line.variantId)?.name,
              ...line.modifierIds.map((id) => item?.modifiers.find((m) => m.id === id)?.name),
            ].filter(Boolean);
            return (
              <div key={index} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold text-ink">
                    {item?.name ?? 'No longer on the menu'}
                  </p>
                  {options.length > 0 && (
                    <p className="text-xs text-stone-500">{options.join(' · ')}</p>
                  )}
                  {quoted && (
                    <p className="mt-0.5 text-[13px] tabular-nums text-stone-600">
                      {money(quoted.total)}
                    </p>
                  )}
                </div>
                <Stepper
                  value={line.quantity}
                  label={item?.name ?? 'item'}
                  onChange={(value) => setCart((current) => setQuantity(current, index, value))}
                />
              </div>
            );
          })}
          {!cart.length && (
            <p className="py-4 text-[13px] text-stone-500">
              Your order is empty. Add something first.
            </p>
          )}
        </section>
        <section className="card mb-4 space-y-4 p-4">
          {restaurant.fulfillment === 'both' ? (
            <div className="tab-group" role="group" aria-label="Pickup or delivery">
              {(['pickup', 'delivery'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className="tab-btn"
                  aria-pressed={fulfillment === value}
                  onClick={() => setFulfillment(value)}
                >
                  {value === 'pickup' ? 'Pickup' : 'Delivery'}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-[13px] font-medium text-stone-600">
              {restaurant.fulfillment === 'delivery' ? 'Delivery only' : 'Pickup only'}
            </p>
          )}
          <Field label="Your name">
            <input
              className="input"
              autoComplete="name"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {fulfillment === 'delivery' && (
            <>
              <Field label="Delivery area">
                <CustomSelect
                  aria-label="Delivery area"
                  value={zone}
                  onChange={setZone}
                  placeholder="Choose your area"
                  options={restaurant.deliveryZones.map((z) => ({
                    value: z.name,
                    label: `${z.name} · ${money(z.fee)}`,
                  }))}
                />
              </Field>
              <Field label="Delivery address">
                <textarea
                  className="input min-h-20"
                  autoComplete="street-address"
                  maxLength={400}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                />
              </Field>
            </>
          )}
          {mode === 'link' ? (
            <Field label="Your WhatsApp number" hint="We’ll send the order details to this chat.">
              <input
                className="input bg-paper"
                readOnly
                value={session?.phoneMasked ?? 'This WhatsApp chat'}
              />
            </Field>
          ) : (
            <Field
              label="Your WhatsApp number"
              hint="Include your country code if you’re outside Pakistan."
            >
              <input
                className="input"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                maxLength={40}
                placeholder="0300 1234567"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </Field>
          )}
        </section>
        <section className="card mb-4 space-y-1.5 p-4 text-[13.5px]">
          {itemsOnly.quote && (
            <p className="flex justify-between text-stone-600">
              <span>Items</span>
              <span className="tabular-nums">{money(itemsOnly.quote.subtotal)}</span>
            </p>
          )}
          {fulfillment === 'delivery' && priced.quote && (
            <p className="flex justify-between text-stone-600">
              <span>Delivery</span>
              <span className="tabular-nums">{money(priced.quote.deliveryFee)}</span>
            </p>
          )}
          {priced.quote ? (
            <p className="flex justify-between text-[15px] font-semibold text-ink">
              <span>Total</span>
              <span className="tabular-nums">{money(priced.quote.total)}</span>
            </p>
          ) : (
            <p className="text-stone-500">{priced.error}</p>
          )}
          <p className="pt-1 text-xs text-stone-500">
            Pay cash {fulfillment === 'delivery' ? 'on delivery' : 'at pickup'}.
          </p>
        </section>
        {error && (
          <div className="mb-4">
            <ErrorNotice message={error} onDismiss={() => setError('')} />
          </div>
        )}
        <ActionButton
          className="btn-primary w-full"
          loading={busy}
          loadingLabel="Placing your order…"
          disabled={!cart.length}
          onClick={() => void placeOrder()}
        >
          Place order
        </ActionButton>
      </Shell>
    );

  const total = count(cart);
  return (
    <Shell>
      <header className="mb-5">
        <h1 className="page-title">{restaurant.name}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-stone-500">
          <Badge tone={ordering.open ? 'green' : 'neutral'}>
            <span className="size-1.5 rounded-full bg-current" />
            {ordering.open ? 'Open now' : 'Closed now'}
          </Badge>
          <span className="inline-flex items-center gap-1.5">
            <Clock className="size-3.5" />
            {hoursText(restaurant.openingHours)}
          </span>
        </div>
      </header>
      {linkNote && <Banner>{linkNote}</Banner>}
      {canOrder && (
        <p className="mb-5 rounded-2xl bg-white/70 px-4 py-3 text-[13px] text-stone-600">
          {mode === 'link'
            ? `Add dishes, then place your order. We’ll send the details to your WhatsApp chat${session?.phoneMasked ? ` (${session.phoneMasked})` : ''}.`
            : 'Add dishes, then place your order and confirm it from your WhatsApp.'}
        </p>
      )}
      {session?.state === 'staff' ? (
        <Banner>
          Our team is chatting with you on WhatsApp. Continue there to order.
          {whatsapp && (
            <a className="btn btn-ink mt-3 w-full" href={whatsapp} rel="noopener noreferrer">
              <MessageCircle className="size-4" />
              Continue in WhatsApp
            </a>
          )}
        </Banner>
      ) : session?.state === 'blocked' ? (
        <Banner>Ordering isn’t available for this chat.</Banner>
      ) : ordering.reason === 'bot_off' || session?.state === 'bot_off' ? (
        <Banner>Online ordering is paused right now. You can still browse the menu.</Banner>
      ) : ordering.reason === 'closed' || session?.state === 'closed' ? (
        <Banner>We’re closed right now. We open at {restaurant.openingHours.start}.</Banner>
      ) : ordering.reason === 'unavailable' ? (
        <Banner>Ordering isn’t available right now. You can still browse the menu.</Banner>
      ) : null}
      {menu.categories.length > 1 && (
        <nav
          aria-label="Menu sections"
          className="sticky top-0 z-10 -mx-4 mb-5 bg-canvas/95 px-4 py-2"
        >
          <div className="tab-group">
            {menu.categories.map((category, index) => (
              <a key={category.name} className="tab-btn" href={`#section-${index}`}>
                {category.name}
              </a>
            ))}
          </div>
        </nav>
      )}
      {menu.categories.length ? (
        menu.categories.map((category, index) => (
          <section key={category.name} id={`section-${index}`} className="mb-7 scroll-mt-16">
            <h2 className="eyebrow mb-3">{category.name}</h2>
            <div className="grid gap-3">
              {category.items.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  ordering={canOrder}
                  inCart={quantityOf(item.id)}
                  picking={picking === item.id}
                  onPick={(open) => setPicking(open ? item.id : undefined)}
                  onAdd={add}
                />
              ))}
            </div>
          </section>
        ))
      ) : (
        <ErrorNotice message="The menu is empty right now. Please check back soon." />
      )}
      <section className="card mt-8 space-y-3 p-5 text-[13px] text-stone-600">
        <h2 className="panel-title text-[22px]">Visit or order</h2>
        <p className="flex items-start gap-2">
          <Clock className="mt-0.5 size-4 shrink-0 text-brand-600" />
          {hoursText(restaurant.openingHours)}
        </p>
        {restaurant.address && (
          <p className="flex items-start gap-2">
            <MapPin className="mt-0.5 size-4 shrink-0 text-brand-600" />
            {restaurant.address}
          </p>
        )}
        {restaurant.phone && (
          <p className="flex items-start gap-2">
            <Phone className="mt-0.5 size-4 shrink-0 text-brand-600" />
            {restaurant.phone}
          </p>
        )}
        {restaurant.deliveryZones.length > 0 && (
          <div className="flex items-start gap-2">
            <Truck className="mt-0.5 size-4 shrink-0 text-brand-600" />
            <ul className="space-y-0.5">
              {restaurant.deliveryZones.map((z) => (
                <li key={z.name}>
                  {z.name} · delivery {money(z.fee)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {whatsapp && (
          <a className="btn btn-ink mt-2 w-full" href={whatsapp} rel="noopener noreferrer">
            <MessageCircle className="size-4" />
            Order on WhatsApp
          </a>
        )}
      </section>
      <p className="mt-6 text-center text-[11px] text-stone-400">Menu by Orderly</p>
      {canOrder && total > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 px-4 pb-4">
          <button
            type="button"
            className="btn btn-primary mx-auto flex w-full max-w-2xl justify-between"
            onClick={openCheckout}
          >
            <span className="inline-flex items-center gap-2">
              <ShoppingBag className="size-4" />
              View order ({total})
            </span>
            {itemsOnly.quote && (
              <span className="tabular-nums">{money(itemsOnly.quote.subtotal)}</span>
            )}
          </button>
        </div>
      )}
    </Shell>
  );
}
