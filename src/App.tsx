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
  Search,
  Settings2,
  ShoppingBag,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import type { Bootstrap } from './shared/types';
import { api, setAccessToken } from './lib/api';
import { cn, initials, label } from './lib/utils';
import { Workspace, type Page } from './lib/workspace';
import { CustomSelect, ErrorNotice, Field, Modal } from './components/ui';
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

function getStoredCompany(): string {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem('orderly.company') || '';
    }
  } catch {}
  return '';
}

function setStoredCompany(id: string) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('orderly.company', id);
    }
  } catch {}
}

function removeStoredCompany() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('orderly.company');
    }
  } catch {}
}

export default function App() {
  const [config, setConfig] = useState<Configuration | null>(null);
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [companyId, setCompanyId] = useState(getStoredCompany);
  const [data, setData] = useState<Bootstrap | null>(null);
  const [page, setPage] = useState<Page>('overview');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [help, setHelp] = useState(false);
  const [firstBusiness, setFirstBusiness] = useState(false);
  const [navSearch, setNavSearch] = useState('');

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
    setStoredCompany(result.company.id);
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
          setStoredCompany(result.company.id);
        }
      })
      .catch((e) => {
        if (active) {
          if (companyId) {
            removeStoredCompany();
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

  const filteredNav = navigation.filter((item) =>
    item.label.toLowerCase().includes(navSearch.toLowerCase()),
  );
  const filteredManage = manage.filter((item) =>
    item.label.toLowerCase().includes(navSearch.toLowerCase()),
  );

  const handleNavClick = (id: Page) => {
    navigate(id);
    setMobile(false);
  };

  const sidebar = (
    <div className="flex h-full flex-col overflow-hidden bg-[#121417] px-4 pb-5 pt-6 text-stone-400 border-r border-white/5">
      <div className="shrink-0">
        <div className="px-2 shrink-0">
          <Brand />
        </div>

        <div className="mt-5 px-1 flex items-center gap-2 shrink-0">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-stone-500" />
            <input
              type="text"
              aria-label="Search navigation"
              value={navSearch}
              onChange={(e) => setNavSearch(e.target.value)}
              placeholder="Search..."
              className="h-9 w-full rounded-full border border-white/10 bg-white/[0.05] pl-9 pr-7 text-xs text-stone-200 placeholder:text-stone-500 transition-all focus:border-emerald-500 focus:bg-white/[0.08] focus:outline-none"
            />
            {navSearch && (
              <button
                type="button"
                className="absolute right-2.5 top-2.5 text-stone-400 hover:text-white"
                onClick={() => setNavSearch('')}
                aria-label="Clear search"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <button
            type="button"
            className="flex size-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.05] text-stone-400 hover:bg-white/10 hover:text-white transition-all"
            title="Getting started"
            aria-label="Getting started"
            onClick={() => {
              setHelp(true);
              setMobile(false);
            }}
          >
            <SlidersHorizontal className="size-3.5" />
          </button>
        </div>

        <div className="my-5 rounded-2xl border border-white/10 bg-white/[0.03] p-3.5 backdrop-blur-xs shrink-0">
          <p className="text-[10px] font-bold tracking-widest text-stone-400 uppercase">
            YOUR WORKSPACE
          </p>
          <p className="mt-1 truncate text-sm font-semibold text-white">{data.company.name}</p>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar-dark pr-1 -mr-1">
        <nav aria-label="Main navigation" className="space-y-1.5">
          {filteredNav.map((item) => (
            <button
              key={item.id}
              aria-current={page === item.id ? 'page' : undefined}
              className={cn(
                'flex min-h-11 w-full items-center gap-3 rounded-full px-4 text-left text-sm font-medium transition-all',
                page === item.id
                  ? 'bg-emerald-600 text-white font-semibold shadow-md shadow-emerald-950/40'
                  : 'text-stone-400 hover:bg-white/[0.06] hover:text-white',
              )}
              onClick={() => handleNavClick(item.id)}
            >
              <item.icon className="size-4.5 shrink-0" />
              <span className="truncate">{item.label}</span>
              {item.id === 'orders' && pending > 0 && (
                <span className="ml-auto rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-bold tabular-nums text-white">
                  {pending}
                </span>
              )}
              {item.id === 'playground' && (
                <span className="ml-auto size-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
              )}
            </button>
          ))}
        </nav>

        {filteredManage.length > 0 && (
          <div className="mt-6">
            <p className="mb-2 px-4 text-[10px] font-bold tracking-widest text-stone-400 uppercase">
              MANAGE
            </p>
            <nav aria-label="Workspace management" className="space-y-1.5">
              {filteredManage.map((item) => (
                <button
                  key={item.id}
                  aria-current={page === item.id ? 'page' : undefined}
                  className={cn(
                    'flex min-h-11 w-full items-center gap-3 rounded-full px-4 text-left text-sm font-medium transition-all',
                    page === item.id
                      ? 'bg-emerald-600 text-white font-semibold shadow-md shadow-emerald-950/40'
                      : 'text-stone-400 hover:bg-white/[0.06] hover:text-white',
                  )}
                  onClick={() => handleNavClick(item.id)}
                >
                  <item.icon className="size-4.5 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </button>
              ))}
            </nav>
          </div>
        )}

        {filteredNav.length === 0 && filteredManage.length === 0 && (
          <div className="py-6 text-center text-xs text-stone-500">
            <p>No matching pages</p>
            <button
              type="button"
              className="mt-2 font-semibold text-emerald-400 underline"
              onClick={() => setNavSearch('')}
            >
              Clear search
            </button>
          </div>
        )}
      </div>

      <div className="mt-auto pt-4 shrink-0">
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 shadow-xs">
          <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-stone-100">
            <MessageCircle className="size-4 text-emerald-400 shrink-0" />
            Made for the conversation.
          </div>
          <p className="text-xs leading-relaxed text-stone-400">
            Your menu. Your customers.
            <br />
            One less thing on your plate.
          </p>
        </div>
        <button
          className="mt-3 flex min-h-9 w-full items-center gap-2.5 rounded-full px-3.5 text-xs font-medium text-stone-300 hover:bg-white/[0.06] hover:text-white transition-all"
          onClick={() => {
            setHelp(true);
            setMobile(false);
          }}
        >
          <CircleHelp className="size-4 text-stone-400" />
          Getting started
          <ArrowRight className="ml-auto size-3.5" />
        </button>
        {client && (
          <button
            className="mt-2.5 flex min-h-9.5 w-full items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-stone-300 hover:bg-white/10 hover:text-red-400 transition-all"
            onClick={() => void client.auth.signOut()}
          >
            <LogOut className="size-3.5" />
            Sign out
          </button>
        )}
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
      <div className="min-h-dvh bg-[#f8fafc]">
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 lg:block">{sidebar}</aside>
        {mobile && (
          <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
            <div
              className="fixed inset-0 bg-stone-950/60 backdrop-blur-xs transition-opacity"
              onClick={() => setMobile(false)}
            />
            <div className="fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] bg-[#121417] shadow-2xl flex flex-col">
              <div className="absolute right-3 top-4 z-10">
                <button
                  className="flex size-8 items-center justify-center rounded-full text-stone-400 hover:text-white hover:bg-white/10 transition-colors"
                  aria-label="Close navigation"
                  onClick={() => setMobile(false)}
                >
                  <X className="size-5" />
                </button>
              </div>
              {sidebar}
            </div>
          </div>
        )}
        <div className="lg:pl-64">
          <header className="sticky top-0 z-20 flex min-h-16 items-center justify-between gap-3 border-b border-stone-200/80 bg-white/95 px-4 backdrop-blur-md sm:px-8 lg:px-10">
            <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
              <button
                className="icon-btn lg:hidden rounded-full"
                aria-label="Open navigation"
                onClick={() => setMobile(true)}
              >
                <MenuIcon className="size-5" />
              </button>
              <span className="hidden text-xs font-semibold tracking-wider text-stone-400 uppercase sm:block">
                Workspace
              </span>
              <span className="hidden text-stone-300 sm:block">/</span>
              <span className="truncate text-sm font-bold text-stone-900 tracking-tight">
                {[...navigation, ...manage].find((n) => n.id === page)?.label}
              </span>
            </div>
            <div className="flex items-center gap-2 sm:gap-3 shrink-0">
              <button
                type="button"
                className="hidden md:inline-flex items-center gap-1.5 rounded-full border border-stone-200/80 bg-stone-50/80 px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-100 hover:border-stone-300 transition-all shadow-2xs"
                onClick={() => setHelp(true)}
              >
                <Sparkles className="size-3.5 text-emerald-600" />
                Getting started
              </button>
              <div className="relative">
                <label className="sr-only" htmlFor="company-switch">
                  Current business
                </label>
                <CustomSelect
                  id="company-switch"
                  variant="pill"
                  align="right"
                  value={data.company.id}
                  disabled={busy}
                  onChange={(val) => switchCompany(val)}
                  options={data.companies.map((c) => ({
                    value: c.id,
                    label: c.name,
                  }))}
                  className="max-w-36 sm:max-w-56"
                />
              </div>
              <div className="h-5 w-px bg-stone-200 hidden sm:block" />
              <div className="flex items-center gap-2">
                <div className="flex size-8.5 shrink-0 items-center justify-center rounded-full bg-emerald-700 text-xs font-bold text-white shadow-2xs ring-2 ring-emerald-600/20">
                  {initials(data.company.name)}
                </div>
                <div className="hidden text-xs xl:block">
                  <p className="font-bold text-stone-800">{label(data.role)}</p>
                  <p className="text-[11px] text-stone-400">
                    {data.mode === 'demo' ? 'Demo workspace' : 'Team workspace'}
                  </p>
                </div>
                {client && (
                  <button
                    className="icon-btn rounded-full hover:text-stone-800"
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
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 bg-stone-100/90 px-4 py-2 text-xs text-stone-600 sm:px-8 lg:px-10">
              <span>
                <span className="font-semibold text-stone-800">Sample workspace</span>
                <span className="mx-2">·</span>Changes saved on this local server. No real messages
                are sent.
              </span>
              <button
                className="font-semibold text-emerald-800 hover:text-emerald-950 transition-colors"
                onClick={() => navigate('playground')}
              >
                Try an order <span aria-hidden>↗</span>
              </button>
            </div>
          )}
          <main id="main" className="mx-auto max-w-7xl px-4 py-6 sm:px-8 lg:px-10 lg:py-8">
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
          className="btn btn-primary mt-7 w-full rounded-full"
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
        'flex items-center gap-2.5 text-2xl font-bold tracking-tight',
        dark ? 'text-white' : 'text-stone-900',
      )}
    >
      <span className="relative flex size-8.5 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm shadow-emerald-700/20">
        <MessageCircle className="size-5" strokeWidth={2.5} />
        <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-white ring-2 ring-emerald-600" />
      </span>
      orderly<span className="self-end pb-0.5 text-emerald-500 font-extrabold">.</span>
    </div>
  );
}

function FirstBusiness({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid min-h-dvh place-items-center bg-[#f8fafc] px-4 py-8">
      <div className="w-full max-w-md">
        <Brand dark={false} />
        <form
          className="card mt-8 space-y-5 rounded-3xl border border-stone-200/90 bg-white p-7 sm:p-9 shadow-xl"
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
          <h1 className="text-2xl font-bold tracking-tight text-stone-900">
            Add your first business.
          </h1>
          <p className="text-sm text-stone-500 leading-relaxed">
            Your administrator account is ready. Create an empty workspace to begin.
          </p>
          <Field label="Business name">
            <input
              className="input rounded-xl"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <ErrorNotice message={error} />
          <button className="btn btn-primary rounded-full w-full" disabled={busy}>
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
    <div className="grid min-h-dvh place-items-center bg-[#f8fafc] px-4 py-8">
      <div className="w-full max-w-md">
        <Brand dark={false} />
        <div className="card mt-8 rounded-3xl border border-stone-200/90 bg-white p-7 sm:p-9 shadow-xl">
          <h1 className="text-2xl font-bold tracking-tight text-stone-900">Welcome back.</h1>
          <p className="mb-7 mt-2 text-sm text-stone-500 leading-relaxed">
            Sign in to your restaurant workspace.
          </p>
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
                className="input rounded-xl"
                type="email"
                value={email}
                required
                autoComplete="username"
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Password">
              <input
                className="input rounded-xl"
                type="password"
                value={password}
                required
                autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <ErrorNotice message={error} />
            <button className="btn btn-primary rounded-full w-full" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
              <ArrowRight className="size-4" />
            </button>
          </form>
          <p className="mt-6 text-xs leading-relaxed text-stone-400">
            Workspace access is managed by your administrator. Contact them if you need an account
            or password reset.
          </p>
        </div>
      </div>
    </div>
  );
}
