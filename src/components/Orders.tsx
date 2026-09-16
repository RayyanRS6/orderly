import { useState } from 'react';
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
import type { Order, OrderStatus } from '../shared/types';
import { money } from '../shared/types';
import { useWorkspace } from '../lib/workspace';
import { cn, initials, label, shortDate } from '../lib/utils';
import { Badge, ConfirmDialog, Empty, Modal, PageHeading, Status } from './ui';

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
  const total = valid.reduce((sum, o) => sum + o.total, 0);
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
      count: orders.filter((o) => {
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
        <button className="btn rounded-full shadow-xs" onClick={() => navigate('playground')}>
          <MessageCircle className="size-4 text-emerald-700" />
          Test your bot
          <ArrowUpRight className="size-4 text-stone-400" />
        </button>
      </PageHeading>
      <section className="mb-8 grid grid-cols-1 overflow-hidden rounded-3xl border border-emerald-200/80 bg-gradient-to-br from-emerald-50/90 via-white to-emerald-50/40 shadow-xs md:grid-cols-5">
        <div className="p-6 sm:p-8 md:col-span-3">
          <div className="mb-3 flex items-center gap-2 text-xs font-bold tracking-wider text-emerald-800 uppercase">
            <span className="size-2 rounded-full bg-emerald-600 shadow-[0_0_6px_rgba(5,150,105,0.5)]" />
            YOUR RESTAURANT, CONNECTED
          </div>
          <h2 className="max-w-lg text-2xl sm:text-3xl font-bold leading-tight tracking-tight text-emerald-950">
            Good conversations.
            <br />
            Great orders.
          </h2>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-emerald-900/70">
            Let your bot take care of the menu and the details, while you take care of the food.
          </p>
          <button
            className="mt-6 inline-flex items-center gap-2 text-sm font-bold text-emerald-900 hover:text-emerald-700 transition-colors group"
            onClick={() => navigate('playground')}
          >
            See your bot in action
            <ArrowRight className="size-4 group-hover:translate-x-1 transition-transform" />
          </button>
        </div>
        <div className="flex items-center justify-center p-6 pt-0 md:col-span-2 md:py-8 md:pr-8">
          <div className="w-full max-w-sm rounded-2xl border border-emerald-200/80 bg-white p-4 sm:p-5 shadow-sm">
            <div className="flex items-center gap-3 border-b border-stone-100 pb-3.5">
              <div className="flex size-9 items-center justify-center rounded-xl bg-emerald-50 text-emerald-800 shadow-2xs">
                <MessageCircle className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-stone-900">{data.company.name}</p>
                <p className="mt-0.5 text-xs text-stone-400">Customer conversation preview</p>
              </div>
            </div>
            <div className="mt-3.5 ml-auto w-fit max-w-[85%] rounded-2xl rounded-tr-sm bg-stone-100 px-3.5 py-2 text-xs font-medium text-stone-700 shadow-2xs">
              Hi! Can I see your menu?
            </div>
            <div className="mt-2.5 w-fit max-w-[85%] rounded-2xl rounded-tl-sm bg-emerald-50 border border-emerald-100 px-3.5 py-2 text-xs font-medium text-emerald-900 shadow-2xs">
              Of course. Something delicious awaits. 🍽️
            </div>
            <div className="mt-3.5 flex items-center justify-between text-[11px] text-stone-400 border-t border-stone-100 pt-3">
              <span>Available in English, Urdu & Roman Urdu</span>
              <CheckCheck className="size-4 text-emerald-600" />
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
            value: data.orders.length.toLocaleString(),
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
            value: data.conversations.length.toLocaleString(),
            sub: `${data.conversations.filter((c) => c.mode === 'bot').length} currently handled by your bot`,
            icon: MessageCircle,
          },
          {
            label: 'Awaiting acceptance',
            value: pending.length.toLocaleString(),
            sub: pending.length ? 'Ready for your attention' : 'You’re all caught up',
            icon: Clock3,
          },
        ].map((metric) => (
          <div
            key={metric.label}
            className="card p-5 sm:p-6 hover:border-stone-300/80 transition-all"
          >
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-bold tracking-wider text-stone-500 uppercase">
                {metric.label}
              </p>
              <div className="flex size-9 items-center justify-center rounded-xl bg-stone-100 text-stone-600">
                <metric.icon className="size-4" />
              </div>
            </div>
            <p className="mt-4 text-3xl font-bold tracking-tight tabular-nums text-stone-900">
              {metric.value}
            </p>
            <p className="mt-2 text-xs text-stone-400">{metric.sub}</p>
          </div>
        ))}
      </section>
      <div className="mb-8 grid gap-6 xl:grid-cols-3">
        <section className="card p-5 sm:p-6 overflow-hidden xl:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
            <div>
              <h2 className="text-base font-bold tracking-tight text-stone-900">
                Orders over time
              </h2>
              <p className="mt-1 text-xs text-stone-400">
                {daysData.reduce((sum, day) => sum + day.count, 0)} orders in the last {days} days
              </p>
            </div>
            <div className="flex items-center rounded-full bg-stone-100 p-1 border border-stone-200/70 shadow-2xs">
              <button
                type="button"
                aria-pressed={days === 7}
                className={cn(
                  'rounded-full px-3 py-1 text-xs font-semibold transition-all',
                  days === 7
                    ? 'bg-white text-stone-900 shadow-xs'
                    : 'text-stone-500 hover:text-stone-800',
                )}
                onClick={() => setDays(7)}
              >
                Last 7 days
              </button>
              <button
                type="button"
                aria-pressed={days === 30}
                className={cn(
                  'rounded-full px-3 py-1 text-xs font-semibold transition-all',
                  days === 30
                    ? 'bg-white text-stone-900 shadow-xs'
                    : 'text-stone-500 hover:text-stone-800',
                )}
                onClick={() => setDays(30)}
              >
                Last 30 days
              </button>
            </div>
          </div>
          <div className="mb-5 flex flex-wrap items-center gap-4 text-xs font-bold border-b border-stone-100 pb-4">
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-extrabold text-stone-900 tabular-nums">
                {daysData.reduce((sum, day) => sum + day.count, 0)}
              </span>
              <span className="text-[11px] font-semibold text-stone-400 uppercase tracking-wider">
                Total
              </span>
            </div>
            <div className="flex items-center gap-1.5 rounded-full border border-emerald-200/80 bg-emerald-50 px-3 py-1 text-emerald-900">
              <span className="text-sm font-extrabold tabular-nums">
                {Math.max(...daysData.map((d) => d.count), 0)}
              </span>
              <span className="text-[11px] font-semibold text-emerald-700">Peak / day</span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-extrabold text-stone-900 tabular-nums">
                {(daysData.reduce((sum, day) => sum + day.count, 0) / days).toFixed(1)}
              </span>
              <span className="text-[11px] font-semibold text-stone-400 uppercase tracking-wider">
                Avg / day
              </span>
            </div>
          </div>
          <div className="relative mx-1 mb-2">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 flex h-40 flex-col justify-between"
            >
              <div className="border-t border-dashed border-stone-200" />
              <div className="border-t border-dashed border-stone-200" />
              <div className="border-t border-dashed border-stone-200" />
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
                        'w-full max-w-10 rounded-t-lg transition-all',
                        i === days - 1
                          ? 'bg-emerald-700 shadow-sm'
                          : 'bg-emerald-200/80 hover:bg-emerald-300',
                      )}
                    />
                  </div>
                  <span className="mt-3 h-4 text-center text-xs tabular-nums text-stone-400 font-medium">
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
        <section className="card p-5 sm:p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold tracking-tight text-stone-900">Your setup</h2>
              <span className="rounded-full bg-emerald-50 border border-emerald-200/60 px-2.5 py-0.5 text-xs font-bold text-emerald-800 tabular-nums">
                {Number(data.products.length > 0) +
                  Number(whatsapp?.status === 'connected') +
                  Number(
                    data.integrations.some((i) => i.kind === 'sheets' && i.status === 'connected'),
                  )}
                /3
              </span>
            </div>
            <div className="mt-3">
              <div className="h-2 w-full rounded-full bg-stone-100 overflow-hidden">
                <div
                  className="h-full rounded-full bg-emerald-600 transition-all duration-500"
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
                  done: integrations.some(
                    (i) => i.kind === 'sheets' && i.status === 'connected',
                  ),
                  page: 'integrations' as const,
                },
              ].map((step) => (
                <button
                  key={step.title}
                  className="flex w-full items-center gap-3 rounded-2xl border border-stone-100 bg-stone-50/60 p-3 text-left hover:bg-stone-50 hover:border-emerald-200/80 transition-all"
                  onClick={() => navigate(step.page)}
                >
                  <span
                    className={cn(
                      'flex size-8 shrink-0 items-center justify-center rounded-full border',
                      step.done
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                        : 'border-stone-200 bg-stone-50 text-stone-400',
                    )}
                  >
                    {step.done ? (
                      <Check className="size-4" />
                    ) : (
                      <span className="size-1.5 rounded-full bg-stone-300" />
                    )}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-xs font-bold text-stone-800">
                      {step.title}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-stone-400">{step.sub}</span>
                  </span>
                  <ChevronRight className="size-4 text-stone-300" />
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>
      <section className="card overflow-hidden">
        <div className="flex items-center justify-between p-5 sm:p-6 border-b border-stone-100">
          <div className="flex items-center gap-2.5">
            <h2 className="text-base font-bold tracking-tight text-stone-900">Recent orders</h2>
            <Badge tone="neutral">{orders.length}</Badge>
          </div>
          <button
            className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-800 hover:text-emerald-950 transition-colors"
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
            <h2 className="text-base font-bold tracking-tight text-stone-900">
              Behind the conversation
            </h2>
            <span className="text-xs text-stone-400">Recent bot activity</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {activity.map((trace) => (
              <div
                key={trace.id}
                className="card p-4 sm:p-5 hover:border-emerald-200/80 transition-all"
              >
                <div className="flex items-center gap-2 text-xs font-bold text-stone-800">
                  <span className="size-2 rounded-full bg-emerald-600 shadow-[0_0_6px_rgba(5,150,105,0.4)]" />
                  {label(trace.action)}
                </div>
                <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-stone-500">
                  {trace.detail}
                </p>
                <p className="mt-3 text-xs tabular-nums text-stone-400">
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
  const { data, navigate } = useWorkspace();
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Order | null>(null);
  const orders = data.orders || [];
  const filtered = orders
    .filter(
      (order) =>
        (filter === 'all' ||
          (filter === 'active'
            ? ['accepted', 'preparing', 'ready', 'out_for_delivery'].includes(order.status)
            : order.status === filter)) &&
        `${order.reference || ''} ${order.customerName || ''} ${order.customerPhone || ''}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  function exportCsv() {
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
      return `"${(/^[=+@\-]/.test(str) ? "'" : '') + str.replaceAll('"', '""')}"`;
    };
    const csv = [
      fields,
      ...filtered.map((o) => [
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
    URL.revokeObjectURL(url);
  }
  return (
    <>
      <PageHeading
        title="Orders"
        description="From the first hello to the last bite. Keep every order moving."
      >
        <button
          className="btn rounded-full shadow-xs"
          disabled={!filtered.length}
          onClick={exportCsv}
        >
          <ArrowDownToLine className="size-4" />
          Export CSV
        </button>
        <button
          className="btn btn-primary rounded-full shadow-xs"
          onClick={() => navigate('playground')}
        >
          <ShoppingBag className="size-4" />
          Try an order
        </button>
      </PageHeading>
      <section className="card overflow-hidden">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-4 sm:p-6 border-b border-stone-100">
          <div
            className="inline-flex items-center gap-1 overflow-x-auto max-w-full rounded-full bg-stone-100/90 p-1 border border-stone-200/70 shadow-2xs"
            aria-label="Order filters"
          >
            {['all', 'pending', 'active', 'completed', 'rejected', 'cancelled'].map((value) => (
              <button
                key={value}
                aria-pressed={filter === value}
                className={cn(
                  'rounded-full px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap transition-all',
                  filter === value
                    ? 'bg-emerald-700 text-white shadow-xs'
                    : 'text-stone-600 hover:text-stone-900 hover:bg-white/60',
                )}
                onClick={() => setFilter(value)}
              >
                {label(value)}
                {value === 'pending' && (
                  <span
                    className={cn(
                      'ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums',
                      filter === value ? 'bg-white/20 text-white' : 'bg-stone-200 text-stone-700',
                    )}
                  >
                    {orders.filter((o) => o.status === 'pending').length}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="relative w-full md:w-64 shrink-0">
            <Search className="pointer-events-none absolute left-3.5 top-2.5 size-4 text-stone-400" />
            <input
              aria-label="Search orders"
              className="input rounded-full pl-9 pr-4 py-1.5 text-xs sm:text-sm bg-stone-50/80 focus:bg-white"
              placeholder="Search orders…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        <OrderTable orders={filtered} onSelect={setSelected} />
      </section>
      <OrderDetails
        order={selected ? data.orders.find((o) => o.id === selected.id) || selected : null}
        onClose={() => setSelected(null)}
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
    <div className="overflow-x-auto">
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
        <tbody className="divide-y divide-stone-100">
          {orders.map((order) => (
            <tr key={order.id} className="hover:bg-stone-50/70 transition-colors">
              <td className="table-cell">
                <button
                  className="text-left text-xs font-bold text-emerald-800 underline-offset-4 hover:underline"
                  onClick={() => onSelect(order)}
                >
                  {order.reference}
                </button>
                <p className="mt-0.5 text-xs text-stone-400">
                  {order.items.reduce((sum, i) => sum + i.quantity, 0)} items
                </p>
              </td>
              <td className="table-cell">
                <div className="flex items-center gap-3">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-xs font-bold text-emerald-800 ring-1 ring-emerald-200/70">
                    {initials(order.customerName || 'Guest')}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold text-stone-800">
                      {order.customerName || 'Guest'}
                    </p>
                    <p className="mt-0.5 text-xs tabular-nums text-stone-400">
                      {order.customerPhone}
                    </p>
                  </div>
                </div>
              </td>
              <td className="table-cell text-xs font-medium text-stone-600">
                {label(order.fulfillment)}
              </td>
              <td className="table-cell whitespace-nowrap text-xs font-bold tabular-nums text-stone-900">
                {money(order.total)}
              </td>
              <td className="table-cell">
                <Status value={order.status} />
              </td>
              <td className="table-cell whitespace-nowrap text-xs tabular-nums text-stone-400">
                {shortDate(order.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
            <div className="my-5 divide-y divide-stone-100 border-y border-stone-100">
              {order.items.map((item, index) => (
                <div key={index} className="flex gap-3 py-4">
                  <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-semibold tabular-nums text-stone-700">
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
              <div className="flex justify-between border-t border-stone-100 pt-3 font-semibold">
                <dt>
                  Total · cash {order.fulfillment === 'delivery' ? 'on delivery' : 'at pickup'}
                </dt>
                <dd className="tabular-nums">{money(order.total)}</dd>
              </div>
            </dl>
            <div className="mt-5 space-y-2 rounded-2xl border border-stone-200/80 bg-stone-50/80 p-4 text-xs text-stone-500">
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
            {nextStatus && (
              <div className="mt-6 flex gap-2.5">
                {order.status === 'pending' && (
                  <button
                    className="btn rounded-full"
                    disabled={busy}
                    onClick={() => setReject(true)}
                  >
                    Reject order
                  </button>
                )}
                <button
                  className="btn btn-primary rounded-full flex-1"
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
