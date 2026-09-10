import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ArrowRight,
  BookOpen,
  Building2,
  Cable,
  ChevronDown,
  CircleHelp,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Menu as MenuIcon,
  MessageCircle,
  MessageSquare,
  Plus,
  Settings2,
  ShoppingBag,
  X,
} from 'lucide-react';
import type { Bootstrap } from './shared/types';
import { api, setAccessToken } from './lib/api';
import { cn, initials, label } from './lib/utils';
import { Workspace, type Page } from './lib/workspace';
import { ErrorNotice, Field, Modal } from './components/ui';
import { Overview, Orders } from './components/Orders';
import { Catalog } from './components/Catalog';
import { Inbox, Playground } from './components/Conversations';
import { Businesses, Integrations, Settings } from './components/Settings';

const navigation = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'orders', label: 'Orders', icon: ShoppingBag },
  { id: 'inbox', label: 'Inbox', icon: MessageSquare },
  { id: 'menu', label: 'Menu', icon: BookOpen },
  { id: 'playground', label: 'Test your bot', icon: FlaskConical },
] as const;
const manage = [
  { id: 'integrations', label: 'Integrations', icon: Cable },
  { id: 'settings', label: 'Settings', icon: Settings2 },
  { id: 'businesses', label: 'Businesses', icon: Building2 },
] as const;
type Configuration = { mode: 'demo' | 'live'; supabaseUrl?: string; supabaseAnonKey?: string };

export default function App() {
  const [config, setConfig] = useState<Configuration | null>(null);
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [companyId, setCompanyId] = useState(() => localStorage.getItem('orderly.company') || '');
  const [data, setData] = useState<Bootstrap | null>(null);
  const [page, setPage] = useState<Page>('overview');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [help, setHelp] = useState(false);
  const [firstBusiness, setFirstBusiness] = useState(false);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    api<Configuration>('/config')
      .then(async (result) => {
        if (!active) return;
        setConfig(result);
        if (result.mode === 'demo') {
          setAuthenticated(true);
          return;
        }
        if (!result.supabaseUrl || !result.supabaseAnonKey)
          throw new Error('Supabase authentication is not configured on this server.');
        const { createClient } = await import('@supabase/supabase-js');
        const auth = createClient(result.supabaseUrl, result.supabaseAnonKey);
        setClient(auth);
        const session = await auth.auth.getSession();
        if (!active) return;
        setAccessToken(session.data.session?.access_token);
        setAuthenticated(Boolean(session.data.session));
        const { data: subscription } = auth.auth.onAuthStateChange((_event, value) => {
          setAccessToken(value?.access_token);
          setAuthenticated(Boolean(value));
          if (!value) setData(null);
        });
        unsubscribe = () => subscription.subscription.unsubscribe();
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  const refresh = useCallback(async () => {
    const result = await api<Bootstrap>(
      `/bootstrap${companyId ? `?companyId=${encodeURIComponent(companyId)}` : ''}`,
      companyId,
    );
    setData((current) => (current?.company.id === result.company.id ? result : current));
    localStorage.setItem('orderly.company', result.company.id);
  }, [companyId]);

  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    setError('');
    api<Bootstrap>(
      `/bootstrap${companyId ? `?companyId=${encodeURIComponent(companyId)}` : ''}`,
      companyId,
    )
      .then((result) => {
        if (active) {
          setData(result);
          localStorage.setItem('orderly.company', result.company.id);
        }
      })
      .catch((e) => {
        if (active) {
          if (companyId) {
            localStorage.removeItem('orderly.company');
            setCompanyId('');
          } else {
            setError(e.message);
            void api<{ isAdmin: boolean; companyCount: number }>('/account')
              .then((account) => {
                if (active && account.isAdmin && account.companyCount === 0) setFirstBusiness(true);
              })
              .catch(() => {});
          }
        }
      });
    return () => {
      active = false;
    };
  }, [authenticated, companyId]);

  useEffect(() => {
    if (!authenticated || !data || !['overview', 'orders', 'inbox'].includes(page)) return;
    const timer = setInterval(() => {
      if (!document.hidden && !busy) void refresh().catch(() => {});
    }, 15000);
    return () => clearInterval(timer);
  }, [authenticated, !!data, page, busy, refresh]);

  const mutate = useCallback(
    async <T,>(path: string, body?: unknown, method?: string): Promise<T> => {
      setBusy(true);
      setError('');
      try {
        const result = await api<T>(path, data?.company.id || companyId, body, method);
        await refresh();
        return result;
      } catch (e) {
        setError((e as Error).message);
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [data?.company.id, companyId, refresh],
  );

  function switchCompany(id: string) {
    if (id === data?.company.id) return;
    setData(null);
    setError('');
    setCompanyId(id);
    setMobile(false);
  }
  function navigate(value: Page) {
    setPage(value);
    setMobile(false);
    setError('');
    window.scrollTo(0, 0);
  }

  if (config?.mode === 'live' && !authenticated && client) return <Login client={client} />;
  if (!data && firstBusiness)
    return (
      <FirstBusiness
        onCreated={(id) => {
          setFirstBusiness(false);
          setError('');
          setCompanyId(id);
        }}
      />
    );
  if (!data)
    return (
      <div className="grid min-h-dvh place-items-center p-6">
        <div className="w-full max-w-md">
          <Brand dark={false} />
          <div className="mt-8 space-y-4">
            <div className="h-8 w-2/3 rounded-lg bg-stone-200" />
            <div className="h-32 rounded-xl bg-stone-100" />
            <p className="text-sm text-stone-500">Opening your workspace…</p>
            <ErrorNotice message={error} />
            {error && (
              <button className="btn" onClick={() => window.location.reload()}>
                Try again
              </button>
            )}
          </div>
        </div>
      </div>
    );
  const pending = data.orders.filter((o) => o.status === 'pending').length;
  const sidebar = (
    <div className="flex h-full flex-col bg-stone-900 px-4 pb-5 pt-7 text-stone-400">
      <div className="px-3">
        <Brand />
      </div>
      <div className="mb-7 mt-9 rounded-lg border border-stone-700 px-3 py-3">
        <p className="text-xs text-stone-500">YOUR WORKSPACE</p>
        <p className="mt-1 truncate text-sm font-medium text-stone-100">{data.company.name}</p>
      </div>
      <nav aria-label="Main navigation" className="space-y-1">
        {navigation.map((item) => (
          <button
            key={item.id}
            aria-current={page === item.id ? 'page' : undefined}
            className={cn(
              'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm',
              page === item.id
                ? 'bg-emerald-900 text-emerald-50'
                : 'hover:bg-stone-800 hover:text-white',
            )}
            onClick={() => navigate(item.id)}
          >
            <item.icon className="size-4.5" />
            {item.label}
            {item.id === 'orders' && pending > 0 && (
              <span className="ml-auto rounded bg-stone-700 px-1.5 py-0.5 text-xs tabular-nums text-stone-100">
                {pending}
              </span>
            )}
            {item.id === 'playground' && (
              <span className="ml-auto size-1.5 rounded-full bg-emerald-500" />
            )}
          </button>
        ))}
      </nav>
      <p className="mb-3 mt-8 px-3 text-xs text-stone-500">MANAGE</p>
      <nav aria-label="Workspace management" className="space-y-1">
        {manage.map((item) => (
          <button
            key={item.id}
            aria-current={page === item.id ? 'page' : undefined}
            className={cn(
              'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm',
              page === item.id
                ? 'bg-emerald-900 text-emerald-50'
                : 'hover:bg-stone-800 hover:text-white',
            )}
            onClick={() => navigate(item.id)}
          >
            <item.icon className="size-4.5" />
            {item.label}
          </button>
        ))}
      </nav>
      <div className="mt-auto pt-12">
        <div className="rounded-xl border border-stone-700 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-stone-100">
            <MessageCircle className="size-4 text-emerald-400" />
            Made for the conversation.
          </div>
          <p className="text-xs leading-relaxed text-stone-400">
            Your menu. Your customers.
            <br />
            One less thing on your plate.
          </p>
        </div>
        <button
          className="mt-4 flex min-h-10 w-full items-center gap-3 px-3 text-sm hover:text-white"
          onClick={() => setHelp(true)}
        >
          <CircleHelp className="size-4" />
          Getting started
          <ArrowRight className="ml-auto size-4" />
        </button>
      </div>
    </div>
  );

  return (
    <Workspace.Provider
      value={{
        data,
        busy,
        error,
        clearError: () => setError(''),
        page,
        navigate,
        switchCompany,
        refresh,
        mutate,
      }}
    >
      <div className="min-h-dvh bg-stone-50">
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 lg:block">{sidebar}</aside>
        {mobile && (
          <Modal open={mobile} onOpenChange={setMobile} title="Navigate workspace">
            <div className="-mx-6 -mb-6 h-[70dvh]">{sidebar}</div>
          </Modal>
        )}
        <div className="lg:pl-60">
          <header className="flex min-h-20 items-center justify-between gap-4 border-b border-stone-200 bg-white px-5 sm:px-8 lg:px-10">
            <div className="flex min-w-0 items-center gap-3">
              <button
                className="icon-btn lg:hidden"
                aria-label="Open navigation"
                onClick={() => setMobile(true)}
              >
                <MenuIcon className="size-5" />
              </button>
              <span className="hidden text-sm text-stone-400 sm:block">Workspace</span>
              <span className="hidden text-stone-300 sm:block">/</span>
              <span className="truncate text-sm font-medium">
                {[...navigation, ...manage].find((n) => n.id === page)?.label}
              </span>
            </div>
            <div className="flex items-center gap-3 sm:gap-5">
              <div className="relative">
                <label className="sr-only" htmlFor="company-switch">
                  Current business
                </label>
                <select
                  id="company-switch"
                  className="max-w-40 appearance-none rounded-lg bg-stone-50 py-2 pl-3 pr-8 text-xs font-medium sm:max-w-56 sm:text-sm"
                  value={data.company.id}
                  disabled={busy}
                  onChange={(e) => switchCompany(e.target.value)}
                >
                  {data.companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-2.5 size-4 text-stone-400" />
              </div>
              <div className="h-6 w-px bg-stone-200" />
              <div className="flex items-center gap-2">
                <div className="flex size-9 items-center justify-center rounded-full bg-stone-200 text-xs font-semibold">
                  {initials(data.company.name)}
                </div>
                <div className="hidden text-xs xl:block">
                  <p className="font-semibold text-stone-700">{label(data.role)}</p>
                  <p className="mt-0.5 text-stone-400">
                    {data.mode === 'demo' ? 'Demo workspace' : 'Team workspace'}
                  </p>
                </div>
                {client && (
                  <button
                    className="icon-btn"
                    aria-label="Sign out"
                    onClick={() => void client.auth.signOut()}
                  >
                    <LogOut className="size-4" />
                  </button>
                )}
              </div>
            </div>
          </header>
          {data.mode === 'demo' && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 bg-stone-100 px-5 py-2.5 text-xs text-stone-500 sm:px-8 lg:px-10">
              <span>
                <span className="font-semibold text-stone-600">Sample workspace</span>
                <span className="mx-2">·</span>Changes saved on this local server. No real messages
                are sent.
              </span>
              <button
                className="font-medium text-emerald-800 hover:underline"
                onClick={() => navigate('playground')}
              >
                Try an order <span aria-hidden>↗</span>
              </button>
            </div>
          )}
          <main id="main" className="mx-auto max-w-7xl px-5 py-7 sm:px-8 lg:px-10 lg:py-9">
            <div className="mb-4 empty:hidden">
              <ErrorNotice message={error} onDismiss={() => setError('')} />
            </div>
            <div key={data.company.id}>
              {page === 'overview' && <Overview />}
              {page === 'orders' && <Orders />}
              {page === 'menu' && <Catalog />}
              {page === 'inbox' && <Inbox />}
              {page === 'playground' && <Playground />}
              {page === 'integrations' && <Integrations />}
              {page === 'settings' && <Settings />}
              {page === 'businesses' && <Businesses />}
            </div>
            <footer className="mt-10 flex flex-wrap justify-between gap-2 border-t border-stone-200 pt-5 text-xs text-stone-400">
              <span>Orderly · Conversations to orders</span>
              <span>
                {data.company.currency} · {data.company.timezone}
              </span>
            </footer>
          </main>
        </div>
      </div>
      <Modal
        open={help}
        onOpenChange={setHelp}
        title="Your first order, in a few steps"
        description="Get familiar with your workspace before connecting a real WhatsApp number."
      >
        <ol className="space-y-5 text-sm text-stone-600">
          {[
            ['Make the menu yours', 'Add your items, prices, options, and delivery areas.'],
            [
              'Try the conversation',
              'Use Test your bot to browse, build a cart, and confirm an order.',
            ],
            [
              'Run your restaurant',
              'Accept the order in Orders. Switch businesses to check isolation.',
            ],
            [
              'Connect when ready',
              'Add your model, Google Sheets, and Meta credentials in Integrations. Live setup requires server configuration.',
            ],
          ].map(([title, copy], index) => (
            <li key={title} className="flex gap-3">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-xs font-semibold text-emerald-800">
                {index + 1}
              </span>
              <div>
                <p className="font-semibold text-stone-800">{title}</p>
                <p className="mt-1 leading-relaxed">{copy}</p>
              </div>
            </li>
          ))}
        </ol>
        <button
          className="btn btn-primary mt-7 w-full"
          onClick={() => {
            setHelp(false);
            navigate('playground');
          }}
        >
          Try your bot
          <ArrowRight className="size-4" />
        </button>
      </Modal>
    </Workspace.Provider>
  );
}

function Brand({ dark = true }: { dark?: boolean }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 text-2xl font-semibold',
        dark ? 'text-white' : 'text-stone-900',
      )}
    >
      <span className="relative flex size-8 items-center justify-center rounded-lg bg-emerald-500 text-stone-950">
        <MessageCircle className="size-5" strokeWidth={2.5} />
        <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-white" />
      </span>
      orderly<span className="self-end pb-1 text-emerald-500">.</span>
    </div>
  );
}

function FirstBusiness({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid min-h-dvh place-items-center px-5">
      <div className="w-full max-w-md">
        <Brand dark={false} />
        <form
          className="card mt-8 space-y-5 p-7"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              const company = await api<{ id: string }>('/companies', '', { name });
              onCreated(company.id);
            } catch (reason) {
              setError((reason as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h1 className="text-2xl font-semibold">Add your first business.</h1>
          <p className="text-sm text-stone-500">
            Your administrator account is ready. Create an empty workspace to begin.
          </p>
          <Field label="Business name">
            <input
              className="input"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <ErrorNotice message={error} />
          <button className="btn btn-primary w-full" disabled={busy}>
            Create workspace
            <Plus className="size-4" />
          </button>
        </form>
      </div>
    </div>
  );
}

function Login({ client }: { client: SupabaseClient }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid min-h-dvh place-items-center bg-stone-100 px-5">
      <div className="w-full max-w-md">
        <Brand dark={false} />
        <div className="card mt-8 p-8">
          <h1 className="text-2xl font-semibold">Welcome back.</h1>
          <p className="mb-7 mt-2 text-sm text-stone-500">Sign in to your restaurant workspace.</p>
          <form
            className="space-y-5"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              try {
                const result = await client.auth.signInWithPassword({ email, password });
                if (result.error) throw result.error;
              } catch (reason) {
                setError((reason as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Email address">
              <input
                className="input"
                type="email"
                value={email}
                required
                autoComplete="username"
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Password">
              <input
                className="input"
                type="password"
                value={password}
                required
                autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <ErrorNotice message={error} />
            <button className="btn btn-primary w-full" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
              <ArrowRight className="size-4" />
            </button>
          </form>
          <p className="mt-5 text-xs leading-relaxed text-stone-500">
            Workspace access is managed by your administrator. Contact them if you need an account
            or password reset.
          </p>
        </div>
      </div>
    </div>
  );
}
