import { useEffect, useState, type ReactNode } from 'react';
import { Clock, MapPin, MessageCircle, Phone, RefreshCw, Truck } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { money } from '../shared/types';
import { waMeUrl, type PublicMenu, type PublicMenuItem } from '../shared/menu';
import { Badge, ErrorNotice, Spinner } from './ui-basic';
import { cn } from '../lib/utils';

// The public menu page (/m/<slug>). Its own small chunk: no dialog library, no workspace,
// no looping motion, and photos load only when scrolled to. Old phones and WhatsApp's
// in-app browser open it.

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

function ItemCard({ item }: { item: PublicMenuItem }) {
  return (
    <article className="card flex gap-4 p-4">
      <Photo item={item} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-[15px] leading-snug font-semibold text-ink">{item.name}</h3>
          {!item.available && <Badge>Sold out</Badge>}
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
      </div>
    </article>
  );
}

function Banner({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      className="mb-5 rounded-2xl border border-brand-500/20 bg-brand-500/10 px-4 py-3 text-[13px] font-medium text-brand-800"
    >
      {children}
    </p>
  );
}

export function MenuPage({ slug }: { slug: string }) {
  const [menu, setMenu] = useState<PublicMenu>();
  const [failure, setFailure] = useState<{ message: string; missing: boolean }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    api<PublicMenu>(`/public/menu/${slug}`).then(
      (value) => {
        if (!live) return;
        setMenu(value);
        setFailure(undefined);
        document.title = `${value.restaurant.name} menu`;
      },
      (error: Error) => {
        if (live)
          setFailure({
            message: error.message,
            missing: error instanceof ApiError && error.status === 404,
          });
      },
    );
    return () => {
      live = false;
    };
  }, [slug, attempt]);

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
  const whatsapp = ordering.whatsappNumber
    ? waMeUrl(ordering.whatsappNumber, 'Hi! I’d like to order.')
    : undefined;
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
      {ordering.reason === 'bot_off' ? (
        <Banner>Online ordering is paused right now. You can still browse the menu.</Banner>
      ) : ordering.reason === 'closed' ? (
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
                <ItemCard key={item.id} item={item} />
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
              {restaurant.deliveryZones.map((zone) => (
                <li key={zone.name}>
                  {zone.name} · delivery {money(zone.fee)}
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
    </Shell>
  );
}
