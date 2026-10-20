import { useId, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronDown,
  Clock,
  Copy,
  Edit3,
  Link2,
  Pause,
  Play,
  Plus,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { Deal, DealState, Product } from '../shared/types';
import { money } from '../shared/types';
import { isPhotoUrl } from '../shared/menu';
import { dealIncludes, dealSavings, dealState, dealsWorkItOut, dealWhen } from '../shared/deals';
import { isNightWindow, localClock, type Clock as LocalClock } from '../shared/hours';
import {
  CHIP_DAYS,
  copyChoice,
  dealBody,
  dealToForm,
  formProblem,
  formSchedule,
  formToBody,
  formWindow,
  linkBroken,
  linkedName,
  longWindowNote,
  MAX_CHOICES,
  MAX_OPTIONS,
  menuMatches,
  newDealForm,
  openingWarning,
  optionsFromText,
  regularText,
  runsText,
  sameNameWarning,
  scheduleNotice,
  SHORT_DAYS,
  soldOutItem,
  sortDeals,
  splitList,
  staleRegularPrice,
  toPaisa,
  useNow,
  WHEN_PRESETS,
  withDeal,
  withOrder,
  type DealForm,
  type DealFormChoice,
  type DealFormItem,
} from '../lib/deal-form';
import { useAction, useWorkspace } from '../lib/workspace';
import { cn } from '../lib/utils';
import {
  ActionButton,
  Badge,
  ConfirmDialog,
  CustomSelect,
  Empty,
  ErrorNotice,
  Field,
  Modal,
  PageHeading,
  Spinner,
} from './ui';

const newId = () => crypto.randomUUID();
/** Said once to the owner after the first deal: open tabs from before deals miss a line. */
export const RELOAD_NOTE =
  'Ask your staff to reload any Orderly tab that was open before you added deals (kitchen tablets too): an older tab shows a deal order without what it includes.';
const GROUPS: { state: DealState; title: string }[] = [
  { state: 'on', title: 'On now' },
  { state: 'later', title: 'Later' },
  { state: 'sold_out', title: 'Sold out' },
  { state: 'paused', title: 'Paused' },
];
const noteKey = (companyId: string) => `orderly.deals.reloadNote.${companyId}`;
function noteSeen(companyId: string) {
  try {
    return typeof localStorage !== 'undefined' && !!localStorage.getItem(noteKey(companyId));
  } catch {
    return false;
  }
}
/** The last non-empty value: a closing dialog keeps its title and content through its exit fade. */
function useLast<T>(value: T | null) {
  const [last, setLast] = useState(value);
  if (value && value !== last) setLast(value);
  return value || last;
}
const chip =
  'inline-flex min-h-11 md:min-h-9 cursor-pointer items-center gap-2 rounded-full border px-3.5 text-xs font-semibold transition-[background-color,border-color,color,scale] duration-200 ease-[var(--ease-soft)] active:scale-95';
const chipOff =
  'border-ink/10 bg-white/70 text-stone-600 hover:border-ink/25 hover:bg-white hover:text-ink';
const chipOn = 'border-ink bg-ink text-cream shadow-[0_8px_18px_-8px_rgb(14_6_4/0.7)]';
const textButton =
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold text-brand-700 transition-colors hover:bg-brand-500/10 hover:text-brand-800 max-md:min-h-11 max-md:px-3';

export function Deals() {
  const { data, mutate } = useWorkspace();
  const { pending, run } = useAction();
  const [editing, setEditing] = useState<Deal | 'new' | null>(null);
  const [removing, setRemoving] = useState<Deal | null>(null);
  const [ordering, setOrdering] = useState<string[] | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  const [error, setError] = useState('');
  const [seen, setSeen] = useState(() => noteSeen(data.company.id));
  const shownEditing = useLast(editing);
  const shownRemoving = useLast(removing);
  const deals = sortDeals(data.deals ?? []);
  // Every minute, so "On now" and "Later" follow the restaurant's clock.
  const now = useNow(deals.length > 0);
  const clock = localClock(data.company.timezone, new Date(now).toISOString());
  const editable = data.role !== 'staff';
  const states = new Map(deals.map((deal) => [deal.id, dealState(deal, data.products, clock)]));
  const ended = deals.filter((deal) => states.get(deal.id) === 'ended');
  const legacy = data.products.filter((p) => /^deals?$/i.test(p.category.trim())).length;
  const byId = new Map(deals.map((deal) => [deal.id, deal]));
  const card = (deal: Deal) => (
    <DealCard
      key={deal.id}
      deal={deal}
      state={states.get(deal.id)!}
      clock={clock}
      editable={editable}
      pending={pending}
      onEdit={() => setEditing(deal)}
      onRemove={() => {
        setRemoving(deal);
        setError('');
      }}
      onToggle={() =>
        void run(`available-${deal.id}`, () =>
          mutate<Deal>(`/deals/${deal.id}/available`, { available: !deal.available }, undefined, {
            apply: (saved, current) => withDeal(current, saved),
            success: deal.available ? `${deal.name} paused.` : `${deal.name} is on again.`,
          }),
        ).catch(() => undefined)
      }
      onUpdatePrice={(total) =>
        void run(`regular-${deal.id}`, () =>
          mutate<Deal>('/deals', dealBody(deal, { regularPrice: total }), undefined, {
            apply: (saved, current) => withDeal(current, saved),
            success: `${deal.name}: bought separately is now ${money(total)}.`,
          }),
        ).catch(() => undefined)
      }
    />
  );
  return (
    <>
      <PageHeading
        title="Deals"
        description="Combos and time-limited offers. They show first on your menu page and the bot can sell them."
      >
        {editable && !ordering && deals.length > 1 && (
          <button className="btn" onClick={() => setOrdering(deals.map((deal) => deal.id))}>
            <ArrowUpDown className="size-4" />
            Reorder
          </button>
        )}
        {editable && !ordering && (
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            <Plus className="size-4" />
            Add deal
          </button>
        )}
      </PageHeading>
      {editable && deals.length > 0 && !seen && (
        <div className="step-in card mb-6 flex flex-wrap items-start gap-3 p-4 text-[13px] leading-relaxed text-stone-600">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-brand-600" aria-hidden />
          <p className="min-w-0 flex-1 basis-60">{RELOAD_NOTE}</p>
          <button
            className="btn btn-quiet"
            onClick={() => {
              try {
                localStorage.setItem(noteKey(data.company.id), '1');
              } catch {
                /* Shown again next visit: no harm. */
              }
              setSeen(true);
            }}
          >
            Got it
          </button>
        </div>
      )}
      {ordering ? (
        <section className="card p-4 sm:p-5" aria-labelledby="deal-order-title">
          <h2 id="deal-order-title" className="panel-title">
            Reorder deals
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-stone-500">
            Your menu page and the bot show deals in this order.
          </p>
          <ol className="mt-4 space-y-2">
            {ordering.map((id, index) => {
              const deal = byId.get(id);
              if (!deal) return null;
              const move = (by: number) => {
                const next = [...ordering];
                [next[index], next[index + by]] = [next[index + by]!, next[index]!];
                setOrdering(next);
              };
              return (
                <li
                  key={id}
                  className="flex items-center gap-3 rounded-2xl bg-white/70 py-1.5 pr-1.5 pl-3 shadow-[0_0_0_1px_rgb(14_6_4/0.05)]"
                >
                  <span className="w-5 text-xs font-semibold tabular-nums text-stone-400">
                    {index + 1}
                  </span>
                  <span aria-hidden className="text-xl">
                    {deal.emoji || '🎁'}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
                    {deal.name}
                  </span>
                  <button
                    className="icon-btn disabled:opacity-30"
                    aria-label={`Move ${deal.name} up`}
                    disabled={index === 0}
                    onClick={() => move(-1)}
                  >
                    <ArrowUp className="size-4" />
                  </button>
                  <button
                    className="icon-btn disabled:opacity-30"
                    aria-label={`Move ${deal.name} down`}
                    disabled={index === ordering.length - 1}
                    onClick={() => move(1)}
                  >
                    <ArrowDown className="size-4" />
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button className="btn" onClick={() => setOrdering(null)}>
              Cancel
            </button>
            <ActionButton
              className="btn-primary"
              loading={pending === 'order'}
              loadingLabel="Saving…"
              onClick={() => {
                const ids = ordering;
                void run('order', async () => {
                  await mutate('/deals/order', { ids }, undefined, {
                    apply: (_, current) => withOrder(current, ids),
                    success: 'New order saved.',
                  });
                  setOrdering(null);
                }).catch(() => undefined);
              }}
            >
              <Check className="size-4" />
              Save order
            </ActionButton>
          </div>
        </section>
      ) : deals.length ? (
        <div className="space-y-8">
          {GROUPS.map(({ state, title }) => {
            const group = deals.filter((deal) => states.get(deal.id) === state);
            if (!group.length) return null;
            return (
              <section key={state} aria-label={title}>
                <h2 className="eyebrow mb-3">
                  {title} · {group.length}
                </h2>
                <div className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {group.map(card)}
                </div>
              </section>
            );
          })}
          {ended.length > 0 && (
            <section>
              <button
                className="inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-sm font-semibold text-stone-600 transition-colors hover:bg-ink/5 hover:text-ink md:min-h-9"
                aria-expanded={showEnded}
                onClick={() => setShowEnded(!showEnded)}
              >
                Ended ({ended.length})
                <ChevronDown
                  className={cn('size-4 transition-transform', showEnded && 'rotate-180')}
                />
              </button>
              {showEnded && (
                <div className="stagger mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {ended.map(card)}
                </div>
              )}
            </section>
          )}
        </div>
      ) : (
        <div className="card">
          <Empty
            title="No deals yet"
            description="A deal is a set bundle at one price, like “Deal 1: Zinger + fries + drink, Rs 799”, or an offer that only runs at set times, like a lunch or late-night deal."
            action={editable ? 'Add your first deal' : undefined}
            onAction={() => setEditing('new')}
          />
          {legacy > 0 && (
            <p className="mx-5 mb-6 rounded-2xl bg-ink/[0.04] px-4 py-3 text-center text-xs leading-relaxed text-stone-600">
              You also have {legacy} {legacy === 1 ? 'item' : 'items'} in a “Deals” category on your
              Menu tab. They still sell as normal items.
            </p>
          )}
        </div>
      )}
      <Modal
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={shownEditing === 'new' ? 'Add a deal' : 'Edit deal'}
        description="Prices are in PKR. Your menu page and the bot always use these values."
        wide
        // A stray tap on the backdrop must not throw away a half-filled deal.
        dismissable={false}
      >
        {shownEditing && (
          <DealEditor
            key={shownEditing === 'new' ? 'new' : shownEditing.id}
            deal={shownEditing === 'new' ? undefined : shownEditing}
            onDone={() => setEditing(null)}
          />
        )}
      </Modal>
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`Delete ${shownRemoving?.name || 'deal'}?`}
        description="It comes off your menu page and the bot stops selling it. Orders already placed keep their details."
        confirmLabel="Delete deal"
        busy={pending === 'delete'}
        busyLabel="Deleting…"
        error={error}
        onConfirm={() => {
          const target = removing;
          if (!target) return;
          setError('');
          void run('delete', async () => {
            try {
              await mutate(`/deals/${target.id}`, undefined, 'DELETE', {
                dialog: true,
                apply: (_, current) => ({
                  ...current,
                  deals: (current.deals ?? []).filter((deal) => deal.id !== target.id),
                }),
                success: `${target.name} deleted.`,
              });
              setRemoving(null);
            } catch (e) {
              setError((e as Error).message);
            }
          });
        }}
      />
    </>
  );
}

function DealPicture({ deal, dim }: { deal: Deal; dim: boolean }) {
  return (
    <div
      className={cn(
        'flex size-16 shrink-0 -rotate-3 items-center justify-center overflow-hidden rounded-2xl bg-paper text-[34px] shadow-[inset_0_1px_0_#fff,0_0_0_1px_rgb(14_6_4/0.05),0_10px_20px_-14px_rgb(14_6_4/0.45)]',
        dim && 'opacity-60 grayscale',
      )}
      aria-hidden
    >
      {deal.imageUrl && isPhotoUrl(deal.imageUrl) ? (
        <img
          src={deal.imageUrl}
          alt=""
          width={64}
          height={64}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="size-16 object-cover"
        />
      ) : (
        deal.emoji || '🎁'
      )}
    </div>
  );
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2 rounded-xl bg-sun/20 px-3 py-2 text-xs leading-relaxed text-stone-700">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-brand-700" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

function DealCard({
  deal,
  state,
  clock,
  editable,
  pending,
  onEdit,
  onRemove,
  onToggle,
  onUpdatePrice,
}: {
  deal: Deal;
  state: DealState;
  clock: LocalClock | undefined;
  editable: boolean;
  pending?: string;
  onEdit: () => void;
  onRemove: () => void;
  onToggle: () => void;
  onUpdatePrice: (total: number) => void;
}) {
  const { data } = useWorkspace();
  const savings = dealSavings(deal);
  const when = dealWhen(deal.schedule, 'en', clock);
  const broken = deal.items.filter((item) => linkBroken(item, data.products));
  const closed =
    state === 'paused' || state === 'ended'
      ? ''
      : openingWarning(deal.schedule, data.company.openingHours);
  const stale = staleRegularPrice(deal, data.products);
  const badge =
    state === 'on' ? (
      <Badge tone="green">
        <span className="size-1.5 rounded-full bg-current" />
        On now
      </Badge>
    ) : state === 'later' ? (
      <Badge tone="amber">Later</Badge>
    ) : state === 'sold_out' ? (
      <Badge tone="red" className="max-w-full whitespace-normal">
        Sold out: {soldOutItem(deal, data.products) ?? 'an item'}
      </Badge>
    ) : (
      <Badge>{state === 'paused' ? 'Paused' : 'Ended'}</Badge>
    );
  return (
    <article className="card group flex flex-col overflow-hidden">
      <div className="flex items-start gap-4 p-5 sm:p-6">
        <DealPicture deal={deal} dim={state !== 'on'} />
        <div className="min-w-0 flex-1">
          <h3 className="font-serif text-[23px] leading-[1.05] font-normal tracking-[-0.005em] break-words text-ink">
            {deal.name}
          </h3>
          <p className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-brand-500/10 px-2.5 py-0.5 text-[13px] font-semibold text-brand-800 tabular-nums">
              {money(deal.price)}
            </span>
            {savings !== undefined && (
              <>
                <s className="text-xs text-stone-400 tabular-nums">
                  {money(deal.regularPrice ?? 0)}
                </s>
                <Badge tone="green">You save {money(savings)}</Badge>
              </>
            )}
          </p>
        </div>
        {editable && (
          <button
            className="icon-btn -mt-2 -mr-2 size-8"
            aria-label={`Edit ${deal.name}`}
            onClick={onEdit}
          >
            <Edit3 className="size-3.5" />
          </button>
        )}
      </div>
      <div className="flex-1 space-y-1.5 px-5 pb-4 text-xs leading-5 text-stone-600 sm:px-6">
        <p>
          <span className="font-semibold text-stone-700">Includes:</span>{' '}
          {dealIncludes(deal).join(' · ')}
        </p>
        {deal.choices.map((group) => (
          <p key={group.id}>
            <span className="font-semibold text-stone-700">{group.name}:</span>{' '}
            {group.options
              .map((option) =>
                option.price ? `${option.name} (+${money(option.price)})` : option.name,
              )
              .join(', ')}
          </p>
        ))}
        <p className="flex items-start gap-1.5 text-stone-500">
          <Clock className="mt-1 size-3 shrink-0" aria-hidden />
          <span>{when || 'Any time you’re open'}</span>
        </p>
        {editable && (broken.length > 0 || closed || stale !== undefined) && (
          <ul className="space-y-2 pt-2">
            {broken.map((item) => (
              <Warning key={`${item.productId}-${item.name}`}>
                {item.name} is no longer on your menu — pick again or keep as text.
              </Warning>
            ))}
            {closed && <Warning>{closed}</Warning>}
            {stale !== undefined && (
              <Warning>
                Prices changed: bought separately is now {money(stale)} (you show{' '}
                {money(deal.regularPrice ?? 0)}).{' '}
                <button
                  className={cn(textButton, '-my-1')}
                  aria-busy={pending === `regular-${deal.id}` || undefined}
                  onClick={() => onUpdatePrice(stale)}
                >
                  {pending === `regular-${deal.id}` && <Spinner className="size-3" />}
                  Update
                </button>
              </Warning>
            )}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-dashed border-ink/10 bg-paper/60 py-2.5 pr-3 pl-5">
        {badge}
        {editable && (
          <div className="flex items-center gap-1">
            <button
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold text-stone-600 transition-colors hover:bg-brand-500/10 hover:text-brand-800 max-md:min-h-11 max-md:px-3"
              aria-label={`${deal.available ? 'Pause' : 'Resume'}: ${deal.name}`}
              aria-busy={pending === `available-${deal.id}` || undefined}
              onClick={onToggle}
            >
              {pending === `available-${deal.id}` ? (
                <Spinner className="size-3" />
              ) : deal.available ? (
                <Pause className="size-3" />
              ) : (
                <Play className="size-3" />
              )}
              {deal.available ? 'Pause' : 'Resume'}
            </button>
            <button
              className="inline-flex size-7 items-center justify-center rounded-full text-stone-400 transition-colors hover:bg-red-600/10 hover:text-red-700 max-md:size-11"
              aria-label={`Delete ${deal.name}`}
              onClick={onRemove}
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-3">
      <p className="eyebrow text-stone-700">{title}</p>
      {hint && <p className="mt-1.5 text-xs leading-relaxed text-stone-500">{hint}</p>}
    </div>
  );
}

/** The add and edit form (exported for its tests). */
export function DealEditor({ deal, onDone }: { deal?: Deal; onDone: () => void }) {
  const { data, mutate } = useWorkspace();
  const { pending, run } = useAction();
  const deals = data.deals ?? [];
  const [form, setForm] = useState<DealForm>(() =>
    deal ? dealToForm(deal, newId) : newDealForm(deals, newId),
  );
  const [error, setError] = useState('');
  const [active, setActive] = useState<string>();
  const [more, setMore] = useState(false);
  const daysLabel = useId();
  const update = (values: Partial<DealForm>) => setForm((current) => ({ ...current, ...values }));
  const setItem = (key: string, values: Partial<DealFormItem>) =>
    update({ items: form.items.map((item) => (item.key === key ? { ...item, ...values } : item)) });
  const setChoice = (index: number, group: DealFormChoice) =>
    update({ choices: form.choices.map((g, i) => (i === index ? group : g)) });
  const clock = localClock(data.company.timezone, new Date().toISOString());
  const today = clock?.date ?? new Date().toISOString().slice(0, 10);
  const price = toPaisa(form.price);
  const named = form.items.filter((item) => item.name.trim());
  const work = dealsWorkItOut({ items: named }, data.products);
  const regular = regularText(form, data.products);
  const saving = Number.isFinite(price) && regular ? toPaisa(regular) - price : undefined;
  const schedule = formSchedule(form);
  const night = form.timed && isNightWindow(formWindow(form));
  const sameName = sameNameWarning(
    [form.name, ...splitList(form.aliases)],
    data.products,
    deals,
    deal?.id,
  );
  return (
    <form
      className="space-y-7"
      onSubmit={(e) => {
        e.preventDefault();
        setError('');
        const problem = formProblem(form);
        if (problem) {
          setError(problem);
          return;
        }
        const body = formToBody(form, data.products, deal?.id);
        const success = [
          `${body.name} saved.`,
          scheduleNotice(body.schedule, clock),
          !deal && !deals.length ? RELOAD_NOTE : '',
        ]
          .filter(Boolean)
          .join(' ');
        // A failed save shows inside this dialog (Modal), so no notification is needed.
        void run('save', async () => {
          await mutate<Deal>('/deals', body, undefined, {
            dialog: true,
            apply: (saved, current) => withDeal(current, saved),
            success,
          });
          onDone();
        }).catch(() => undefined);
      }}
    >
      <section>
        <SectionTitle title="The deal" />
        <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
          <Field label="Name">
            <input
              className="input"
              required
              maxLength={120}
              value={form.name}
              placeholder="Deal 1"
              onChange={(e) => update({ name: e.target.value })}
            />
          </Field>
          <Field label="Price (PKR)">
            <input
              className="input tabular-nums"
              required
              type="number"
              inputMode="decimal"
              min="0"
              max="1000000"
              step="0.01"
              value={form.price}
              placeholder="799"
              onWheel={(e) => e.currentTarget.blur()}
              onChange={(e) => update({ price: e.target.value })}
            />
          </Field>
        </div>
        {sameName && (
          <p className="step-in mt-2 rounded-xl bg-sun/20 px-3 py-2 text-xs leading-relaxed text-stone-700">
            {sameName}
          </p>
        )}
        <div className="mt-5">
          <span className="field-label">What’s included</span>
          <p className="-mt-1 mb-2 text-xs leading-relaxed text-stone-500">
            Type a name. Tap a menu item to link it, so the deal shows sold out when that item is;
            anything else stays as you typed it.
          </p>
          <div className="space-y-2.5">
            {form.items.map((item, index) => (
              <IncludeRow
                key={item.key}
                item={item}
                index={index}
                products={data.products}
                active={active === item.key}
                canRemove={form.items.length > 1}
                onFocus={() => setActive(item.key)}
                onChange={(values) => setItem(item.key, values)}
                onRemove={() => update({ items: form.items.filter((i) => i.key !== item.key) })}
              />
            ))}
          </div>
          {form.items.length < 20 && (
            <button
              type="button"
              className="btn btn-quiet mt-2"
              onClick={() => {
                const key = newId();
                update({ items: [...form.items, { key, name: '', quantity: 1 }] });
                setActive(key);
              }}
            >
              <Plus className="size-4" />
              Add item
            </button>
          )}
        </div>
      </section>
      <section>
        <SectionTitle
          title="Price if bought separately"
          hint="Optional. Shown as “You save” on your menu page. Filled in from the linked menu items until you type your own."
        />
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-40">
            <Field label="Regular price (PKR)">
              <input
                className="input tabular-nums"
                type="number"
                inputMode="decimal"
                min="0"
                max="1000000"
                step="0.01"
                value={regular}
                placeholder="1049"
                onWheel={(e) => e.currentTarget.blur()}
                onChange={(e) => update({ regularPrice: e.target.value, regularTyped: true })}
              />
            </Field>
          </div>
          {form.regularTyped && work.total > 0 && (
            <button
              type="button"
              className={textButton}
              onClick={() => update({ regularTyped: false, regularPrice: '' })}
            >
              Work it out ({money(work.total)})
            </button>
          )}
        </div>
        <div className="mt-2 space-y-1 text-xs leading-relaxed">
          {saving !== undefined && saving > 0 && (
            <p className="font-semibold text-success-800">Customers save {money(saving)}</p>
          )}
          {saving !== undefined && saving <= 0 && (
            <p className="text-stone-500">No saving shown: this isn’t above the deal price.</p>
          )}
          {named.length > 0 && work.notCounted.length > 0 && (
            <p className="text-stone-500">Not counted: {work.notCounted.join(', ')}</p>
          )}
        </div>
      </section>
      <section>
        <SectionTitle
          title="Choices"
          hint={
            form.choices.length
              ? 'Customers pick one option from each. The bot asks for any they leave out.'
              : undefined
          }
        />
        <div className="space-y-3">
          {form.choices.map((group, index) => (
            <ChoiceEditor
              key={group.id}
              group={group}
              index={index}
              canCopy={form.choices.length < MAX_CHOICES}
              onChange={(next) => setChoice(index, next)}
              onCopy={() => update({ choices: copyChoice(form.choices, index, newId) })}
              onRemove={() => update({ choices: form.choices.filter((_, i) => i !== index) })}
            />
          ))}
        </div>
        {form.choices.length < MAX_CHOICES && (
          <button
            type="button"
            className={cn('btn', form.choices.length ? 'btn-quiet mt-2' : 'w-full sm:w-auto')}
            onClick={() =>
              update({
                choices: [
                  ...form.choices,
                  {
                    id: newId(),
                    name: '',
                    options: [
                      { id: newId(), name: '', extra: '' },
                      { id: newId(), name: '', extra: '' },
                    ],
                  },
                ],
              })
            }
          >
            <Plus className="size-4" />
            {form.choices.length ? 'Add another choice' : 'Add a choice (e.g. Drink)'}
          </button>
        )}
      </section>
      <section>
        <SectionTitle title="When" />
        <div className="tab-group">
          <button
            type="button"
            className="tab-btn"
            aria-pressed={!form.timed}
            onClick={() => update({ timed: false })}
          >
            Any time we’re open
          </button>
          <button
            type="button"
            className="tab-btn"
            aria-pressed={form.timed}
            onClick={() => update({ timed: true })}
          >
            Set times
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {WHEN_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={cn(chip, chipOff)}
              onClick={() => update(preset.fill(today))}
            >
              {preset.label}
            </button>
          ))}
        </div>
        {form.timed && (
          <div className="step-in mt-4 space-y-4 rounded-2xl border border-ink/[0.05] bg-paper p-4 sm:p-5">
            <div>
              <span id={daysLabel} className="field-label">
                {night ? 'Which nights?' : 'Which days?'}
              </span>
              <div role="group" aria-labelledby={daysLabel} className="flex flex-wrap gap-2">
                {CHIP_DAYS.map((day) => {
                  const on = form.chips.includes(day);
                  return (
                    <label key={day} className={cn(chip, on ? chipOn : chipOff)}>
                      <input
                        type="checkbox"
                        className="size-3.5 accent-brand-500"
                        checked={on}
                        onChange={(e) =>
                          update({
                            chips: e.target.checked
                              ? [...form.chips, day]
                              : form.chips.filter((d) => d !== day),
                          })
                        }
                      />
                      {SHORT_DAYS[day]}
                      {night ? ' night' : ''}
                    </label>
                  );
                })}
              </div>
            </div>
            <label className="flex w-fit cursor-pointer items-center gap-2.5 text-sm font-medium text-stone-600">
              <input
                className="toggle"
                type="checkbox"
                checked={form.allDay}
                onChange={(e) => update({ allDay: e.target.checked })}
              />
              All day
            </label>
            {!form.allDay && (
              <div className="grid grid-cols-2 gap-4">
                <Field label="From">
                  <input
                    className="input"
                    type="time"
                    required
                    value={form.start}
                    onChange={(e) => update({ start: e.target.value })}
                  />
                </Field>
                <Field label="To">
                  <input
                    className="input"
                    type="time"
                    required
                    value={form.end}
                    onChange={(e) => update({ end: e.target.value })}
                  />
                </Field>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <Field label="Start date (optional)">
                <input
                  className="input"
                  type="date"
                  value={form.startDate}
                  onChange={(e) => update({ startDate: e.target.value })}
                />
              </Field>
              <Field label="End date (optional)">
                <input
                  className="input"
                  type="date"
                  value={form.endDate}
                  min={form.startDate || undefined}
                  onChange={(e) => update({ endDate: e.target.value })}
                />
              </Field>
            </div>
            <WhenPreview form={form} clock={clock} />
          </div>
        )}
      </section>
      <section>
        <button
          type="button"
          className="flex min-h-11 w-full items-center justify-between gap-3 rounded-2xl border border-ink/[0.06] bg-white/60 px-4 text-left transition-colors hover:bg-white"
          aria-expanded={more}
          onClick={() => setMore(!more)}
        >
          <span>
            <span className="block text-sm font-semibold text-ink">More details</span>
            <span className="block text-xs text-stone-500">
              Description, emoji, photo and other names
            </span>
          </span>
          <ChevronDown
            className={cn('size-4 shrink-0 transition-transform', more && 'rotate-180')}
          />
        </button>
        {more && (
          <div className="step-in mt-4 space-y-4">
            <div className="grid grid-cols-5 gap-4">
              <div className="col-span-4">
                <Field label="Description">
                  <input
                    className="input"
                    maxLength={500}
                    value={form.description}
                    placeholder="Our lunch favourite"
                    onChange={(e) => update({ description: e.target.value })}
                  />
                </Field>
              </div>
              <Field label="Emoji">
                <input
                  className="input px-1 text-center"
                  maxLength={16}
                  value={form.emoji}
                  onChange={(e) => update({ emoji: e.target.value })}
                />
              </Field>
            </div>
            <Field
              label="Photo link (optional)"
              hint="Shown on your menu page only. Paste a link that starts with https://."
            >
              <input
                className="input"
                type="url"
                maxLength={500}
                value={form.imageUrl}
                placeholder="https://…"
                onChange={(e) => update({ imageUrl: e.target.value })}
              />
            </Field>
            <Field
              label="Other names, separated by commas"
              hint="Optional: how customers may ask for it, such as “zinger meal” or “ڈیل 1”."
            >
              <input
                className="input"
                value={form.aliases}
                placeholder="zinger meal, lunch deal"
                onChange={(e) => update({ aliases: e.target.value })}
              />
            </Field>
          </div>
        )}
      </section>
      <label className="flex w-fit cursor-pointer items-center gap-2.5 text-sm font-medium text-stone-600">
        <input
          className="toggle"
          type="checkbox"
          checked={form.available}
          onChange={(e) => update({ available: e.target.checked })}
        />
        Deal is on (customers can order it)
      </label>
      <ErrorNotice message={error} />
      <div className="flex flex-wrap justify-end gap-2 border-t border-ink/[0.06] pt-5">
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
        <ActionButton
          type="submit"
          className="btn-primary"
          loading={pending === 'save'}
          loadingLabel="Saving…"
        >
          Save deal
          <Check className="size-4" />
        </ActionButton>
      </div>
    </form>
  );
}

function IncludeRow({
  item,
  index,
  products,
  active,
  canRemove,
  onFocus,
  onChange,
  onRemove,
}: {
  item: DealFormItem;
  index: number;
  products: Product[];
  active: boolean;
  canRemove: boolean;
  onFocus: () => void;
  onChange: (values: Partial<DealFormItem>) => void;
  onRemove: () => void;
}) {
  const product = item.productId ? products.find((p) => p.id === item.productId) : undefined;
  const broken = linkBroken(item, products);
  const matches = active && (!item.productId || broken) ? menuMatches(item.name, products) : [];
  const link = (next: Product) =>
    onChange({ productId: next.id, variantId: undefined, name: linkedName(next) });
  return (
    <div className="rounded-2xl border border-ink/[0.06] bg-white/60 p-3">
      <div className="flex items-start gap-2">
        <input
          className="input min-w-0 flex-1"
          aria-label={`Included item ${index + 1}`}
          placeholder={index ? 'Fries' : 'Zinger burger'}
          maxLength={100}
          value={item.name}
          onFocus={onFocus}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <input
          className="input w-16 shrink-0 px-2 text-center tabular-nums"
          aria-label={`How many of item ${index + 1}`}
          type="number"
          inputMode="numeric"
          min={1}
          max={50}
          required
          // An emptied box stays empty while a new number is typed; saving checks it.
          value={item.quantity || ''}
          onWheel={(e) => e.currentTarget.blur()}
          onChange={(e) => onChange({ quantity: Number(e.target.value) || 0 })}
        />
        {canRemove && (
          <button
            type="button"
            className="icon-btn shrink-0 hover:bg-red-600/10 hover:text-red-700"
            aria-label={`Remove ${item.name || `item ${index + 1}`}`}
            onClick={onRemove}
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      {broken && (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-sun/20 px-3 py-2 text-xs leading-relaxed text-stone-700">
          {item.name} is no longer on your menu — pick again or keep as text.
          <button
            type="button"
            className={textButton}
            onClick={() => onChange({ productId: undefined, variantId: undefined })}
          >
            Keep as text
          </button>
        </p>
      )}
      {product && !broken && (
        <div className="mt-2 space-y-2">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-500">
            <Link2 className="size-3.5 shrink-0 text-brand-600" aria-hidden />
            <span>
              Linked to <strong className="font-semibold text-ink">{product.name}</strong>
            </span>
            <button
              type="button"
              className={textButton}
              onClick={() => onChange({ productId: undefined, variantId: undefined })}
            >
              Unlink
            </button>
          </p>
          {product.variants.length > 0 && (
            <Field label="Size">
              <CustomSelect
                aria-label={`Size of ${item.name || product.name}`}
                placeholder="Choose a size"
                value={item.variantId ?? ''}
                onChange={(variantId) =>
                  onChange({
                    variantId,
                    // A name the owner hasn't changed follows the size: "Fries (Large)".
                    name:
                      item.name === linkedName(product, item.variantId)
                        ? linkedName(product, variantId)
                        : item.name,
                  })
                }
                options={product.variants.map((variant) => ({
                  value: variant.id,
                  label: `${variant.name} · ${money(variant.price)}`,
                }))}
              />
            </Field>
          )}
        </div>
      )}
      {matches.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Menu items">
          {matches.map((match) => (
            <button
              key={match.id}
              type="button"
              className={cn(chip, chipOff, 'px-3')}
              onClick={() => link(match)}
            >
              <span aria-hidden>{match.emoji || '🍽️'}</span>
              {match.name}
              {!match.available && <span className="font-medium text-stone-400">sold out</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ChoiceEditor({
  group,
  index,
  canCopy,
  onChange,
  onCopy,
  onRemove,
}: {
  group: DealFormChoice;
  index: number;
  canCopy: boolean;
  onChange: (group: DealFormChoice) => void;
  onCopy: () => void;
  onRemove: () => void;
}) {
  const [quick, setQuick] = useState('');
  const title = group.name.trim() || `Choice ${index + 1}`;
  const setOption = (id: string, values: Partial<DealFormChoice['options'][number]>) =>
    onChange({
      ...group,
      options: group.options.map((o) => (o.id === id ? { ...o, ...values } : o)),
    });
  const addQuick = () => {
    if (!quick.trim()) return;
    onChange({ ...group, options: optionsFromText(quick, group.options, newId) });
    setQuick('');
  };
  return (
    <div className="step-in rounded-2xl border border-ink/[0.05] bg-paper p-4 sm:p-5">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field label="Choice name">
            <input
              className="input"
              required
              maxLength={80}
              value={group.name}
              placeholder="Drink"
              onChange={(e) => onChange({ ...group, name: e.target.value })}
            />
          </Field>
        </div>
        <button
          type="button"
          className="icon-btn shrink-0 hover:bg-red-600/10 hover:text-red-700"
          aria-label={`Remove ${title}`}
          onClick={onRemove}
        >
          <Trash2 className="size-4" />
        </button>
      </div>
      <p className="mt-3 text-xs text-stone-500">
        Options, with an extra charge only if it costs more.
      </p>
      <div className="mt-2 space-y-2">
        {group.options.map((option, i) => (
          <div key={option.id} className="flex gap-2">
            <input
              className="input min-w-0 flex-1"
              aria-label={`${title} option ${i + 1}`}
              required
              maxLength={100}
              value={option.name}
              placeholder={['Coke', 'Sprite', 'Fanta'][i % 3]}
              onChange={(e) => setOption(option.id, { name: e.target.value })}
            />
            <input
              className="input w-20 shrink-0 tabular-nums sm:w-24"
              aria-label={`Extra charge for ${option.name || `option ${i + 1}`} in PKR`}
              type="number"
              inputMode="decimal"
              min="0"
              max="1000000"
              step="0.01"
              value={option.extra}
              placeholder="+0"
              onWheel={(e) => e.currentTarget.blur()}
              onChange={(e) => setOption(option.id, { extra: e.target.value })}
            />
            <button
              type="button"
              className="icon-btn shrink-0 hover:bg-red-600/10 hover:text-red-700"
              aria-label={`Remove ${option.name || `option ${i + 1}`}`}
              onClick={() =>
                onChange({ ...group, options: group.options.filter((o) => o.id !== option.id) })
              }
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
      {group.options.length < MAX_OPTIONS && (
        <div className="mt-3 flex gap-2">
          <input
            className="input min-w-0 flex-1"
            aria-label={`Options for ${title}, separated by commas`}
            placeholder="Options, separated by commas"
            value={quick}
            onChange={(e) => setQuick(e.target.value)}
            onKeyDown={(e) => {
              // Enter adds these options instead of saving the whole deal.
              if (e.key === 'Enter') {
                e.preventDefault();
                addQuick();
              }
            }}
          />
          <button type="button" className="btn shrink-0" onClick={addQuick}>
            Add
          </button>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1">
        {group.options.length < MAX_OPTIONS && (
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() =>
              onChange({
                ...group,
                options: [...group.options, { id: newId(), name: '', extra: '' }],
              })
            }
          >
            <Plus className="size-4" />
            Add option
          </button>
        )}
        {canCopy && (
          <button type="button" className="btn btn-quiet" onClick={onCopy}>
            <Copy className="size-4" />
            Copy this choice
          </button>
        )}
      </div>
    </div>
  );
}

function WhenPreview({ form, clock }: { form: DealForm; clock: LocalClock | undefined }) {
  const { data } = useWorkspace();
  const schedule = formSchedule(form);
  const night = isNightWindow(formWindow(form));
  const words = schedule?.days.length ? dealWhen(schedule, 'en', clock) : '';
  const long = longWindowNote(form);
  const notice = scheduleNotice(schedule, clock);
  const closed = openingWarning(schedule, data.company.openingHours);
  return (
    <div className="space-y-1.5 rounded-xl bg-white/80 px-3.5 py-3 text-xs leading-relaxed text-stone-600">
      <p>
        <strong className="font-semibold text-ink">Customers see:</strong>{' '}
        {words || (night ? 'choose at least one night' : 'choose at least one day')}
      </p>
      {runsText(form) && <p>{runsText(form)}</p>}
      {night && <p>A night counts as the date it starts on, for the start and end dates too.</p>}
      {[long, notice, closed].filter(Boolean).map((text) => (
        <p key={text} className="rounded-lg bg-sun/25 px-2.5 py-1.5 text-stone-700">
          {text}
        </p>
      ))}
      <p className="text-stone-500">Times are in {data.company.timezone}.</p>
    </div>
  );
}
