import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronRight,
  Clock3,
  MessageCircle,
  MoreHorizontal,
  Search,
  ShoppingBag,
  Sparkles,
  Wallet,
  X,
} from 'lucide-react';
import type { Bootstrap, Order, OrderStatus, PageResult, Trace } from '../shared/types';
import { money } from '../shared/types';
import { api } from '../lib/api';
import { ordersCsv, UTF8_BOM } from '../lib/orders-csv';
import { paymentMethodsOf, staffPaymentNote, staffTransferNote } from '../lib/payments';
import { newestEvent } from '../lib/polling';
import { useAction, useWorkspace } from '../lib/workspace';
import { cn, initials, label, shortDate } from '../lib/utils';
import {
  ActionButton,
  Badge,
  ConfirmDialog,
  Empty,
  ErrorNotice,
  Field,
  CustomSelect,
  Modal,
  PageHeading,
  ReadinessLink,
  Status,
} from './ui';

export function Overview() {
  const { data, navigate } = useWorkspace();
  const [selected, setSelected] = useState<Order | null>(null);
  const [days, setDays] = useState(7);
  const orders = data.orders || [];
  const traces = data.traces || [];
  const integrations = data.integrations || [];
  const products = data.products || [];
  const pending = orders.filter((o) => o.status === 'pending');
  const valid = orders.filter((o) => !['cancelled', 'rejected'].includes(o.status));
  const total = data.summary?.value ?? valid.reduce((sum, o) => sum + o.total, 0);
  const activity = traces
    .slice()
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, 4);
  const daysData = Array.from({ length: days }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (days - 1 - index));
    let key: string;
    try {
      key = date.toLocaleDateString('en-CA', { timeZone: data.company.timezone });
    } catch {
      key = date.toISOString().slice(0, 10);
    }
    return {
      date,
      count:
        // The server counts each day in the restaurant's time zone too, so look it up by `key`.
        data.summary?.daily.find((d) => d.date === key)?.count ??
        orders.filter((o) => {
          if (!o.createdAt) return false;
          try {
            return (
              new Date(o.createdAt).toLocaleDateString('en-CA', {
                timeZone: data.company.timezone,
              }) === key
            );
          } catch {
            return typeof o.createdAt === 'string' && o.createdAt.slice(0, 10) === key;
          }
        }).length,
    };
  });
  const maxCount = Math.max(1, ...daysData.map((day) => day.count));
  const periodTotal = daysData.reduce((sum, day) => sum + day.count, 0);
  const whatsapp = integrations.find((i) => i.kind === 'whatsapp');
  // Same answer as Launch readiness: a number that is connected but not yet verified isn't done.
  const whatsappDone =
    data.readiness?.find((c) => c.id === 'whatsapp')?.ready ?? whatsapp?.status === 'connected';
  const setupDone =
    Number(products.length > 0) +
    Number(whatsappDone) +
    Number(integrations.some((i) => i.kind === 'sheets' && i.status === 'connected'));
  return (
    <>
      <PageHeading
        title="A little less busy. A lot more orderly."
        description={`Here's what's happening at ${data.company.name}.`}
      >
        <button className="btn" onClick={() => navigate('playground')}>
          <MessageCircle className="size-4 text-brand-500" />
          Test your bot
          <ArrowUpRight className="size-4 text-stone-400" />
        </button>
      </PageHeading>
      {data.readiness && (
        <section className="card mb-5 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="panel-title">
              Launch readiness · {data.readiness.filter((c) => c.ready).length}/
              {data.readiness.length}
            </h2>
            <button className="btn" onClick={() => navigate('flow')}>
              Review setup
            </button>
          </div>
          <ul className="stagger mt-4 grid gap-2 text-[13px] text-stone-700 sm:grid-cols-2">
            {data.readiness.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-2.5 rounded-2xl bg-white/60 px-3 py-2 ring-1 ring-ink/[0.04]"
              >
                <span
                  role="img"
                  aria-label={c.ready ? 'Complete' : 'Required'}
                  className={cn(
                    'inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] leading-none font-bold',
                    c.ready
                      ? 'pop-in bg-success-700 text-white [--d:260ms]'
                      : 'bg-sun/35 text-stone-700',
                  )}
                >
                  {c.ready ? '✓' : '○'}
                </span>{' '}
                {c.label}
                <ReadinessLink check={c} />
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-stone-500">
            {data.summary?.needsStaff ?? 0}{' '}
            {data.summary?.needsStaff === 1 ? 'conversation needs' : 'conversations need'} staff.{' '}
            <button
              className="font-semibold text-brand-700 underline-offset-4 transition-colors hover:text-brand-800 hover:underline"
              onClick={() => navigate('inbox')}
            >
              Open inbox
            </button>
          </p>
        </section>
      )}
      <section className="glow-dark mb-8 grid grid-cols-1 overflow-hidden rounded-[26px] border border-white/[0.06] bg-ink text-cream shadow-[0_40px_80px_-44px_rgb(14_6_4/0.75),0_24px_60px_-40px_rgb(255_105_44/0.35)] md:grid-cols-5">
        <div className="p-6 sm:p-9 md:col-span-3">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] py-1.5 pr-3.5 pl-3 text-[11px] font-semibold tracking-[0.14em] text-cream/80 uppercase">
            <span
              className={cn(
                'size-2 shrink-0 rounded-full',
                data.company.botEnabled ? 'live-dot bg-current text-success-500' : 'bg-sun',
              )}
            />
            {data.company.botEnabled ? 'AUTOMATION ENABLED' : 'AUTOMATION PAUSED'}
          </div>
          <h2 className="max-w-lg font-serif text-[34px] leading-[1.02] font-normal tracking-[-0.01em] text-brand-400 first-line:text-cream sm:text-[46px]">
            Good conversations.
            <br />
            Great orders.
          </h2>
          <p className="mt-4 max-w-md text-[14px] leading-relaxed text-cream/65">
            Let your bot take care of the menu and the details, while you take care of the food.
          </p>
          <button className="btn btn-primary mt-7" onClick={() => navigate('playground')}>
            See your bot in action
            <ArrowRight className="size-4" />
          </button>
        </div>
        <div className="flex items-center justify-center p-6 pt-0 md:col-span-2 md:py-9 md:pr-9">
          <div className="glass-dark enter-rise w-full max-w-sm rounded-[20px] p-4 [--d:120ms] sm:p-5 md:rotate-1">
            <div className="flex items-center gap-3 border-b border-white/10 pb-3.5">
              <div className="flex size-9 -rotate-6 items-center justify-center rounded-xl bg-brand-500 text-ink shadow-[0_10px_18px_-8px_rgb(255_105_44/0.8)]">
                <MessageCircle className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14.5px] font-semibold text-cream">
                  {data.company.name}
                </p>
                <p className="mt-0.5 text-xs text-cream/55">Customer conversation preview</p>
              </div>
            </div>
            <div className="bubble-brand bubble-in-right mt-4 ml-auto w-fit max-w-[85%] px-3.5 py-2 text-xs font-medium [--d:500ms]">
              Hi! Can I see your menu?
            </div>
            <div className="bubble-them bubble-in-left mt-2.5 w-fit max-w-[85%] px-3.5 py-2 text-xs font-medium [--d:1000ms]">
              Of course. Something delicious awaits. 🍽️
            </div>
            <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/10 pt-3 text-[11px] text-cream/55">
              <span>Available in English, Urdu & Roman Urdu</span>
              <CheckCheck className="pop-spin size-4 shrink-0 text-brand-400 [--d:1400ms]" />
            </div>
          </div>
        </div>
      </section>
      <section
        className="stagger mb-8 grid gap-4 [--d:200ms] sm:grid-cols-2 xl:grid-cols-4 [&>:nth-child(2)]:[--d:240ms] [&>:nth-child(3)]:[--d:280ms] [&>:nth-child(4)]:[--d:320ms]"
        aria-label="Workspace metrics"
      >
        {[
          {
            label: 'Total orders',
            value: (data.summary?.orders ?? data.orders.length).toLocaleString(),
            sub: 'All orders in this workspace',
            icon: ShoppingBag,
          },
          {
            label: 'Order value',
            value: money(total),
            sub: 'Excludes rejected & cancelled',
            icon: Wallet,
          },
          {
            label: 'Conversations',
            value: (data.summary?.conversations ?? data.conversations.length).toLocaleString(),
            sub: `${data.summary ? data.summary.conversations - data.summary.needsStaff : data.conversations.filter((c) => c.mode === 'bot').length} currently handled by your bot`,
            icon: MessageCircle,
          },
          {
            label: 'Awaiting acceptance',
            value: (data.summary?.pending ?? pending.length).toLocaleString(),
            sub: pending.length ? 'Ready for your attention' : 'You’re all caught up',
            icon: Clock3,
          },
        ].map((metric) => (
          <div key={metric.label} className="card group p-5">
            <div className="flex items-start justify-between gap-3">
              <p className="pt-1 text-[12.5px] font-semibold text-stone-500">{metric.label}</p>
              <div
                className={cn(
                  'flex size-9 shrink-0 -rotate-6 items-center justify-center rounded-xl shadow-[inset_0_1px_0_rgb(255_255_255/0.3),0_8px_14px_-8px_rgb(14_6_4/0.5)] transition-transform duration-500 ease-[var(--ease-spring)] group-hover:rotate-6 group-hover:scale-110',
                  metric.icon === ShoppingBag && 'bg-ink text-brand-400',
                  metric.icon === Wallet && 'bg-brand-500 text-ink',
                  metric.icon === MessageCircle && 'bg-success-700 text-cream',
                  metric.icon === Clock3 && 'bg-sun text-ink',
                )}
              >
                <metric.icon className="size-4" />
              </div>
            </div>
            <p className="pop-up mt-4 origin-bottom-left font-serif text-[40px] leading-none font-normal tracking-[-0.01em] text-ink tabular-nums xl:text-[34px] 2xl:text-[40px]">
              {metric.value}
            </p>
            <p className="mt-2.5 text-xs text-stone-400">{metric.sub}</p>
          </div>
        ))}
      </section>
      <div className="mb-8 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <section className="card p-6 overflow-hidden xl:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
            <div>
              <h2 className="panel-title">Orders over time</h2>
              <p className="mt-1 text-xs text-stone-400">
                {periodTotal} {periodTotal === 1 ? 'order' : 'orders'} in the last {days} days
              </p>
            </div>
            <div className="tab-group">
              <button
                type="button"
                aria-pressed={days === 7}
                className="tab-btn"
                onClick={() => setDays(7)}
              >
                Last 7 days
              </button>
              <button
                type="button"
                aria-pressed={days === 30}
                className="tab-btn"
                onClick={() => setDays(30)}
              >
                Last 30 days
              </button>
            </div>
          </div>
          <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-ink/[0.06] pb-4 text-xs font-bold">
            <div className="flex items-baseline gap-2">
              <span className="pop-up inline-block origin-bottom-left font-serif text-[34px] leading-none font-normal tracking-[-0.01em] text-ink tabular-nums [--d:180ms]">
                {periodTotal}
              </span>
              <span className="text-[10.5px] font-semibold tracking-[0.12em] text-stone-400 uppercase">
                Total
              </span>
            </div>
            <div className="pop-in flex items-center gap-1.5 rounded-full bg-brand-500 px-3 py-1 text-ink shadow-[0_10px_20px_-10px_rgb(255_105_44/0.9)] [--d:260ms]">
              <span className="text-sm font-bold tabular-nums">
                {Math.max(...daysData.map((d) => d.count), 0)}
              </span>
              <span className="text-[11px] font-semibold text-ink/80">Peak / day</span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="pop-up inline-block origin-bottom-left font-serif text-[34px] leading-none font-normal tracking-[-0.01em] text-ink tabular-nums [--d:320ms]">
                {(periodTotal / days).toFixed(1)}
              </span>
              <span className="text-[10.5px] font-semibold tracking-[0.12em] text-stone-400 uppercase">
                Avg / day
              </span>
            </div>
          </div>
          <div className="relative mx-1 mb-2">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 flex h-40 flex-col justify-between"
            >
              <div className="border-t border-dashed border-ink/[0.09]" />
              <div className="border-t border-dashed border-ink/[0.09]" />
              <div className="border-t border-dashed border-ink/[0.09]" />
            </div>
            <div
              className={cn(
                'relative flex h-48 items-end justify-between gap-2 pt-3',
                // 29 full gaps would leave 30 bars about 2px wide on a phone.
                days === 30 && 'gap-0.5 sm:gap-1.5',
              )}
              role="img"
              aria-label={daysData
                .map(
                  (d) =>
                    `${d.date.toLocaleDateString()}: ${d.count} ${d.count === 1 ? 'order' : 'orders'}`,
                )
                .join('; ')}
            >
              {daysData.map((day, i) => (
                <div key={i} className="flex h-full min-w-0 flex-1 flex-col justify-end">
                  <div className="flex flex-1 items-end justify-center">
                    <div
                      title={`${day.count} ${day.count === 1 ? 'order' : 'orders'}`}
                      style={
                        {
                          height: day.count
                            ? `${Math.max(8, (day.count / maxCount) * 92)}%`
                            : '4px',
                          '--d': `${Math.min(i, 24) * 22}ms`,
                        } as React.CSSProperties
                      }
                      className={cn(
                        'bar-rise w-full max-w-10 rounded-t-[8px] rounded-b-[3px] transition-colors duration-300',
                        i === days - 1
                          ? 'bg-brand-500 shadow-[0_10px_20px_-8px_rgb(255_105_44/0.75)]'
                          : 'bg-ink/[0.13] hover:bg-ink/70',
                      )}
                    />
                  </div>
                  <span
                    className={cn(
                      'mt-3 h-4 text-center font-mono text-[10px] tracking-[0.06em] text-stone-400 uppercase tabular-nums',
                      i === days - 1 && 'font-bold text-brand-700',
                    )}
                  >
                    {days === 7
                      ? day.date.toLocaleDateString('en', { weekday: 'short' })
                      : i % 5 === 0
                        ? day.date.getDate()
                        : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
        <section className="card p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <h2 className="panel-title">Your setup</h2>
              <span className="pop-in inline-block rounded-full bg-ink px-2.5 py-0.5 text-[11px] font-semibold text-cream tabular-nums shadow-[0_8px_16px_-8px_rgb(14_6_4/0.7)] [--d:220ms]">
                {setupDone}/3
              </span>
            </div>
            <div className="mt-3">
              <div className="h-2 w-full overflow-hidden rounded-full bg-ink/[0.07]">
                <div
                  className="h-full rounded-full bg-brand-500 transition-[width] duration-700 ease-[var(--ease-soft)]"
                  style={{ width: `${(setupDone / 3) * 100}%` }}
                />
              </div>
            </div>
            <div className="stagger mt-5 space-y-2.5">
              {[
                {
                  title: 'Add your menu',
                  sub: `${products.length} items in your catalog`,
                  done: products.length > 0,
                  page: 'menu' as const,
                },
                {
                  title: 'Connect WhatsApp',
                  sub: whatsappDone ? 'Credentials verified' : 'Link a business phone number',
                  done: whatsappDone,
                  page: 'integrations' as const,
                },
                {
                  title: 'Connect your spreadsheet',
                  sub: 'Send orders straight to your Sheet',
                  done: integrations.some((i) => i.kind === 'sheets' && i.status === 'connected'),
                  page: 'integrations' as const,
                },
              ].map((step) => (
                <button
                  key={step.title}
                  className="lift group flex w-full items-center gap-3 rounded-2xl border border-white/80 bg-white/55 p-3 text-left transition-[transform,box-shadow,background-color] duration-300 ease-[var(--ease-soft)] hover:bg-white"
                  onClick={() => navigate(step.page)}
                >
                  <span
                    className={cn(
                      'flex size-8 shrink-0 items-center justify-center rounded-full border',
                      step.done
                        ? 'border-transparent bg-ink text-cream shadow-[0_8px_16px_-8px_rgb(14_6_4/0.7)]'
                        : 'border-dashed border-ink/25 bg-transparent text-stone-400',
                    )}
                  >
                    {step.done ? (
                      <Check className="pop-spin size-4 [--d:360ms]" />
                    ) : (
                      <span className="size-1.5 rounded-full bg-brand-500" />
                    )}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="line-clamp-2 text-[13px] font-semibold text-ink">
                      {step.title}
                    </span>
                    <span className="mt-0.5 line-clamp-2 text-[11.5px] text-stone-500">
                      {step.sub}
                    </span>
                  </span>
                  <ChevronRight className="size-4 text-stone-300 group-hover:text-ink" />
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>
      <section className="card overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-6 pt-6 pb-3">
          <div className="flex items-center gap-2.5">
            <h2 className="panel-title">Recent orders</h2>
            {/* The workspace total: the loaded list stops at 50. */}
            <Badge tone="neutral">{(data.summary?.orders ?? orders.length).toLocaleString()}</Badge>
          </div>
          <button
            className="-mr-3 inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[12.5px] font-semibold text-brand-700 transition-colors hover:bg-brand-500/10 hover:text-brand-800 md:min-h-0"
            onClick={() => navigate('orders')}
          >
            View all orders
            <ArrowRight className="size-3.5" />
          </button>
        </div>
        <OrderTable
          orders={orders
            .slice()
            .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
            .slice(0, 5)}
          onSelect={setSelected}
          // In a live workspace this list leaves out the bot's test orders.
          emptyDescription={data.mode === 'demo' ? undefined : 'Try the bot and confirm an order.'}
        />
      </section>
      {activity.length > 0 && (
        <section className="mt-8">
          <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="panel-title">Behind the conversation</h2>
            <span className="eyebrow">Recent bot activity</span>
          </div>
          <div className="stagger grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {activity.map((trace) => (
              <div key={trace.id} className="card p-4 sm:p-5">
                <div className="flex items-center gap-2.5 text-[13px] font-semibold text-ink">
                  <span className="size-2 shrink-0 rotate-45 rounded-[2px] bg-brand-500" />
                  {label(trace.action)}
                </div>
                <p className="mt-2 line-clamp-2 text-[11.5px] leading-relaxed text-stone-500">
                  {trace.detail}
                </p>
                <p className="mt-3 font-mono text-[11px] tracking-[0.02em] text-stone-400 tabular-nums">
                  {shortDate(trace.createdAt)}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}
      <OrderDetails
        order={selected ? data.orders.find((o) => o.id === selected.id) || selected : null}
        onClose={() => setSelected(null)}
      />
    </>
  );
}

/** Events about orders: staff changing one (here or elsewhere), a cancellation, a reminder. */
const orderEvent = (t: Trace) => /order|cancel/i.test(t.action);
/**
 * Changes whenever an order or the order totals change, or a new order event was recorded (a
 * change to an older order records one), and only then. WhatsApp delivery receipts, chat events
 * and AI spending are recorded all through service but change no order, so they are left out.
 */
export function ordersChangeKey(data: Pick<Bootstrap, 'orders' | 'summary' | 'traces'>) {
  const s = data.summary;
  return JSON.stringify([
    s ? [s.orders, s.pending, s.value] : null,
    data.orders.map((o) => [o.id, o.status, o.updatedAt, o.syncStatus]),
    newestEvent(data.traces, orderEvent),
  ]);
}

export function Orders() {
  const { data, navigate, detailId } = useWorkspace();
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Order | null>(null);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<PageResult<Order>>({
    items: data.orders,
    total: data.summary?.orders ?? data.orders.length,
    page: 1,
    pageSize: 50,
  });
  // error: opening an order or exporting failed. listError: loading the list failed, and
  // the next good load clears it.
  const [error, setError] = useState('');
  const [listError, setListError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [sandbox, setSandbox] = useState(data.mode === 'demo');
  const [loading, setLoading] = useState(false);
  const orders = result.items;
  const filtered = orders;
  const listKey = [page, query, filter, sandbox].join('|');
  const loadedKey = useRef(listKey);
  // The workspace refreshes every 15 seconds with new objects even when nothing changed: ask
  // for the list (and an open order) again only when an order or the totals really changed.
  const changes = ordersChangeKey(data);
  useEffect(() => {
    let active = true;
    // A new search, filter or page dims the old rows until it loads; the 15s refresh doesn't.
    const changed = loadedKey.current !== listKey;
    if (changed) setLoading(true);
    const timer = setTimeout(() => {
      void api<PageResult<Order>>(
        '/orders?page=' +
          page +
          '&search=' +
          encodeURIComponent(query) +
          '&status=' +
          filter +
          '&sandbox=' +
          sandbox,
        data.company.id,
      )
        .then((r) => {
          if (!active) return;
          setResult(r);
          setListError('');
          if (changed) setError('');
        })
        .catch((e) => {
          if (active) setListError(e.message);
        })
        .finally(() => {
          if (!active) return;
          loadedKey.current = listKey;
          setLoading(false);
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [data.company.id, changes, query, filter, page, sandbox]);
  const failedId = useRef<string | undefined>(undefined);
  useEffect(() => {
    let active = true;
    if (detailId) {
      // Open at once with the row already loaded; the fetch brings it up to date.
      const known =
        result.items.find((o) => o.id === detailId) ?? data.orders.find((o) => o.id === detailId);
      if (known) setSelected((current) => (current?.id === detailId ? current : known));
      void api<Order>('/orders/' + detailId, data.company.id)
        .then((o) => {
          if (!active) return;
          failedId.current = undefined;
          setSelected(o);
          setError('');
        })
        .catch((e) => {
          if (!active) return;
          // The 15s refresh asks again: say it once per order, so a dismissed notice stays away.
          if (failedId.current !== detailId) setError(e.message);
          failedId.current = detailId;
        });
    } else {
      failedId.current = undefined;
      setSelected(null);
    }
    return () => {
      active = false;
    };
  }, [detailId, data.company.id, changes]);
  async function exportCsv() {
    setExporting(true);
    setError('');
    try {
      const exportOrders: Order[] = [];
      for (let page = 1; ; page++) {
        const result = await api<PageResult<Order>>(
          `/orders?page=${page}&pageSize=100&search=${encodeURIComponent(query)}&status=${filter}&sandbox=${sandbox}`,
          data.company.id,
        );
        exportOrders.push(...result.items);
        if (page * 100 >= result.total) break;
        if (page >= 1000)
          throw new Error('This export is too large. Contact support for a complete archive.');
      }
      const csv = ordersCsv(exportOrders, data.company.timezone);
      // The byte-order mark tells Excel the file is UTF-8, so Urdu names and addresses read
      // as written.
      const url = URL.createObjectURL(
        new Blob([UTF8_BOM, csv], { type: 'text/csv;charset=utf-8' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `${data.company.slug}-orders.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExporting(false);
    }
  }
  return (
    <>
      <PageHeading
        title="Orders"
        description="From the first hello to the last bite. Keep every order moving."
      >
        <ActionButton
          disabled={!result.total}
          loading={exporting}
          loadingLabel="Exporting…"
          onClick={() => void exportCsv()}
        >
          <ArrowDownToLine className="size-4" />
          Export all matching orders
        </ActionButton>
        <button className="btn btn-primary" onClick={() => navigate('playground')}>
          <ShoppingBag className="size-4" />
          Try an order
        </button>
      </PageHeading>
      <section className="card overflow-hidden">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-4 sm:p-6 border-b border-ink/[0.06]">
          <div className="tab-group flex-wrap" role="group" aria-label="Order filters">
            {['all', 'pending', 'active', 'completed', 'rejected', 'cancelled'].map((value) => (
              <button
                key={value}
                aria-pressed={filter === value}
                className="tab-btn"
                onClick={() => {
                  setFilter(value);
                  setPage(1);
                }}
              >
                {label(value)}
                {value === 'pending' && (
                  <span className="pop-in ml-1.5 inline-flex min-w-5 justify-center rounded-full bg-brand-500 px-1.5 py-0.5 text-[10px] leading-none font-bold text-ink tabular-nums shadow-[0_4px_10px_-4px_rgb(255_105_44/0.8)] [--d:300ms]">
                    {data.summary?.pending ?? orders.filter((o) => o.status === 'pending').length}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="relative w-full md:w-64 shrink-0">
            <Search className="pointer-events-none absolute left-3.5 top-2.5 size-4 text-stone-400" />
            <input
              aria-label="Search orders"
              className="input pl-9 pr-4"
              placeholder="Search orders…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </div>
        </div>
        {(error || listError) && (
          <div className="mx-4 mt-4">
            <ErrorNotice
              message={error || listError}
              onDismiss={() => {
                setError('');
                setListError('');
              }}
            />
          </div>
        )}
        <label className="m-4 flex w-fit cursor-pointer items-center gap-2.5 text-[13px] font-medium text-stone-600">
          <input
            className="toggle"
            type="checkbox"
            checked={sandbox}
            onChange={(e) => {
              setSandbox(e.target.checked);
              setPage(1);
            }}
          />
          Show sandbox orders only
        </label>
        <div
          aria-busy={loading || undefined}
          className={cn('transition-opacity', loading && 'opacity-60')}
        >
          {/* Nothing matches a search or filter: the first-run invitation would wrongly
              suggest the business has no orders. */}
          {!orders.length && (query || filter !== 'all') ? (
            <Empty title="No matching orders" description="Try another search or filter." />
          ) : (
            <OrderTable
              orders={filtered}
              onSelect={(o) => navigate('orders', o.id, { keepScroll: true })}
              // The bot's test orders are sandbox orders, hidden while the toggle is off.
              emptyDescription={
                sandbox
                  ? undefined
                  : 'Try the bot and confirm an order, then turn on “Show sandbox orders only” to see it here.'
              }
            />
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink/[0.06] p-4 text-[13px] text-stone-500">
          <button className="btn" disabled={page === 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span className="tabular-nums">
            {result.total} {result.total === 1 ? 'order' : 'orders'} · Page {page} of{' '}
            {Math.max(1, Math.ceil(result.total / 50))}
          </span>
          <button
            className="btn"
            disabled={page * 50 >= result.total}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </div>
      </section>
      <OrderDetails
        order={selected ? data.orders.find((o) => o.id === selected.id) || selected : null}
        onClose={() => navigate('orders', undefined, { keepScroll: true })}
      />
    </>
  );
}

function OrderTable({
  orders,
  onSelect,
  emptyDescription = 'Try the bot and confirm an order. It will appear here, ready for your team.',
}: {
  orders: Order[];
  onSelect: (order: Order) => void;
  emptyDescription?: string;
}) {
  const { navigate } = useWorkspace();
  const itemCount = (order: Order) => order.items.reduce((sum, i) => sum + i.quantity, 0);
  if (!orders.length)
    return (
      <Empty
        title="Your next order starts here"
        description={emptyDescription}
        action="Test your bot"
        onAction={() => navigate('playground')}
      />
    );
  return (
    <>
      <div className="stagger divide-y divide-ink/[0.05] md:hidden">
        {orders.map((o) => (
          <button
            key={o.id}
            className="block w-full p-4 text-left transition-colors hover:bg-white/60 hover:shadow-[inset_3px_0_0_var(--color-brand-500)] active:bg-white/80"
            onClick={() => onSelect(o)}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="font-mono text-[12.5px] font-semibold tracking-[0.02em] text-ink">
                {o.reference}
              </strong>
              {o.source === 'menu_page' && <Badge tone="amber">Menu page</Badge>}
              <Status value={o.status} />
            </div>
            <p className="mt-2 text-sm break-words">
              {o.customerName} · {money(o.total)}
            </p>
            <p className="mt-2 text-xs text-stone-500">
              {label(o.fulfillment)} · {shortDate(o.createdAt)}
            </p>
          </button>
        ))}
      </div>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-2xl border-collapse">
          <thead>
            <tr>
              {['Order', 'Customer', 'Fulfillment', 'Total', 'Status', 'Placed'].map((title) => (
                <th key={title} scope="col" className="table-head">
                  {title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="stagger divide-y divide-ink/[0.04] [&>tr]:[animation-name:fade-in]">
            {orders.map((order) => (
              <tr
                key={order.id}
                className="group cursor-pointer"
                // The whole row opens the order (the reference button is its keyboard way in,
                // and its click lands here too). A drag to copy a name or number doesn't.
                onClick={(event) => {
                  const fromButton = (event.target as Element).closest('button');
                  if (!fromButton && window.getSelection()?.toString()) return;
                  onSelect(order);
                }}
              >
                <td className="table-cell group-hover:shadow-[inset_3px_0_0_var(--color-brand-500)]">
                  <button className="text-left font-mono text-[12.5px] font-semibold tracking-[0.02em] whitespace-nowrap text-ink decoration-brand-500 decoration-2 underline-offset-4 transition-colors hover:text-brand-700 hover:underline">
                    {order.reference}
                  </button>
                  <p className="mt-0.5 text-xs text-stone-500">
                    {itemCount(order)} {itemCount(order) === 1 ? 'item' : 'items'}
                  </p>
                  {order.source === 'menu_page' && (
                    <div className="mt-1">
                      <Badge tone="amber">Menu page</Badge>
                    </div>
                  )}
                </td>
                <td className="table-cell">
                  <div className="flex items-center gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-ink text-[11px] font-semibold text-brand-400 shadow-[0_6px_12px_-6px_rgb(14_6_4/0.6)] transition-transform duration-300 ease-[var(--ease-spring)] group-hover:scale-105 group-hover:-rotate-6">
                      {initials(order.customerName || 'Guest')}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold text-ink">
                        {order.customerName || 'Guest'}
                      </p>
                      <p className="mt-0.5 text-xs tabular-nums text-stone-500">
                        {order.customerPhone}
                      </p>
                    </div>
                  </div>
                </td>
                <td className="table-cell text-xs text-stone-500">{label(order.fulfillment)}</td>
                <td className="table-cell whitespace-nowrap text-[13px] font-semibold tabular-nums text-ink">
                  {money(order.total)}
                </td>
                <td className="table-cell">
                  <Status value={order.status} />
                </td>
                <td className="table-cell whitespace-nowrap text-xs tabular-nums text-stone-500">
                  {shortDate(order.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function OrderDetails({ order, onClose }: { order: Order | null; onClose: () => void }) {
  const { data, mutate, notify, clearError } = useWorkspace();
  const { pending, run } = useAction();
  // Stopping an order: rejected while it is pending, cancelled after it was accepted.
  // The status is kept apart from `open` so the dialog's text holds while it closes.
  const [stopOpen, setStopOpen] = useState(false);
  const [stopStatus, setStopStatus] = useState<'rejected' | 'cancelled'>('rejected');
  const [stopError, setStopError] = useState('');
  // This dialog is reused for every order: an answer about an order no longer shown
  // must not appear as this order's.
  const shown = useRef(order?.id);
  useEffect(() => {
    shown.current = order?.id;
  }, [order?.id]);
  const next: Partial<Record<OrderStatus, OrderStatus>> = {
    pending: 'accepted',
    accepted: 'preparing',
    preparing: 'ready',
    ready: order?.fulfillment === 'delivery' ? 'out_for_delivery' : 'completed',
    out_for_delivery: 'completed',
  };
  const nextStatus = order ? next[order.status] : undefined;
  // The order dialog shows a failure inline, so no notification is needed.
  const update = async (status: OrderStatus) => {
    if (!order) return;
    try {
      await mutate(`/orders/${order.id}/status`, { status }, undefined, {
        quiet: true,
        success:
          status === 'accepted'
            ? `Order ${order.reference} accepted.`
            : status === 'rejected'
              ? `Order ${order.reference} rejected.`
              : `Order ${order.reference} marked ${label(status).toLowerCase()}.`,
      });
    } catch (e) {
      if (shown.current !== order.id) {
        clearError();
        notify(`Order ${order.reference}: ${(e as Error).message}`, 'error');
      }
      throw e;
    }
  };
  return (
    <>
      <Modal
        open={Boolean(order)}
        onOpenChange={(value) => {
          if (!value) onClose();
        }}
        title={order?.reference || 'Order'}
        description={order ? `${order.customerName} · ${shortDate(order.createdAt)}` : ''}
      >
        {order && (
          <>
            <div className="flex items-center justify-between gap-3">
              <Status value={order.status} />
              <Badge>{label(order.fulfillment)}</Badge>
            </div>
            <div className="stagger my-5 divide-y divide-dashed divide-ink/[0.12] rounded-2xl bg-white/80 px-4 shadow-[0_0_0_1px_rgb(14_6_4/0.05),0_14px_28px_-20px_rgb(14_6_4/0.35)]">
              {order.items.map((item, index) => (
                <div key={index} className="flex gap-3 py-3.5">
                  <span className="h-fit rounded-full bg-ink px-2 py-0.5 text-[11px] font-semibold text-cream tabular-nums">
                    {item.quantity}×
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink">{item.name}</p>
                    {item.variant && <p className="mt-1 text-xs text-stone-500">{item.variant}</p>}
                    {item.modifiers.length > 0 && (
                      <p className="mt-1 text-xs text-stone-500">{item.modifiers.join(', ')}</p>
                    )}
                    {item.notes && (
                      <p className="mt-1 text-xs italic text-stone-700">{item.notes}</p>
                    )}
                  </div>
                  <span className="text-sm font-semibold whitespace-nowrap text-ink tabular-nums">
                    {money(item.total)}
                  </span>
                </div>
              ))}
            </div>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between text-stone-500">
                <dt>Subtotal</dt>
                <dd className="tabular-nums">{money(order.subtotal)}</dd>
              </div>
              <div className="flex justify-between text-stone-500">
                <dt>Delivery</dt>
                <dd className="tabular-nums">{money(order.deliveryFee)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-t border-dashed border-ink/15 pt-3 font-semibold text-ink">
                <dt>
                  Total ·{' '}
                  {staffPaymentNote(paymentMethodsOf(data.company), order.fulfillment === 'delivery')}
                </dt>
                <dd className="font-serif text-[28px] leading-none font-normal whitespace-nowrap tabular-nums">
                  {money(order.total)}
                </dd>
              </div>
            </dl>
            {staffTransferNote(paymentMethodsOf(data.company)) && (
              <p className="mt-2 text-xs leading-relaxed text-stone-500">
                {staffTransferNote(paymentMethodsOf(data.company))}
              </p>
            )}
            <div className="mt-5 space-y-2 rounded-2xl border border-ink/[0.05] bg-paper p-4 text-xs text-stone-500">
              <p>
                <span className="font-semibold text-stone-700">Customer:</span> {order.customerName}{' '}
                · <span className="whitespace-nowrap tabular-nums">{order.customerPhone}</span>
              </p>
              {order.address && (
                <p>
                  <span className="font-semibold text-stone-700">Deliver to:</span> {order.address}
                  {order.zone && ` (${order.zone})`}
                </p>
              )}
              <div className="flex items-center gap-2">
                <span>Spreadsheet</span>
                <Status value={order.syncStatus} />
              </div>
            </div>
            {order.status === 'pending' && order.phoneConfirmationRequired && (
              <CallConfirmation order={order} />
            )}
            {nextStatus && (
              // Wraps on narrow phones; each button then fills its own row.
              <div className="mt-6 flex flex-wrap gap-2.5">
                <button
                  className="btn hover:border-red-600/30 hover:bg-red-50 hover:text-red-700 max-sm:grow"
                  onClick={() => {
                    setStopError('');
                    setStopStatus(order.status === 'pending' ? 'rejected' : 'cancelled');
                    setStopOpen(true);
                  }}
                >
                  {order.status === 'pending' ? 'Reject order' : 'Cancel order'}
                </button>
                <ActionButton
                  className="btn-primary grow"
                  loading={pending === `status-${order.id}`}
                  loadingLabel={nextStatus === 'accepted' ? 'Accepting…' : 'Updating…'}
                  onClick={() =>
                    void run(`status-${order.id}`, () => update(nextStatus)).catch(() => undefined)
                  }
                >
                  {nextStatus === 'accepted'
                    ? 'Accept order'
                    : `Mark ${label(nextStatus).toLowerCase()}`}
                  <ArrowRight className="size-4" />
                </ActionButton>
              </div>
            )}
          </>
        )}
      </Modal>
      <ConfirmDialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        title={stopStatus === 'rejected' ? 'Reject this order?' : 'Cancel this order?'}
        description={`The order will be marked ${stopStatus}. In a live workspace the customer will receive an update.`}
        onConfirm={() => {
          const target = order?.id;
          const status = stopStatus;
          setStopError('');
          void run(`${status === 'rejected' ? 'reject' : 'cancel'}-${target}`, async () => {
            // The confirmation is shared by all orders: only answer it for this order.
            try {
              await update(status);
              if (shown.current === target) setStopOpen(false);
            } catch (e) {
              if (shown.current === target) setStopError((e as Error).message);
            }
          });
        }}
        busy={pending === `${stopStatus === 'rejected' ? 'reject' : 'cancel'}-${order?.id}`}
        busyLabel={stopStatus === 'rejected' ? 'Rejecting…' : 'Cancelling…'}
        error={stopError}
        confirmLabel={stopStatus === 'rejected' ? 'Reject order' : 'Cancel order'}
      />
    </>
  );
}

function CallConfirmation({ order }: { order: Order }) {
  const { mutate } = useWorkspace();
  const { pending, run } = useAction();
  const [outcome, setOutcome] = useState<'confirmed' | 'unreachable' | 'declined'>(
    order.phoneConfirmation?.outcome ?? 'confirmed',
  );
  const [addressVerified, setAddressVerified] = useState(
    order.phoneConfirmation?.addressVerified ?? false,
  );
  const [note, setNote] = useState(order.phoneConfirmation?.note ?? '');
  return (
    <section className="notice mt-5 space-y-3 p-4 sm:p-5">
      <h3 className="font-serif text-[22px] leading-[1.1] font-normal tracking-[-0.005em] text-cream">
        Phone confirmation required
      </h3>
      <p className="text-xs leading-5">
        Call <span className="whitespace-nowrap tabular-nums">{order.customerPhone}</span>, verify
        the order and delivery address, then record the outcome. Orderly does not make this phone
        call.
      </p>
      {order.phoneConfirmation && (
        <p className="text-xs">
          Last recorded: {order.phoneConfirmation.outcome} · {shortDate(order.phoneConfirmation.at)}
        </p>
      )}
      <Field label="Call outcome">
        <CustomSelect
          theme="dark"
          value={outcome}
          onChange={(v) => setOutcome(v as typeof outcome)}
          options={[
            { value: 'confirmed', label: 'Customer confirmed' },
            { value: 'unreachable', label: 'Could not reach customer' },
            { value: 'declined', label: 'Customer declined' },
          ]}
        />
      </Field>
      {order.fulfillment === 'delivery' && (
        <label className="flex cursor-pointer items-center gap-2.5 text-sm">
          <input
            className="toggle"
            type="checkbox"
            checked={addressVerified}
            onChange={(e) => setAddressVerified(e.target.checked)}
          />
          Delivery address verified with customer
        </label>
      )}
      <Field label="Call note (optional)">
        <input
          className="input"
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <ActionButton
        loading={pending === 'call'}
        loadingLabel="Recording…"
        onClick={() =>
          // The order dialog shows a failure inline.
          void run('call', () =>
            mutate('/orders/' + order.id + '/call', { outcome, addressVerified, note }, undefined, {
              dialog: true,
              success: 'Call outcome recorded.',
            }),
          ).catch(() => undefined)
        }
      >
        Record call outcome
      </ActionButton>
    </section>
  );
}
