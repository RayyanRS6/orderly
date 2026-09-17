import { useEffect, useState } from 'react';
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
import type { Order, OrderStatus, PageResult } from '../shared/types';
import { money } from '../shared/types';
import { api } from '../lib/api';
import { useWorkspace } from '../lib/workspace';
import { cn, initials, label, shortDate } from '../lib/utils';
import {
  Badge,
  ConfirmDialog,
  Empty,
  ErrorNotice,
  Field,
  CustomSelect,
  Modal,
  PageHeading,
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
        data.summary?.daily.find((d) => d.date === date.toISOString().slice(0, 10))?.count ??
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
  const whatsapp = integrations.find((i) => i.kind === 'whatsapp');
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
            <button className="btn" onClick={() => navigate('bot')}>
              Review setup
            </button>
          </div>
          <ul className="mt-3 grid gap-2 text-[13px] text-stone-700 sm:grid-cols-2">
            {data.readiness.map((c) => (
              <li key={c.id}>
                <span className={c.ready ? 'text-success-700' : 'text-brand-500'}>
                  {c.ready ? '✓' : '○'}
                </span>{' '}
                {c.label}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-stone-500">
            {data.summary?.needsStaff ?? 0} conversations need staff.{' '}
            <button
              className="font-semibold text-brand-500 hover:text-brand-600"
              onClick={() => navigate('inbox')}
            >
              Open inbox
            </button>
          </p>
        </section>
      )}
      <section className="card mb-8 grid grid-cols-1 overflow-hidden md:grid-cols-5">
        <div className="p-6 sm:p-8 md:col-span-3">
          <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold tracking-[0.6px] text-brand-500 uppercase">
            <span className="size-2 rounded-full bg-brand-500" />
            {data.company.botEnabled ? 'AUTOMATION ENABLED' : 'AUTOMATION PAUSED'}
          </div>
          <h2 className="max-w-lg font-serif text-2xl sm:text-3xl font-bold leading-tight tracking-[-0.4px] text-ink">
            Good conversations.
            <br />
            Great orders.
          </h2>
          <p className="mt-3 max-w-md text-[13.5px] leading-relaxed text-stone-500">
            Let your bot take care of the menu and the details, while you take care of the food.
          </p>
          <button
            className="mt-6 inline-flex items-center gap-2 text-[13px] font-semibold text-brand-500 hover:text-brand-600 transition-colors group"
            onClick={() => navigate('playground')}
          >
            See your bot in action
            <ArrowRight className="size-4 group-hover:translate-x-1 transition-transform" />
          </button>
        </div>
        <div className="flex items-center justify-center p-6 pt-0 md:col-span-2 md:py-8 md:pr-8">
          <div className="w-full max-w-sm rounded-[14px] border border-white bg-white/70 p-4 sm:p-5 shadow-[0_8px_24px_-12px_rgba(14,6,4,0.12)]">
            <div className="flex items-center gap-3 border-b border-ink/[0.06] pb-3.5">
              <div className="flex size-9 items-center justify-center rounded-[10px] bg-ink text-brand-500">
                <MessageCircle className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14.5px] font-semibold text-ink">{data.company.name}</p>
                <p className="mt-0.5 text-xs text-stone-500">Customer conversation preview</p>
              </div>
            </div>
            <div className="mt-3.5 ml-auto w-fit max-w-[85%] rounded-xl rounded-tr-sm bg-ink px-3.5 py-2 text-xs font-medium text-cream">
              Hi! Can I see your menu?
            </div>
            <div className="mt-2.5 w-fit max-w-[85%] rounded-xl rounded-tl-sm bg-brand-500/10 border border-brand-500/15 px-3.5 py-2 text-xs font-medium text-stone-800">
              Of course. Something delicious awaits. 🍽️
            </div>
            <div className="mt-3.5 flex items-center justify-between text-[11px] text-stone-400 border-t border-ink/[0.06] pt-3">
              <span>Available in English, Urdu & Roman Urdu</span>
              <CheckCheck className="size-4 text-brand-500" />
            </div>
          </div>
        </div>
      </section>
      <section
        className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
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
          <div key={metric.label} className="card p-5">
            <div className="flex items-center justify-between">
              <p className="text-[12.5px] font-medium text-stone-500">{metric.label}</p>
              <div className="flex size-9 items-center justify-center rounded-[9px] bg-ink/5 text-stone-500">
                <metric.icon className="size-4" />
              </div>
            </div>
            <p className="mt-2.5 text-[26px] font-bold tracking-[-0.5px] tabular-nums text-ink">
              {metric.value}
            </p>
            <p className="mt-2 text-xs text-stone-400">{metric.sub}</p>
          </div>
        ))}
      </section>
      <div className="mb-8 grid gap-6 xl:grid-cols-3">
        <section className="card p-6 overflow-hidden xl:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
            <div>
              <h2 className="panel-title">Orders over time</h2>
              <p className="mt-1 text-xs text-stone-400">
                {daysData.reduce((sum, day) => sum + day.count, 0)} orders in the last {days} days
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
          <div className="mb-5 flex flex-wrap items-center gap-4 text-xs font-bold border-b border-ink/[0.06] pb-4">
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-bold tracking-[-0.5px] text-ink tabular-nums">
                {daysData.reduce((sum, day) => sum + day.count, 0)}
              </span>
              <span className="text-[11px] font-semibold text-stone-400 uppercase tracking-[0.6px]">
                Total
              </span>
            </div>
            <div className="flex items-center gap-1.5 rounded-md bg-brand-500/12 px-2 py-0.5 text-brand-700">
              <span className="text-sm font-bold tabular-nums">
                {Math.max(...daysData.map((d) => d.count), 0)}
              </span>
              <span className="text-[11px] font-semibold text-brand-600">Peak / day</span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-bold tracking-[-0.5px] text-ink tabular-nums">
                {(daysData.reduce((sum, day) => sum + day.count, 0) / days).toFixed(1)}
              </span>
              <span className="text-[11px] font-semibold text-stone-400 uppercase tracking-[0.6px]">
                Avg / day
              </span>
            </div>
          </div>
          <div className="relative mx-1 mb-2">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 flex h-40 flex-col justify-between"
            >
              <div className="border-t border-ink/[0.05]" />
              <div className="border-t border-ink/[0.05]" />
              <div className="border-t border-ink/[0.05]" />
            </div>
            <div
              className="relative flex h-48 items-end justify-between gap-2 pt-3"
              role="img"
              aria-label={daysData
                .map((d) => `${d.date.toLocaleDateString()}: ${d.count} orders`)
                .join('; ')}
            >
              {daysData.map((day, i) => (
                <div key={i} className="flex h-full min-w-0 flex-1 flex-col justify-end">
                  <div className="flex flex-1 items-end justify-center">
                    <div
                      title={`${day.count} orders`}
                      style={{
                        height: day.count ? `${Math.max(8, (day.count / maxCount) * 92)}%` : '4px',
                      }}
                      className={cn(
                        'w-full max-w-10 rounded-t-md transition-all',
                        i === days - 1 ? 'bg-brand-500' : 'bg-brand-500/20 hover:bg-brand-500/40',
                      )}
                    />
                  </div>
                  <span className="mt-3 h-4 text-center text-[11px] tabular-nums text-stone-400">
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
              <span className="rounded-md bg-brand-500/12 px-[7px] py-0.5 text-[11px] font-semibold text-brand-700 tabular-nums">
                {Number(data.products.length > 0) +
                  Number(whatsapp?.status === 'connected') +
                  Number(
                    data.integrations.some((i) => i.kind === 'sheets' && i.status === 'connected'),
                  )}
                /3
              </span>
            </div>
            <div className="mt-3">
              <div className="h-[5px] w-full rounded bg-ink/8 overflow-hidden">
                <div
                  className="h-full rounded bg-ink transition-all duration-500"
                  style={{
                    width: `${
                      ((Number(data.products.length > 0) +
                        Number(whatsapp?.status === 'connected') +
                        Number(
                          data.integrations.some(
                            (i) => i.kind === 'sheets' && i.status === 'connected',
                          ),
                        )) /
                        3) *
                      100
                    }%`,
                  }}
                />
              </div>
            </div>
            <div className="mt-5 space-y-3">
              {[
                {
                  title: 'Add your menu',
                  sub: `${products.length} items in your catalog`,
                  done: products.length > 0,
                  page: 'menu' as const,
                },
                {
                  title: 'Connect WhatsApp',
                  sub:
                    whatsapp?.status === 'connected'
                      ? 'Credentials verified'
                      : 'Link a business phone number',
                  done: whatsapp?.status === 'connected',
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
                  className="flex w-full items-center gap-3 rounded-[10px] border border-white/60 bg-white/40 p-3 text-left hover:bg-white/75 transition-all"
                  onClick={() => navigate(step.page)}
                >
                  <span
                    className={cn(
                      'flex size-8 shrink-0 items-center justify-center rounded-full border',
                      step.done
                        ? 'border-transparent bg-brand-500/12 text-brand-600'
                        : 'border-ink/10 bg-transparent text-stone-400',
                    )}
                  >
                    {step.done ? (
                      <Check className="size-4" />
                    ) : (
                      <span className="size-1.5 rounded-full bg-stone-300" />
                    )}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-[13px] font-semibold text-ink">
                      {step.title}
                    </span>
                    <span className="mt-0.5 block truncate text-[11.5px] text-stone-500">
                      {step.sub}
                    </span>
                  </span>
                  <ChevronRight className="size-4 text-stone-300" />
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>
      <section className="card overflow-hidden">
        <div className="flex items-center justify-between px-6 pt-6 pb-2">
          <div className="flex items-center gap-2.5">
            <h2 className="panel-title">Recent orders</h2>
            <Badge tone="neutral">{orders.length}</Badge>
          </div>
          <button
            className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-brand-500 hover:text-brand-600 transition-colors"
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
        />
      </section>
      {activity.length > 0 && (
        <section className="mt-8">
          <div className="mb-4 flex items-center gap-2">
            <h2 className="panel-title">Behind the conversation</h2>
            <span className="text-xs text-stone-400">Recent bot activity</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {activity.map((trace) => (
              <div key={trace.id} className="card p-4 sm:p-5">
                <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                  <span className="size-2 rounded-full bg-brand-500" />
                  {label(trace.action)}
                </div>
                <p className="mt-2 line-clamp-2 text-[11.5px] leading-relaxed text-stone-500">
                  {trace.detail}
                </p>
                <p className="mt-3 text-[11.5px] font-medium tabular-nums text-stone-400">
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
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [sandbox, setSandbox] = useState(data.mode === 'demo');
  const orders = result.items;
  const filtered = orders;
  useEffect(() => {
    let active = true;
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
          if (active) setResult(r);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [data.company.id, data.orders, data.summary, query, filter, page, sandbox]);
  useEffect(() => {
    let active = true;
    if (detailId)
      void api<Order>('/orders/' + detailId, data.company.id)
        .then((o) => {
          if (active) setSelected(o);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    else setSelected(null);
    return () => {
      active = false;
    };
  }, [detailId, data.company.id, data.orders]);
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
      const fields = [
        'reference',
        'customer',
        'phone',
        'fulfillment',
        'total_pkr',
        'status',
        'created_at',
      ];
      const escape = (value: unknown) => {
        const str = String(value ?? '');
        return `"${(/^[\s]*[=+@\-]/.test(str) ? "'" : '') + str.replaceAll('"', '""')}"`;
      };
      const csv = [
        fields,
        ...exportOrders.map((o) => [
          o.reference,
          o.customerName,
          o.customerPhone,
          o.fulfillment,
          o.total / 100,
          o.status,
          o.createdAt,
        ]),
      ]
        .map((row) => row.map(escape).join(','))
        .join('\r\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
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
        <button
          className="btn"
          disabled={!result.total || exporting}
          onClick={() => void exportCsv()}
        >
          <ArrowDownToLine className="size-4" />
          {exporting ? 'Exporting…' : 'Export all matching orders'}
        </button>
        <button className="btn btn-primary" onClick={() => navigate('playground')}>
          <ShoppingBag className="size-4" />
          Try an order
        </button>
      </PageHeading>
      <section className="card overflow-hidden">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-4 sm:p-6 border-b border-ink/[0.06]">
          <div className="tab-group" aria-label="Order filters">
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
                  <span className="ml-1.5 rounded-md bg-brand-500/15 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-brand-700">
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
        <ErrorNotice message={error} />
        <label className="m-4 flex items-center gap-2 text-[13px] text-stone-600">
          <input
            type="checkbox"
            checked={sandbox}
            onChange={(e) => {
              setSandbox(e.target.checked);
              setPage(1);
            }}
          />
          Show sandbox orders
        </label>
        <OrderTable orders={filtered} onSelect={(o) => navigate('orders', o.id)} />
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink/[0.06] p-4 text-[13px] text-stone-500">
          <button className="btn" disabled={page === 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span>
            {result.total} orders · Page {page} of {Math.max(1, Math.ceil(result.total / 50))}
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
        onClose={() => navigate('orders')}
      />
    </>
  );
}

function OrderTable({ orders, onSelect }: { orders: Order[]; onSelect: (order: Order) => void }) {
  const { navigate } = useWorkspace();
  if (!orders.length)
    return (
      <Empty
        title="Your next order starts here"
        description="Try the bot and confirm an order. It will appear here, ready for your team."
        action="Test your bot"
        onAction={() => navigate('playground')}
      />
    );
  return (
    <>
      <div className="divide-y divide-ink/[0.05] md:hidden">
        {orders.map((o) => (
          <button
            key={o.id}
            className="block w-full p-4 text-left hover:bg-white/50"
            onClick={() => onSelect(o)}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-[13px] font-semibold text-ink">{o.reference}</strong>
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
          <tbody className="divide-y divide-ink/[0.04]">
            {orders.map((order) => (
              <tr key={order.id} className="hover:bg-white/50 transition-colors">
                <td className="table-cell">
                  <button
                    className="text-left text-[13px] font-semibold text-ink underline-offset-4 hover:text-brand-600 hover:underline"
                    onClick={() => onSelect(order)}
                  >
                    {order.reference}
                  </button>
                  <p className="mt-0.5 text-xs text-stone-500">
                    {order.items.reduce((sum, i) => sum + i.quantity, 0)} items
                  </p>
                </td>
                <td className="table-cell">
                  <div className="flex items-center gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-ink-soft text-xs font-semibold text-brand-500">
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
  const { mutate, busy } = useWorkspace();
  const [reject, setReject] = useState(false);
  const next: Partial<Record<OrderStatus, OrderStatus>> = {
    pending: 'accepted',
    accepted: 'preparing',
    preparing: 'ready',
    ready: order?.fulfillment === 'delivery' ? 'out_for_delivery' : 'completed',
    out_for_delivery: 'completed',
  };
  const nextStatus = order ? next[order.status] : undefined;
  async function update(status: OrderStatus) {
    if (!order) return;
    try {
      await mutate(`/orders/${order.id}/status`, { status });
      setReject(false);
    } catch {}
  }
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
            <div className="flex items-center justify-between">
              <Status value={order.status} />
              <Badge>{label(order.fulfillment)}</Badge>
            </div>
            <div className="my-5 divide-y divide-ink/[0.05] border-y border-ink/[0.06]">
              {order.items.map((item, index) => (
                <div key={index} className="flex gap-3 py-4">
                  <span className="h-fit rounded-md bg-ink/5 px-2 py-0.5 text-xs font-semibold tabular-nums text-stone-700">
                    {item.quantity}×
                  </span>
                  <div className="flex-1">
                    <p className="text-sm font-medium">{item.name}</p>
                    {item.variant && <p className="mt-1 text-xs text-stone-500">{item.variant}</p>}
                    {item.modifiers.length > 0 && (
                      <p className="mt-1 text-xs text-stone-500">{item.modifiers.join(', ')}</p>
                    )}
                    {item.notes && (
                      <p className="mt-1 text-xs italic text-stone-500">{item.notes}</p>
                    )}
                  </div>
                  <span className="text-sm tabular-nums">{money(item.total)}</span>
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
              <div className="flex justify-between border-t border-ink/[0.06] pt-3 font-semibold text-ink">
                <dt>
                  Total · cash {order.fulfillment === 'delivery' ? 'on delivery' : 'at pickup'}
                </dt>
                <dd className="tabular-nums">{money(order.total)}</dd>
              </div>
            </dl>
            <div className="mt-5 space-y-2 rounded-xl border border-white bg-white/70 p-4 text-xs text-stone-500">
              <p>
                <span className="font-semibold text-stone-700">Customer:</span> {order.customerName}{' '}
                · {order.customerPhone}
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
              <div className="mt-6 flex gap-2.5">
                {order.status === 'pending' && (
                  <button className="btn" disabled={busy} onClick={() => setReject(true)}>
                    Reject order
                  </button>
                )}
                <button
                  className="btn btn-primary flex-1"
                  disabled={busy}
                  onClick={() => void update(nextStatus)}
                >
                  {busy
                    ? 'Updating…'
                    : nextStatus === 'accepted'
                      ? 'Accept order'
                      : `Mark ${label(nextStatus).toLowerCase()}`}
                  <ArrowRight className="size-4" />
                </button>
              </div>
            )}
          </>
        )}
      </Modal>
      <ConfirmDialog
        open={reject}
        onOpenChange={setReject}
        title="Reject this order?"
        description="The order will be marked rejected. In a live workspace the customer will receive an update."
        onConfirm={() => void update('rejected')}
        busy={busy}
        confirmLabel="Reject order"
      />
    </>
  );
}

function CallConfirmation({ order }: { order: Order }) {
  const { mutate, busy } = useWorkspace();
  const [outcome, setOutcome] = useState<'confirmed' | 'unreachable' | 'declined'>(
    order.phoneConfirmation?.outcome ?? 'confirmed',
  );
  const [addressVerified, setAddressVerified] = useState(
    order.phoneConfirmation?.addressVerified ?? false,
  );
  const [note, setNote] = useState(order.phoneConfirmation?.note ?? '');
  return (
    <section className="notice mt-5 p-4 space-y-3">
      <h3 className="text-sm font-semibold text-cream">Phone confirmation required</h3>
      <p className="text-xs leading-5">
        Call {order.customerPhone}, verify the order and delivery address, then record the outcome.
        Orderly does not make this phone call.
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
        <label className="flex gap-2 text-sm">
          <input
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
      <button
        className="btn"
        disabled={busy}
        onClick={() =>
          void mutate('/orders/' + order.id + '/call', { outcome, addressVerified, note }).catch(
            () => {},
          )
        }
      >
        Record call outcome
      </button>
    </section>
  );
}
