import { useRef, useState } from 'react';
import {
  Check,
  ChevronRight,
  Download,
  Edit3,
  FileSpreadsheet,
  ListFilter,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { Product, ProductOption } from '../shared/types';
import { money } from '../shared/types';
import { isPhotoUrl } from '../shared/menu';
import { useAction, useWorkspace } from '../lib/workspace';
import { cn, shortDate } from '../lib/utils';
import {
  ActionButton,
  Badge,
  ConfirmDialog,
  Empty,
  ErrorNotice,
  Field,
  Modal,
  PageHeading,
  Spinner,
} from './ui';
import { MenuLinkCard } from './MenuLinkCard';

/** The last non-empty value: a closing dialog keeps its title and content through its exit fade. */
function useLast<T>(value: T | null) {
  const [last, setLast] = useState(value);
  if (value && value !== last) setLast(value);
  return value || last;
}

export function Catalog() {
  const { data, mutate, navigate } = useWorkspace();
  const { pending, run } = useAction();
  const [category, setCategory] = useState('All items');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [removing, setRemoving] = useState<Product | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const shownEditing = useLast(editing);
  const shownRemoving = useLast(removing);
  const catalogProducts = data.products || [];
  const categories = [...new Set(catalogProducts.map((product) => product.category))];
  // A category whose last item was deleted or moved has no tab left: fall back to all items.
  const activeCategory = categories.includes(category) ? category : 'All items';
  const products = catalogProducts.filter(
    (p) =>
      (activeCategory === 'All items' || p.category === activeCategory) &&
      `${p.name || ''} ${p.description || ''} ${(p.aliases || []).join(' ')}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const editable = data.role !== 'staff' && data.company.catalogSource === 'app';
  return (
    <>
      <PageHeading
        title="Your menu"
        description="The source of truth for every price, option, and delicious possibility."
      >
        {data.company.catalogSource === 'sheets' ? (
          <ActionButton
            loading={pending === 'refresh'}
            loadingLabel="Refreshing…"
            onClick={() =>
              void run('refresh', () =>
                mutate('/catalog/refresh', {}, undefined, {
                  success: 'Menu refreshed from Google Sheets.',
                }),
              ).catch(() => undefined)
            }
          >
            <RefreshCw className="size-4" />
            Refresh from Sheets
          </ActionButton>
        ) : (
          editable && (
            <>
              <button className="btn" onClick={() => setImporting(true)}>
                <Upload className="size-4" />
                Import CSV
              </button>
              <button className="btn btn-primary" onClick={() => setEditing('new')}>
                <Plus className="size-4" />
                Add item
              </button>
            </>
          )
        )}
      </PageHeading>
      <MenuLinkCard />
      <div className="card mb-6 flex flex-wrap items-center justify-between gap-3 rounded-[22px] py-2.5 pr-2.5 pl-5 lg:rounded-full">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-stone-500">
          <span className="live-dot size-2 shrink-0 rounded-full bg-current text-success-500" />
          <span className="font-semibold text-ink tabular-nums">
            {catalogProducts.filter((p) => p.available).length} available
          </span>
          <span className="tabular-nums">of {catalogProducts.length} menu items</span>
          <span className="mx-1 text-stone-300">|</span>
          <span className="font-medium">
            Source: {data.company.catalogSource === 'app' ? 'Orderly menu' : 'Google Sheets'}
          </span>
        </div>
        <button
          className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[12.5px] font-semibold text-brand-700 transition-colors hover:bg-brand-500/10 hover:text-brand-800"
          onClick={() => navigate('settings')}
        >
          Manage source
          <ChevronRight className="size-3" />
        </button>
      </div>
      <p className="-mt-3 mb-4 pl-1 text-xs text-stone-500">
        Combos and time-limited offers live in{' '}
        <button
          className="inline-flex items-center font-semibold text-brand-700 underline-offset-4 transition-colors hover:text-brand-800 hover:underline max-md:min-h-11"
          onClick={() => navigate('deals')}
        >
          Deals
        </button>
        .
      </p>
      {data.company.catalogSyncedAt && (
        <p className="mb-4 pl-1 font-mono text-[11px] tracking-[0.02em] text-stone-500">
          Last catalog sync: {shortDate(data.company.catalogSyncedAt)}
        </p>
      )}
      <div className="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="tab-group flex-wrap">
          {['All items', ...categories].map((value) => (
            <button
              key={value}
              aria-pressed={activeCategory === value}
              className="tab-btn"
              onClick={() => setCategory(value)}
            >
              {value}
              <span className="ml-1.5 rounded-full bg-white/90 px-1.5 py-px text-[10.5px] font-semibold text-stone-600 tabular-nums">
                {value === 'All items'
                  ? data.products.length
                  : data.products.filter((p) => p.category === value).length}
              </span>
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-64 shrink-0">
          <Search className="pointer-events-none absolute left-3.5 top-2.5 size-4 text-stone-400" />
          <input
            ref={searchRef}
            aria-label="Search menu"
            className="input pl-9 pr-4"
            placeholder="Search menu…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      {products.length ? (
        <div className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {products.map((product) => (
            <article key={product.id} className="card group overflow-hidden">
              <div className="flex items-start gap-4 p-5 sm:p-6">
                <div
                  className={cn(
                    'flex size-16 shrink-0 -rotate-3 items-center justify-center rounded-2xl bg-paper text-[34px] shadow-[inset_0_1px_0_#fff,0_0_0_1px_rgb(14_6_4/0.05),0_10px_20px_-14px_rgb(14_6_4/0.45)] transition-transform duration-500 ease-[var(--ease-spring)] group-hover:rotate-6 group-hover:scale-110',
                    !product.available && 'opacity-60 grayscale',
                  )}
                  aria-hidden
                >
                  {product.emoji || '🍽️'}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="eyebrow">{product.category}</p>
                  <h2 className="mt-1.5 font-serif text-[23px] leading-[1.05] font-normal tracking-[-0.005em] text-ink">
                    {product.name}
                  </h2>
                  <p className="mt-2.5 inline-flex items-baseline rounded-full bg-brand-500/10 px-2.5 py-0.5 text-[13px] font-semibold text-brand-800 tabular-nums">
                    {money(product.price)}
                    {product.variants.length > 0 && (
                      <span className="ml-1 text-[11px] font-medium text-stone-500">base</span>
                    )}
                  </p>
                </div>
                {editable && (
                  <button
                    className="icon-btn -mt-2 -mr-2 size-8 hover:[&>svg]:animate-[wiggle_0.6s_ease-in-out]"
                    aria-label={`Edit ${product.name}`}
                    onClick={() => setEditing(product)}
                  >
                    <Edit3 className="size-3.5" />
                  </button>
                )}
              </div>
              <div className="px-5 pb-4">
                <p className="min-h-10 text-xs leading-5 text-stone-500">
                  {product.description || 'No description added yet.'}
                </p>
                {((product.variants?.length || 0) > 0 || (product.modifiers?.length || 0) > 0) && (
                  <p className="mt-3 inline-flex rounded-full bg-ink/[0.05] px-2.5 py-0.5 text-[11px] font-medium text-stone-600">
                    {[
                      product.variants?.length
                        ? `${product.variants.length} variant${product.variants.length === 1 ? '' : 's'}`
                        : '',
                      product.modifiers?.length
                        ? `${product.modifiers.length} extra${product.modifiers.length === 1 ? '' : 's'}`
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                )}
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-dashed border-ink/10 bg-paper/60 py-2.5 pr-3 pl-5">
                <Badge tone={product.available ? 'green' : 'neutral'}>
                  <span className="size-1.5 rounded-full bg-current" />
                  {product.available ? 'Available' : 'Sold out'}
                </Badge>
                {editable && (
                  <div className="flex items-center gap-1">
                    <button
                      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold text-stone-600 transition-colors hover:bg-brand-500/10 hover:text-brand-800 max-md:min-h-11 max-md:px-3"
                      aria-label={`${product.available ? 'Mark sold out' : 'Make available'}: ${product.name}`}
                      aria-busy={pending === `available-${product.id}` || undefined}
                      onClick={() =>
                        void run(`available-${product.id}`, () =>
                          mutate(
                            '/products',
                            { ...product, available: !product.available },
                            undefined,
                            {
                              success: product.available
                                ? `${product.name} marked sold out.`
                                : `${product.name} is available again.`,
                            },
                          ),
                        ).catch(() => undefined)
                      }
                    >
                      {pending === `available-${product.id}` && <Spinner className="size-3" />}
                      {product.available ? 'Mark sold out' : 'Make available'}
                    </button>
                    <button
                      className="inline-flex size-7 items-center justify-center rounded-full text-stone-400 transition-colors hover:bg-red-600/10 hover:text-red-700 max-md:size-11"
                      aria-label={`Delete ${product.name}`}
                      onClick={() => {
                        setRemoving(product);
                        setError('');
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="card">
          <Empty
            title={query ? 'No matching items' : 'A fresh page for your menu'}
            description={
              query
                ? 'No items match that search. Try a different name.'
                : 'Add your first item so the bot knows what’s cooking.'
            }
            action={query ? 'Clear search' : editable ? 'Add menu item' : 'Manage catalog source'}
            onAction={() => {
              if (query) {
                // The button disappears with the search: keep keyboard focus in the search box.
                setQuery('');
                searchRef.current?.focus();
              } else if (editable) setEditing('new');
              else navigate('settings');
            }}
          />
        </div>
      )}
      <Modal
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={shownEditing === 'new' ? 'Add a menu item' : 'Edit menu item'}
        description="Prices are in PKR. The bot always uses these values when calculating an order."
        wide
        // A stray tap on the backdrop must not throw away a half-filled item.
        dismissable={false}
      >
        {shownEditing && (
          <ProductEditor
            key={shownEditing === 'new' ? 'new' : shownEditing.id}
            product={shownEditing === 'new' ? undefined : shownEditing}
            onDone={() => setEditing(null)}
          />
        )}
      </Modal>
      <Modal
        open={importing}
        onOpenChange={setImporting}
        title="Import your menu"
        description="This replaces the entire menu. Items absent from the CSV will be removed. Keep stable item IDs when updating."
        wide
      >
        <CsvImport onDone={() => setImporting(false)} />
      </Modal>
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`Remove ${shownRemoving?.name || 'item'}?`}
        description="This item will be removed from the menu. Previously placed orders keep their original item details."
        busy={pending === 'delete'}
        busyLabel="Removing…"
        error={error}
        onConfirm={() => {
          const target = removing;
          if (!target) return;
          setError('');
          void run('delete', async () => {
            try {
              await mutate(`/products/${target.id}`, undefined, 'DELETE', {
                dialog: true,
                success: `${target.name} removed from the menu.`,
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

function ProductEditor({ product, onDone }: { product?: Product; onDone: () => void }) {
  const { data, mutate } = useWorkspace();
  const { pending, run } = useAction();
  const [name, setName] = useState(product?.name || '');
  const [description, setDescription] = useState(product?.description || '');
  const [category, setCategory] = useState(product?.category || 'Mains');
  // A new item starts empty, so a forgotten price is caught instead of saved as Rs. 0.
  const [price, setPrice] = useState(product ? String(product.price / 100) : '');
  const [emoji, setEmoji] = useState(product?.emoji || '🍽️');
  const [aliases, setAliases] = useState(product?.aliases ? product.aliases.join(', ') : '');
  const [available, setAvailable] = useState(product?.available ?? true);
  const [variants, setVariants] = useState<ProductOption[]>(product?.variants || []);
  const [modifiers, setModifiers] = useState<ProductOption[]>(product?.modifiers || []);
  const [imageUrl, setImageUrl] = useState(product?.imageUrl || '');
  const [error, setError] = useState('');
  const sharedAliases = aliases
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .filter((alias, index, values) => values.indexOf(alias) === index)
    .filter((alias) =>
      data.products.some(
        (item) =>
          item.id !== product?.id &&
          [item.name, ...item.aliases].some((value) => value.trim().toLowerCase() === alias),
      ),
    );
  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        setError('');
        if (!name.trim() || !category.trim()) {
          setError('Name and category cannot be blank.');
          return;
        }
        // A failed save shows inside this dialog (Modal), so no notification is needed.
        void run('save', async () => {
          await mutate(
            '/products',
            {
              ...product,
              companyId: data.company.id,
              name: name.trim(),
              description,
              category: category.trim(),
              price: Math.round(Number(price) * 100),
              emoji,
              aliases: aliases
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean),
              available,
              variants,
              modifiers,
              imageUrl: imageUrl.trim(),
            },
            undefined,
            { dialog: true, success: `${name.trim()} saved.` },
          );
          onDone();
        }).catch(() => undefined);
      }}
    >
      <div className="grid grid-cols-5 gap-4">
        <div className="col-span-4">
          <Field label="Item name">
            <input
              className="input"
              required
              maxLength={100}
              value={name}
              placeholder="Chicken biryani"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Emoji">
          <input
            className="input px-1 text-center"
            maxLength={10}
            value={emoji}
            onChange={(e) => setEmoji(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Description">
        <textarea
          className="input min-h-20 resize-y"
          maxLength={500}
          value={description}
          placeholder="What makes this one special?"
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <Field
        label="Photo link (optional)"
        hint="Shown on your menu page only. Paste a link that starts with https://."
      >
        <div className="flex items-center gap-3">
          <input
            className="input flex-1"
            type="url"
            maxLength={500}
            value={imageUrl}
            placeholder="https://…"
            onChange={(e) => setImageUrl(e.target.value)}
          />
          {isPhotoUrl(imageUrl.trim()) && (
            <img
              key={imageUrl.trim()}
              src={imageUrl.trim()}
              alt=""
              width={64}
              height={64}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              className="size-16 shrink-0 rounded-2xl bg-paper object-cover"
              onError={(e) => {
                e.currentTarget.hidden = true;
              }}
            />
          )}
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Category">
          <input
            className="input"
            required
            list="menu-categories"
            maxLength={80}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
          <datalist id="menu-categories">
            {[...new Set(data.products.map((p) => p.category))].map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
        <Field label="Base price (PKR)">
          <input
            className="input tabular-nums"
            required
            type="number"
            inputMode="decimal"
            min="0"
            max="1000000"
            step="0.01"
            value={price}
            // The wheel would step a focused price instead of scrolling the dialog.
            onWheel={(e) => e.currentTarget.blur()}
            onChange={(e) => setPrice(e.target.value)}
          />
        </Field>
      </div>
      <Field
        label="Other names, separated by commas"
        hint="Optional: add Urdu, Roman Urdu, or special local names. Common spelling mistakes are matched automatically."
      >
        <input
          className="input"
          value={aliases}
          placeholder="biryani, بریانی, chicken rice"
          onChange={(e) => setAliases(e.target.value)}
        />
        {sharedAliases.length > 0 && (
          <p className="step-in mt-2 rounded-xl bg-sun/20 px-3 py-2 text-xs leading-relaxed text-stone-700">
            Shared with another item: {sharedAliases.join(', ')}. The bot will ask the customer to
            choose instead of guessing.
          </p>
        )}
      </Field>
      <OptionEditor
        title="Variants"
        hint="Required choice, such as Regular or Large. Each price is the full item price and replaces the base price."
        value={variants}
        onChange={setVariants}
      />
      <OptionEditor
        title="Extras"
        hint="Optional additions. Each selected extra adds its price."
        value={modifiers}
        onChange={setModifiers}
      />
      <label className="flex w-fit cursor-pointer items-center gap-2.5 text-sm font-medium text-stone-600">
        <input
          className="toggle"
          type="checkbox"
          checked={available}
          onChange={(e) => setAvailable(e.target.checked)}
        />
        Available to order
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
          Save menu item
          <Check className="size-4" />
        </ActionButton>
      </div>
    </form>
  );
}

function OptionEditor({
  title,
  hint,
  value,
  onChange,
}: {
  title: string;
  hint: string;
  value: ProductOption[];
  onChange: (options: ProductOption[]) => void;
}) {
  return (
    <div className="rounded-2xl border border-ink/[0.05] bg-paper p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="eyebrow text-stone-700">{title}</p>
          <p className="mt-1.5 text-xs leading-relaxed text-stone-500">{hint}</p>
        </div>
        <button
          type="button"
          className="icon-btn size-8 bg-ink text-cream shadow-[0_8px_16px_-8px_rgb(14_6_4/0.6)] hover:bg-ink-soft hover:text-white"
          aria-label={`Add ${title.toLowerCase()}`}
          onClick={() => onChange([...value, { id: crypto.randomUUID(), name: '', price: 0 }])}
        >
          <Plus className="size-4" />
        </button>
      </div>
      {value.map((option, index) => (
        <div key={option.id} className="step-in mt-3 flex flex-wrap gap-2">
          <input
            className="input sm:flex-1"
            aria-label={`${title} ${index + 1} name`}
            placeholder="Option name"
            required
            value={option.name}
            onChange={(e) =>
              onChange(value.map((v) => (v.id === option.id ? { ...v, name: e.target.value } : v)))
            }
          />
          <OptionPrice
            label={`${title} ${index + 1} price in PKR`}
            // A row just added has no name yet: its price starts empty, so it has to be typed.
            initial={option.name ? String(option.price / 100) : ''}
            onChange={(price) =>
              onChange(value.map((v) => (v.id === option.id ? { ...v, price } : v)))
            }
          />
          <button
            type="button"
            className="icon-btn hover:bg-red-600/10 hover:text-red-700"
            aria-label={`Remove ${option.name || title}`}
            onClick={() => onChange(value.filter((v) => v.id !== option.id))}
          >
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Keeps the typed text, so a cleared price stays empty instead of snapping back to 0. */
function OptionPrice({
  label,
  initial,
  onChange,
}: {
  label: string;
  initial: string;
  onChange: (price: number) => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <input
      className="input w-28 tabular-nums"
      aria-label={label}
      type="number"
      inputMode="decimal"
      min="0"
      max="1000000"
      step="0.01"
      required
      value={text}
      onWheel={(e) => e.currentTarget.blur()}
      onChange={(e) => {
        setText(e.target.value);
        onChange(Math.round(Number(e.target.value) * 100));
      }}
    />
  );
}

/** The import confirmation: how much of the current menu the file replaces. */
export function replaceMenuWarning(currentItems: number) {
  return currentItems
    ? `This replaces your whole menu: the ${currentItems} ${currentItems === 1 ? 'item' : 'items'} on it now are removed unless they are in this CSV.`
    : 'This replaces the entire menu. Items absent from the CSV will be removed.';
}

function CsvImport({ onDone }: { onDone: () => void }) {
  const { data, mutate } = useWorkspace();
  // The example only fills an empty menu's import: on a live menu one more confirmation
  // would turn it into two sample dishes. The box's placeholder still shows the format.
  const menuEmpty = !data.products.length;
  const { pending, run } = useAction();
  const [csv, setCsv] = useState('');
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const sample =
    'id,name,description,category,price,available,emoji,aliases\nbiryani,Chicken Biryani,Fragrant rice with chicken,Mains,450,true,🍛,biryani\nraita,Raita,Cooling yogurt side,Sides,80,true,🥣,yogurt';
  return (
    <>
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          // Replacing the whole menu has no undo: ask first, as deleting one item does.
          setConfirmError('');
          setConfirming(true);
        }}
      >
        <label className="group block cursor-pointer rounded-2xl border-2 border-dashed border-ink/15 bg-paper p-6 text-center transition-colors hover:border-brand-500/45 hover:bg-brand-50/70">
          <Upload className="mx-auto mb-3 size-6 text-brand-600 transition-transform duration-300 ease-[var(--ease-spring)] group-hover:-translate-y-1" />
          <span className="block text-sm font-semibold text-ink">Choose a CSV file</span>
          <input
            aria-label="CSV menu file"
            className="mt-3 max-w-full text-xs text-stone-500 file:mr-3 file:cursor-pointer file:rounded-full file:border-0 file:bg-ink file:px-4 file:py-2 file:font-semibold file:text-cream"
            type="file"
            accept=".csv,text/csv"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) {
                if (file.size > 500_000) {
                  setError('Please choose a CSV smaller than 500 KB.');
                  return;
                }
                setCsv(await file.text());
              }
            }}
          />
        </label>
        <Field
          label="CSV contents"
          hint="Prices use rupees. Optional variants and modifiers columns accept JSON arrays with id, name, and price in rupees. Variant prices replace the base; extras are added."
        >
          <textarea
            className="input min-h-44 font-mono text-xs"
            value={csv}
            required
            placeholder={sample}
            onChange={(e) => setCsv(e.target.value)}
          />
        </Field>
        {menuEmpty && (
          <button
            type="button"
            className="mr-4 text-xs font-semibold text-brand-700 underline-offset-4 transition-colors hover:text-brand-800 hover:underline"
            onClick={() => setCsv(sample)}
          >
            Use example CSV
          </button>
        )}
        <a
          href="/examples/menu.csv"
          download
          className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 underline-offset-4 transition-colors hover:text-brand-800 hover:underline"
        >
          <Download className="size-3" />
          Download template
        </a>
        <ErrorNotice message={error} />
        <div className="flex justify-end gap-2 border-t border-ink/[0.06] pt-5">
          <button type="button" className="btn" onClick={onDone}>
            Cancel
          </button>
          <ActionButton
            type="submit"
            className="btn-primary"
            disabled={!csv.trim()}
            loading={pending === 'import'}
            loadingLabel="Importing…"
          >
            Import menu
            <Upload className="size-4" />
          </ActionButton>
        </div>
      </form>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Replace your menu?"
        description={replaceMenuWarning(data.products.length)}
        confirmLabel="Replace menu"
        tone="danger"
        busy={pending === 'import'}
        busyLabel="Importing…"
        error={confirmError}
        onConfirm={() => {
          setConfirmError('');
          // A failure shows inside this confirmation, so no notification is needed.
          void run('import', async () => {
            try {
              await mutate('/catalog/import', { csv }, undefined, {
                dialog: true,
                success: 'Menu imported.',
              });
              setConfirming(false);
              onDone();
            } catch (e) {
              setConfirmError((e as Error).message);
            }
          });
        }}
      />
    </>
  );
}
