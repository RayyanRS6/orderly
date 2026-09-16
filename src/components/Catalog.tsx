import { useState } from 'react';
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
import { useWorkspace } from '../lib/workspace';
import { cn, shortDate } from '../lib/utils';
import { Badge, ConfirmDialog, Empty, ErrorNotice, Field, Modal, PageHeading } from './ui';

export function Catalog() {
  const { data, mutate, busy, navigate } = useWorkspace();
  const [category, setCategory] = useState('All items');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [removing, setRemoving] = useState<Product | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const catalogProducts = data.products || [];
  const categories = [...new Set(catalogProducts.map((product) => product.category))];
  const products = catalogProducts.filter(
    (p) =>
      (category === 'All items' || p.category === category) &&
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
          <button
            className="btn rounded-full shadow-xs"
            disabled={busy}
            onClick={() => void mutate('/catalog/refresh', {}).catch(() => {})}
          >
            <RefreshCw className="size-4" />
            Refresh from Sheets
          </button>
        ) : (
          editable && (
            <>
              <button className="btn rounded-full shadow-xs" onClick={() => setImporting(true)}>
                <Upload className="size-4" />
                Import CSV
              </button>
              <button
                className="btn btn-primary rounded-full shadow-xs"
                onClick={() => setEditing('new')}
              >
                <Plus className="size-4" />
                Add item
              </button>
            </>
          )
        )}
      </PageHeading>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-stone-200/80 bg-white px-5 py-3.5 shadow-2xs">
        <div className="flex items-center gap-2.5 text-xs text-stone-500">
          <span className="size-2 rounded-full bg-emerald-600 shadow-[0_0_6px_rgba(5,150,105,0.4)]" />
          <span className="font-bold text-stone-800">
            {catalogProducts.filter((p) => p.available).length} available
          </span>
          <span>of {catalogProducts.length} menu items</span>
          <span className="mx-1 text-stone-300">|</span>
          <span className="font-medium">
            Source: {data.company.catalogSource === 'app' ? 'Orderly menu' : 'Google Sheets'}
          </span>
        </div>
        <button
          className="inline-flex items-center gap-1 text-xs font-bold text-emerald-800 hover:text-emerald-950 transition-colors"
          onClick={() => navigate('settings')}
        >
          Manage source
          <ChevronRight className="size-3" />
        </button>
      </div>
      {data.company.catalogSyncedAt && (
        <p className="mb-4 text-xs text-stone-400 font-medium">
          Last catalog sync: {shortDate(data.company.catalogSyncedAt)}
        </p>
      )}
      <div className="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="inline-flex flex-wrap items-center gap-1 rounded-full bg-stone-100/90 p-1 border border-stone-200/70 shadow-2xs">
          {['All items', ...categories].map((value) => (
            <button
              key={value}
              aria-pressed={category === value}
              className={cn(
                'rounded-full px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap transition-all',
                category === value
                  ? 'bg-emerald-800 text-white shadow-xs'
                  : 'text-stone-600 hover:text-stone-900 hover:bg-white/60',
              )}
              onClick={() => setCategory(value)}
            >
              {value}
              <span className="ml-1.5 opacity-80 tabular-nums">
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
            aria-label="Search menu"
            className="input rounded-full pl-9 pr-4 py-1.5 text-xs sm:text-sm bg-stone-50/80 focus:bg-white"
            placeholder="Search menu…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      {products.length ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {products.map((product) => (
            <article
              key={product.id}
              className="card overflow-hidden rounded-3xl border border-stone-200/80 bg-white shadow-xs hover:border-stone-300/90 hover:shadow-sm transition-all"
            >
              <div className="flex items-start gap-4 p-5 sm:p-6">
                <div
                  className={cn(
                    'flex size-16 shrink-0 items-center justify-center rounded-2xl bg-stone-100 text-3xl shadow-2xs',
                    !product.available && 'grayscale',
                  )}
                  aria-hidden
                >
                  {product.emoji || '🍽️'}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-stone-400">{product.category}</p>
                  <h2 className="mt-1 text-sm font-semibold">{product.name}</h2>
                  <p className="mt-2 text-sm font-semibold tabular-nums text-emerald-800">
                    {money(product.price)}
                    {product.variants.length > 0 && (
                      <span className="ml-1 text-xs font-normal text-stone-400">base</span>
                    )}
                  </p>
                </div>
                {editable && (
                  <button
                    className="icon-btn -mr-2 -mt-2 size-8"
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
                  <p className="mt-3 text-xs text-stone-400">
                    {[
                      product.variants?.length ? `${product.variants.length} variants` : '',
                      product.modifiers?.length ? `${product.modifiers.length} extras` : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                )}
              </div>
              <div className="flex items-center justify-between border-t border-stone-100 bg-stone-50 px-5 py-3">
                <Badge tone={product.available ? 'green' : 'neutral'}>
                  <span className="size-1.5 rounded-full bg-current" />
                  {product.available ? 'Available' : 'Sold out'}
                </Badge>
                {editable && (
                  <div className="flex items-center gap-3">
                    <button
                      className="text-xs font-medium text-stone-500 hover:text-emerald-800"
                      disabled={busy}
                      onClick={() =>
                        void mutate('/products', {
                          ...product,
                          available: !product.available,
                        }).catch(() => {})
                      }
                    >
                      {product.available ? 'Mark sold out' : 'Make available'}
                    </button>
                    <button
                      className="text-stone-400 hover:text-red-700"
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
            title="A fresh page for your menu"
            description={
              query
                ? 'No items match that search. Try a different name.'
                : 'Add your first item so the bot knows what’s cooking.'
            }
            action={query ? 'Clear search' : editable ? 'Add menu item' : 'Manage catalog source'}
            onAction={() =>
              query ? setQuery('') : editable ? setEditing('new') : navigate('settings')
            }
          />
        </div>
      )}
      <Modal
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={editing === 'new' ? 'Add a menu item' : 'Edit menu item'}
        description="Prices are in PKR. The bot always uses these values when calculating an order."
        wide
      >
        {editing && (
          <ProductEditor
            key={editing === 'new' ? 'new' : editing.id}
            product={editing === 'new' ? undefined : editing}
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
        title={`Remove ${removing?.name || 'item'}?`}
        description={
          error ||
          'This item will be removed from the menu. Previously placed orders keep their original item details.'
        }
        busy={busy}
        onConfirm={async () => {
          try {
            await mutate(`/products/${removing!.id}`, undefined, 'DELETE');
            setRemoving(null);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      />
    </>
  );
}

function ProductEditor({ product, onDone }: { product?: Product; onDone: () => void }) {
  const { data, mutate, busy } = useWorkspace();
  const [name, setName] = useState(product?.name || '');
  const [description, setDescription] = useState(product?.description || '');
  const [category, setCategory] = useState(product?.category || 'Mains');
  const [price, setPrice] = useState(String((product?.price || 0) / 100));
  const [emoji, setEmoji] = useState(product?.emoji || '🍽️');
  const [aliases, setAliases] = useState(
    product?.aliases ? product.aliases.join(', ') : '',
  );
  const [available, setAvailable] = useState(product?.available ?? true);
  const [variants, setVariants] = useState<ProductOption[]>(product?.variants || []);
  const [modifiers, setModifiers] = useState<ProductOption[]>(product?.modifiers || []);
  const [error, setError] = useState('');
  return (
    <form
      className="space-y-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setError('');
        try {
          if (!name.trim() || !category.trim())
            throw new Error('Name and category cannot be blank.');
          await mutate('/products', {
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
          });
          onDone();
        } catch (e) {
          setError((e as Error).message);
        }
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
            className="input text-center"
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
            min="0"
            max="1000000"
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </Field>
      </div>
      <Field
        label="Other names, separated by commas"
        hint="Add Urdu and Roman Urdu names to help the bot recognize this item."
      >
        <input
          className="input"
          value={aliases}
          placeholder="biryani, بریانی, chicken rice"
          onChange={(e) => setAliases(e.target.value)}
        />
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
      <label className="flex items-center gap-2 text-sm text-stone-600">
        <input
          className="size-4 accent-emerald-800"
          type="checkbox"
          checked={available}
          onChange={(e) => setAvailable(e.target.checked)}
        />
        Available to order
      </label>
      <ErrorNotice message={error} />
      <div className="flex justify-end gap-2 border-t border-stone-100 pt-5">
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save menu item'}
          <Check className="size-4" />
        </button>
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
    <div className="rounded-2xl border border-stone-200/80 bg-stone-50/40 p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold">{title}</p>
          <p className="mt-1 text-xs text-stone-500">{hint}</p>
        </div>
        <button
          type="button"
          className="icon-btn size-8"
          aria-label={`Add ${title.toLowerCase()}`}
          onClick={() => onChange([...value, { id: crypto.randomUUID(), name: '', price: 0 }])}
        >
          <Plus className="size-4" />
        </button>
      </div>
      {value.map((option, index) => (
        <div key={option.id} className="mt-3 flex gap-2">
          <input
            className="input flex-1"
            aria-label={`${title} ${index + 1} name`}
            placeholder="Option name"
            required
            value={option.name}
            onChange={(e) =>
              onChange(value.map((v) => (v.id === option.id ? { ...v, name: e.target.value } : v)))
            }
          />
          <input
            className="input w-28 tabular-nums"
            aria-label={`${title} ${index + 1} price in PKR`}
            type="number"
            min="0"
            max="1000000"
            step="0.01"
            required
            value={option.price / 100}
            onChange={(e) =>
              onChange(
                value.map((v) =>
                  v.id === option.id
                    ? { ...v, price: Math.round(Number(e.target.value) * 100) }
                    : v,
                ),
              )
            }
          />
          <button
            type="button"
            className="icon-btn"
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

function CsvImport({ onDone }: { onDone: () => void }) {
  const { mutate, busy } = useWorkspace();
  const [csv, setCsv] = useState('');
  const [error, setError] = useState('');
  const sample =
    'id,name,description,category,price,available,emoji,aliases\nbiryani,Chicken Biryani,Fragrant rice with chicken,Mains,450,true,🍛,biryani\nraita,Raita,Cooling yogurt side,Sides,80,true,🥣,yogurt';
  return (
    <form
      className="space-y-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setError('');
        try {
          await mutate('/catalog/import', { csv });
          onDone();
        } catch (e) {
          setError((e as Error).message);
        }
      }}
    >
      <label className="block rounded-xl border border-dashed border-stone-300 bg-stone-50 p-6 text-center">
        <Upload className="mx-auto mb-3 size-6 text-stone-400" />
        <span className="block text-sm font-medium">Choose a CSV file</span>
        <input
          aria-label="CSV menu file"
          className="mt-3 max-w-full text-xs text-stone-500 file:mr-3 file:rounded file:border-0 file:bg-stone-200 file:px-3 file:py-2"
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
      <button
        type="button"
        className="text-xs font-medium text-emerald-800 hover:underline"
        onClick={() => setCsv(sample)}
      >
        Use example CSV
      </button>
      <a
        href="/examples/menu.csv"
        download
        className="ml-4 inline-flex items-center gap-1 text-xs font-medium text-emerald-800 hover:underline"
      >
        <Download className="size-3" />
        Download template
      </a>
      <ErrorNotice message={error} />
      <div className="flex justify-end gap-2 border-t border-stone-100 pt-5">
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy || !csv.trim()}>
          {busy ? 'Importing…' : 'Import menu'}
          <Upload className="size-4" />
        </button>
      </div>
    </form>
  );
}
