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
  const pending = data.orders.filter((o) => o.status === 'pending');
  const valid = data.orders.filter((o) => !['cancelled', 'rejected'].includes(o.status));
  const total = valid.reduce((sum, o) => sum + o.total, 0);
  const activity = data.traces
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 4);
  const daysData = Array.from({ length: days }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (days - 1 - index));
    const key = date.toLocaleDateString('en-CA', { timeZone: data.company.timezone });
    return {
      date,
      count: data.orders.filter(
        (o) =>
          new Date(o.createdAt).toLocaleDateString('en-CA', { timeZone: data.company.timezone }) ===
          key,
      ).length,
    };
  });
  const maxCount = Math.max(1, ...daysData.map((day) => day.count));
  const whatsapp = data.integrations.find((i) => i.kind === 'whatsapp');
  return (
    <>
      <PageHeading
        title="A little less busy. A lot more orderly."
        description={`Here's what's happening at ${data.company.name}.`}
      >
        <button className="btn" onClick={() => navigate('playground')}>
          <MessageCircle className="size-4" />
          Test your bot
          <ArrowUpRight className="size-4" />
        </button>
      </PageHeading>
      <section className="mb-7 grid grid-cols-1 overflow-hidden rounded-xl border border-emerald-200 bg-emerald-50 md:grid-cols-5">
        <div className="p-6 md:col-span-3 md:p-7">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-emerald-800">
            <span className="size-1.5 rounded-full bg-emerald-700" />
            YOUR RESTAURANT, CONNECTED
          </div>
          <h2 className="max-w-lg text-2xl font-semibold leading-tight text-emerald-950">
            Good conversations.
            <br />
            Great orders.
          </h2>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-emerald-900/70">
            Let your bot take care of the menu and the details, while you take care of the food.
          </p>
          <button
            className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-emerald-900"
            onClick={() => navigate('playground')}
          >
            See your bot in action
            <ArrowRight className="size-4" />
          </button>
        </div>
        <div className="flex items-center justify-center p-6 pt-0 md:col-span-2 md:py-6">
          <div className="w-full max-w-sm rounded-xl border border-emerald-200 bg-white p-4 shadow-xs">
            <div className="flex items-center gap-3 border-b border-stone-100 pb-3">
              <div className="flex size-9 items-center justify-center rounded-full bg-emerald-50 text-emerald-800">
                <MessageCircle className="size-5" />
              </div>
              <div>
                <p className="text-sm font-semibold">{data.company.name}</p>
                <p className="mt-0.5 text-xs text-stone-400">Customer conversation preview</p>
              </div>
            </div>
            <div className="mt-3 ml-auto w-fit max-w-full rounded-xl rounded-tr-sm bg-stone-100 px-3 py-2 text-xs text-stone-600">
              Hi! Can I see your menu?
            </div>
            <div className="mt-2 w-fit max-w-full rounded-xl rounded-tl-sm bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
              Of course. Something delicious awaits. 🍽️
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-stone-400">
              <span>Available in English, Urdu & Roman Urdu</span>
              <CheckCheck className="size-4 text-emerald-600" />
            </div>
          </div>
        </div>
      </section>
      <section
        className="mb-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
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
          <div key={metric.label} className="card p-5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-stone-500">{metric.label}</p>
              <metric.icon className="size-4 text-stone-400" />
            </div>
            <p className="mt-4 text-2xl font-semibold tabular-nums text-stone-900">
              {metric.value}
            </p>
            <p className="mt-2 text-xs text-stone-400">{metric.sub}</p>
          </div>
        ))}
      </section>
      <div className="mb-7 grid gap-6 xl:grid-cols-3">
        <section className="card overflow-hidden xl:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3 p-5">
            <div>
              <h2 className="text-sm font-semibold">Orders over time</h2>
              <p className="mt-1 text-xs text-stone-400">
                {daysData.reduce((sum, day) => sum + day.count, 0)} orders in the last {days} days
              </p>
            </div>
            <select
              aria-label="Order chart period"
              className="rounded-md border border-stone-200 px-2 py-1.5 text-xs"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
            </select>
          </div>
          <div className="relative mx-5 mb-5">
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
                        height: day.count ? `${Math.max(8, (day.count / maxCount) * 92)}%` : '3px',
                      }}
                      className={cn(
                        'w-full max-w-10 rounded-t-md',
                        i === days - 1 ? 'bg-emerald-800' : 'bg-emerald-200',
                      )}
                    />
                  </div>
                  <span className="mt-3 h-4 text-center text-xs tabular-nums text-stone-400">
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
        <section className="card p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Your setup</h2>
            <span className="text-xs tabular-nums text-stone-400">
              {Number(data.products.length > 0) +
                Number(whatsapp?.status === 'connected') +
                Number(
                  data.integrations.some((i) => i.kind === 'sheets' && i.status === 'connected'),
                )}
              /3
            </span>
          </div>
          <div className="mt-5 space-y-5">
            {[
              {
                title: 'Add your menu',
                sub: `${data.products.length} items in your catalog`,
                done: data.products.length > 0,
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
                done: data.integrations.some(
                  (i) => i.kind === 'sheets' && i.status === 'connected',
                ),
                page: 'integrations' as const,
              },
            ].map((step) => (
              <button
                key={step.title}
                className="flex w-full items-center gap-3 text-left"
                onClick={() => navigate(step.page)}
              >
                <span
                  className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded-full border',
                    step.done
                      ? 'border-emerald-100 bg-emerald-50 text-emerald-800'
                      : 'border-stone-200 text-stone-400',
                  )}
                >
                  {step.done ? (
                    <Check className="size-3.5" />
                  ) : (
                    <span className="size-1.5 rounded-full bg-stone-300" />
                  )}
                </span>
                <span className="flex-1">
                  <span className="block text-xs font-semibold text-stone-700">{step.title}</span>
                  <span className="mt-1 block text-xs text-stone-400">{step.sub}</span>
                </span>
                <ChevronRight className="size-4 text-stone-300" />
              </button>
            ))}
          </div>
        </section>
      </div>
      <section className="card overflow-hidden">
        <div className="flex items-center justify-between p-5">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Recent orders</h2>
            <Badge>{data.orders.length}</Badge>
          </div>
          <button
            className="inline-flex items-center gap-2 text-xs font-medium text-emerald-800"
            onClick={() => navigate('orders')}
          >
            View all orders
            <ArrowRight className="size-3.5" />
          </button>
        </div>
        <OrderTable
          orders={data.orders
            .slice()
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, 5)}
          onSelect={setSelected}
        />
      </section>
      {activity.length > 0 && (
        <section className="mt-7">
          <div className="mb-4 flex items-center gap-2">
            <h2 className="text-sm font-semibold">Behind the conversation</h2>
            <span className="text-xs text-stone-400">Recent bot activity</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {activity.map((trace) => (
              <div key={trace.id} className="rounded-lg border border-stone-200 bg-white p-4">
                <div className="flex items-center gap-2 text-xs font-medium text-stone-700">
                  <span className="size-1.5 rounded-full bg-emerald-600" />
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
  const filtered = data.orders
    .filter(
      (order) =>
        (filter === 'all' ||
          (filter === 'active'
            ? ['accepted', 'preparing', 'ready', 'out_for_delivery'].includes(order.status)
            : order.status === filter)) &&
        `${order.reference} ${order.customerName} ${order.customerPhone}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
        <button className="btn" disabled={!filtered.length} onClick={exportCsv}>
          <ArrowDownToLine className="size-4" />
          Export CSV
        </button>
        <button className="btn btn-primary" onClick={() => navigate('playground')}>
          <ShoppingBag className="size-4" />
          Try an order
        </button>
      </PageHeading>
      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-4 p-4 sm:p-5">
          <div className="flex flex-wrap gap-1" aria-label="Order filters">
            {['all', 'pending', 'active', 'completed', 'rejected', 'cancelled'].map((value) => (
              <button
                key={value}
                aria-pressed={filter === value}
                className={cn(
                  'rounded-lg px-3 py-2 text-xs font-medium',
                  filter === value
                    ? 'bg-emerald-50 text-emerald-900'
                    : 'text-stone-500 hover:bg-stone-50',
                )}
                onClick={() => setFilter(value)}
              >
                {label(value)}
                {value === 'pending' && (
                  <span className="ml-1.5 tabular-nums">
                    {data.orders.filter((o) => o.status === 'pending').length}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-3 size-4 text-stone-400" />
            <input
              aria-label="Search orders"
              className="input pl-9"
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
        <tbody>
          {orders.map((order) => (
            <tr key={order.id} className="hover:bg-stone-50">
              <td className="table-cell">
                <button
                  className="text-left text-xs font-semibold text-emerald-800 underline-offset-4 hover:underline"
                  onClick={() => onSelect(order)}
                >
                  {order.reference}
                </button>
                <p className="mt-1 text-xs text-stone-400">
                  {order.items.reduce((sum, i) => sum + i.quantity, 0)} items
                </p>
              </td>
              <td className="table-cell">
                <div className="flex items-center gap-2.5">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-stone-100 text-xs text-stone-500">
                    {initials(order.customerName || 'Guest')}
                  </div>
                  <div>
                    <p className="text-xs font-medium">{order.customerName || 'Guest'}</p>
                    <p className="mt-1 text-xs tabular-nums text-stone-400">
                      {order.customerPhone}
                    </p>
                  </div>
                </div>
              </td>
              <td className="table-cell text-xs text-stone-500">{label(order.fulfillment)}</td>
              <td className="table-cell whitespace-nowrap text-xs font-semibold tabular-nums">
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
                  <span className="rounded-md bg-stone-100 px-2 py-1 text-xs tabular-nums">
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
            <div className="mt-5 space-y-2 rounded-lg bg-stone-50 p-4 text-xs text-stone-500">
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
              <div className="mt-6 flex gap-2">
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
