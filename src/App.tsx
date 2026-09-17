import { useCallback, useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
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
import { Playground } from './components/Conversations';
import { Inbox } from './components/Inbox';
import { Businesses, Integrations, Settings } from './components/Settings';
import { BotSettings } from './components/BotSettings';
import { Activity, SecuritySettings } from './components/Operations';
import { go, useRoute, workspacePath } from './lib/routes';

const navigation = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'orders', label: 'Orders', icon: ShoppingBag },
  { id: 'inbox', label: 'Inbox', icon: MessageSquare },
  { id: 'menu', label: 'Menu', icon: BookOpen },
  { id: 'playground', label: 'Test your bot', icon: FlaskConical },
  { id: 'bot', label: 'Bot settings', icon: SlidersHorizontal },
  { id: 'activity', label: 'Activity & errors', icon: Sparkles },
] as const;
const manage = [
  { id: 'integrations', label: 'Integrations', icon: Cable },
  { id: 'settings', label: 'Settings', icon: Settings2 },
  { id: 'security', label: 'Security & privacy', icon: Settings2 },
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
  const [mfaFactor, setMfaFactor] = useState<string>();
  const [passwordRecovery, setPasswordRecovery] = useState(
    () =>
      typeof window !== 'undefined' &&
      /type=(recovery|invite)|flow=recovery/.test(window.location.hash + window.location.search),
  );
  const [companyId, setCompanyId] = useState(getStoredCompany);
  const [data, setData] = useState<Bootstrap | null>(null);
  const route = useRoute();
  const page = route.page;
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
        const acceptSession = async (present: boolean) => {
          if (!present) {
            if (active) {
              setAuthenticated(false);
              setData(null);
              setMfaFactor(undefined);
            }
            return;
          }
          const assurance = await auth.auth.mfa.getAuthenticatorAssuranceLevel();
          if (assurance.error) throw assurance.error;
          if (!active) return;
          if (assurance.data.nextLevel === 'aal2' && assurance.data.currentLevel !== 'aal2') {
            const factors = await auth.auth.mfa.listFactors();
            if (active) {
              setMfaFactor(factors.data?.totp.find((f) => f.status === 'verified')?.id);
              setAuthenticated(false);
            }
          } else {
            setMfaFactor(undefined);
            setAuthenticated(true);
          }
        };
        const session = await auth.auth.getSession();
        if (!active) return;
        setAccessToken(session.data.session?.access_token);
        await acceptSession(Boolean(session.data.session));
        const { data: subscription } = auth.auth.onAuthStateChange((_event, value) => {
          setAccessToken(value?.access_token);
          if (_event === 'PASSWORD_RECOVERY') setPasswordRecovery(true);
          // Auth callbacks must not await another Supabase auth operation while its lock is held.
          setTimeout(() => {
            void acceptSession(Boolean(value)).catch((e) => setError(e.message));
          }, 0);
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
      `/bootstrap${route.slug ? `?companySlug=${encodeURIComponent(route.slug)}` : companyId ? `?companyId=${encodeURIComponent(companyId)}` : ''}`,
      companyId,
    );
    setData((current) => (current?.company.id === result.company.id ? result : current));
    setStoredCompany(result.company.id);
  }, [companyId, route.slug]);

  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    setError('');
    api<Bootstrap>(
      `/bootstrap${route.slug ? `?companySlug=${encodeURIComponent(route.slug)}` : companyId ? `?companyId=${encodeURIComponent(companyId)}` : ''}`,
      companyId,
    )
      .then((result) => {
        if (active) {
          setData(result);
          setStoredCompany(result.company.id);
          if (!route.slug) go(workspacePath(result.company.slug, page), true);
        }
      })
      .catch((e) => {
        if (active) {
          if (companyId && !route.slug) {
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
  }, [authenticated, companyId, route.slug]);

  useEffect(() => {
    if (!authenticated || !data || !['overview', 'orders', 'inbox', 'activity'].includes(page))
      return;
    const timer = setInterval(() => {
      if (!document.hidden && !busy)
        void api<Pick<Bootstrap, 'summary' | 'traces' | 'jobs' | 'orders'>>(
          '/activity',
          data.company.id,
        )
          .then((activity) => {
            setData((current) =>
              current?.company.id === data.company.id ? { ...current, ...activity } : current,
            );
            setError('');
          })
          .catch((e) => setError(`Updates delayed: ${e.message}`));
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
    const company = data?.companies.find((c) => c.id === id);
    if (company) go(workspacePath(company.slug, page));
    setMobile(false);
  }
  function navigate(value: Page, id?: string) {
    if (data) go(workspacePath(data.company.slug, value, id));
    setMobile(false);
    setError('');
    window.scrollTo(0, 0);
  }

  if (client && mfaFactor)
    return (
      <AccountChallenge
        client={client}
        factorId={mfaFactor}
        onDone={() => {
          setMfaFactor(undefined);
          setAuthenticated(true);
        }}
      />
    );
  if (client && authenticated && passwordRecovery)
    return (
      <AccountChallenge
        client={client}
        onDone={() => {
          setPasswordRecovery(false);
          go('/app', true);
        }}
      />
    );
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
  if (!data || (route.slug && route.slug !== data.company.slug))
    return (
      <div className="grid min-h-dvh place-items-center bg-canvas p-6">
        <div className="w-full max-w-md">
          <Brand dark={false} />
          <div className="mt-8 space-y-4">
            <div className="h-8 w-2/3 rounded-lg bg-ink/[0.06]" />
            <div className="h-32 rounded-[18px] border border-white/80 bg-white/65" />
            <p className="text-sm text-stone-500">Opening your workspace…</p>
            <ErrorNotice message={error} />
            {error && (
              <a className="btn" href="/app">
                Open my workspace
              </a>
            )}
            {error && (
              <button className="btn" onClick={() => window.location.reload()}>
                Try again
              </button>
            )}
          </div>
        </div>
      </div>
    );
  const pending = data.summary?.pending ?? data.orders.filter((o) => o.status === 'pending').length;

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
    <div className="flex h-full flex-col overflow-hidden bg-ink px-4 pb-6 pt-7 text-cream/65 border-r border-white/[0.06]">
      <div className="shrink-0">
        <div className="px-2 shrink-0">
          <Brand />
        </div>

        <div className="mt-6 px-1 flex items-center gap-2 shrink-0">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-cream/35" />
            <input
              type="text"
              aria-label="Search navigation"
              value={navSearch}
              onChange={(e) => setNavSearch(e.target.value)}
              placeholder="Search..."
              className="h-9 w-full rounded-[9px] border border-white/[0.08] bg-white/[0.05] pl-9 pr-7 text-[13px] text-cream placeholder:text-cream/35 transition-all focus:border-white/20 focus:bg-white/[0.08] focus:outline-none"
            />
            {navSearch && (
              <button
                type="button"
                className="absolute right-2.5 top-2.5 text-cream/40 hover:text-white"
                onClick={() => setNavSearch('')}
                aria-label="Clear search"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <button
            type="button"
            className="flex size-9 shrink-0 items-center justify-center rounded-[9px] border border-white/[0.08] bg-white/[0.05] text-cream/50 hover:bg-white/10 hover:text-white transition-all"
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

        <div className="my-5 rounded-xl border border-white/[0.06] bg-white/[0.03] p-3 shrink-0">
          <p className="text-[11px] font-semibold tracking-[1px] text-cream/35 uppercase">
            YOUR WORKSPACE
          </p>
          <p className="mt-1 truncate text-[13px] font-semibold text-cream">{data.company.name}</p>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar-dark pr-1 -mr-1">
        <nav aria-label="Main navigation" className="space-y-[3px]">
          {filteredNav.map((item) => (
            <button
              key={item.id}
              aria-current={page === item.id ? 'page' : undefined}
              className={cn(
                'flex min-h-10 w-full items-center gap-3 rounded-[9px] px-3 text-left text-[13.5px] font-medium transition-all duration-150',
                page === item.id
                  ? 'bg-white/[0.08] text-white font-semibold'
                  : 'text-cream/65 hover:bg-white/5 hover:text-white',
              )}
              onClick={() => handleNavClick(item.id)}
            >
              <item.icon
                className={cn('size-[17px] shrink-0', page === item.id && 'text-brand-500')}
              />
              <span className="truncate">{item.label}</span>
              {item.id === 'orders' && pending > 0 && (
                <span className="ml-auto rounded-md bg-brand-500/20 px-[7px] py-0.5 text-[11px] font-semibold tabular-nums text-brand-500">
                  {pending}
                </span>
              )}
              {item.id === 'playground' && (
                <span className="ml-auto size-2 rounded-full bg-brand-500" />
              )}
            </button>
          ))}
        </nav>

        {filteredManage.length > 0 && (
          <div className="mt-7">
            <p className="mb-2 px-3 text-[11px] font-semibold tracking-[1px] text-cream/35 uppercase">
              MANAGE
            </p>
            <nav aria-label="Workspace management" className="space-y-[3px]">
              {filteredManage.map((item) => (
                <button
                  key={item.id}
                  aria-current={page === item.id ? 'page' : undefined}
                  className={cn(
                    'flex min-h-10 w-full items-center gap-3 rounded-[9px] px-3 text-left text-[13.5px] font-medium transition-all duration-150',
                    page === item.id
                      ? 'bg-white/[0.08] text-white font-semibold'
                      : 'text-cream/65 hover:bg-white/5 hover:text-white',
                  )}
                  onClick={() => handleNavClick(item.id)}
                >
                  <item.icon
                    className={cn('size-[17px] shrink-0', page === item.id && 'text-brand-500')}
                  />
                  <span className="truncate">{item.label}</span>
                </button>
              ))}
            </nav>
          </div>
        )}

        {filteredNav.length === 0 && filteredManage.length === 0 && (
          <div className="py-6 text-center text-xs text-cream/40">
            <p>No matching pages</p>
            <button
              type="button"
              className="mt-2 font-semibold text-brand-500 underline"
              onClick={() => setNavSearch('')}
            >
              Clear search
            </button>
          </div>
        )}
      </div>

      <div className="mt-auto pt-4 shrink-0">
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
          <div className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold text-cream">
            <MessageCircle className="size-4 text-brand-500 shrink-0" />
            Made for the conversation.
          </div>
          <p className="text-[11px] leading-relaxed text-cream/40">
            Your menu. Your customers.
            <br />
            One less thing on your plate.
          </p>
        </div>
        <button
          className="mt-3 flex min-h-9 w-full items-center gap-2.5 rounded-[9px] px-3 text-xs font-medium text-cream/65 hover:bg-white/5 hover:text-white transition-all"
          onClick={() => {
            setHelp(true);
            setMobile(false);
          }}
        >
          <CircleHelp className="size-4 text-cream/40" />
          Getting started
          <ArrowRight className="ml-auto size-3.5" />
        </button>
        {client && (
          <button
            className="mt-2.5 flex min-h-9.5 w-full items-center justify-center gap-2 rounded-[9px] border border-white/[0.06] bg-white/[0.03] px-4 py-2 text-xs font-semibold text-cream/65 hover:bg-white/[0.06] hover:text-red-400 transition-all"
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
        detailId: route.id,
        auth: client ?? undefined,
      }}
    >
      <div className="min-h-dvh bg-canvas">
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 lg:block">{sidebar}</aside>
        <Dialog.Root open={mobile} onOpenChange={setMobile}>
          <Dialog.Portal>
            <Dialog.Overlay
              className="fixed inset-0 bg-ink/60 backdrop-blur-xs transition-opacity"
              onClick={() => setMobile(false)}
            />
            <Dialog.Content
              aria-describedby={undefined}
              className="fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] bg-ink shadow-2xl flex flex-col"
            >
              <Dialog.Title className="sr-only">Workspace navigation</Dialog.Title>
              <div className="absolute right-3 top-4 z-10">
                <button
                  className="flex size-8 items-center justify-center rounded-lg text-cream/50 hover:text-white hover:bg-white/10 transition-colors"
                  aria-label="Close navigation"
                  onClick={() => setMobile(false)}
                >
                  <X className="size-5" />
                </button>
              </div>
              {sidebar}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        <div className="lg:pl-64">
          <header className="sticky top-0 z-20 flex min-h-[72px] items-center justify-between gap-3 border-b border-ink/5 bg-canvas/75 px-4 backdrop-blur-[14px] sm:px-8 lg:px-10">
            <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
              <button
                className="icon-btn-glass lg:hidden"
                aria-label="Open navigation"
                onClick={() => setMobile(true)}
              >
                <MenuIcon className="size-5" />
              </button>
              <span className="hidden text-xs font-semibold tracking-wider text-stone-400 uppercase sm:block">
                Workspace
              </span>
              <span className="hidden text-stone-300 sm:block">/</span>
              <span className="truncate text-sm font-semibold text-ink">
                {[...navigation, ...manage].find((n) => n.id === page)?.label}
              </span>
            </div>
            <div className="flex items-center gap-2 sm:gap-3 shrink-0">
              <button
                type="button"
                className="hidden md:inline-flex h-[38px] items-center gap-1.5 rounded-[9px] border border-white/80 bg-white/65 px-3.5 text-[13px] font-semibold text-stone-700 hover:bg-white hover:text-ink transition-all"
                onClick={() => setHelp(true)}
              >
                <Sparkles className="size-3.5 text-brand-500" />
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
                  options={(data.companies || []).map((c) => ({
                    value: c.id,
                    label: c.name,
                  }))}
                  className="max-w-36 sm:max-w-56"
                />
              </div>
              <div className="h-5 w-px bg-ink/10 hidden sm:block" />
              <div className="flex items-center gap-2">
                <div className="hidden sm:flex size-[34px] shrink-0 items-center justify-center rounded-lg bg-ink-soft text-[13px] font-semibold text-brand-500">
                  {initials(data.company.name)}
                </div>
                <div className="hidden text-xs xl:block">
                  <p className="text-[13px] font-semibold text-ink">{label(data.role)}</p>
                  <p className="text-[11px] text-stone-400">
                    {data.mode === 'demo' ? 'Demo workspace' : 'Team workspace'}
                  </p>
                </div>
                {client && (
                  <button
                    className="icon-btn-glass"
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
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] bg-ink px-4 py-2 text-xs text-cream/60 sm:px-8 lg:px-10">
              <span>
                <span className="font-semibold text-cream">Sample workspace</span>
                <span className="mx-2">·</span>Changes saved on this local server. No real messages
                are sent.
              </span>
              <button
                className="font-semibold text-brand-500 hover:text-brand-400 transition-colors"
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
              {page === 'bot' && <BotSettings />}
              {page === 'activity' && <Activity />}
              {page === 'security' && <SecuritySettings />}
            </div>
            <footer className="mt-10 flex flex-wrap justify-between gap-2 border-t border-ink/[0.06] pt-5 text-xs text-stone-400">
              <span>Orderly · Conversations to orders</span>
              <nav className="flex flex-wrap gap-3">
                <a href="/privacy">Privacy</a>
                <a href="/terms">Terms</a>
                <a href="/contact">Support</a>
              </nav>
              <span>
                {data.company?.currency || 'PKR'} · {data.company?.timezone || 'Asia/Karachi'}
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
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-500/12 text-xs font-semibold text-brand-600">
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
        'flex items-center gap-3 font-serif text-[21px] font-bold tracking-[-0.3px]',
        dark ? 'text-cream' : 'text-ink',
      )}
    >
      <span className="relative flex size-10 items-center justify-center rounded-[11px] bg-[linear-gradient(to_bottom,var(--color-canvas)_50%,var(--color-brand-500)_50%)] text-ink">
        <MessageCircle className="size-5" strokeWidth={2.5} />
        <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-brand-500 ring-2 ring-canvas" />
      </span>
      orderly<span className="self-end pb-0.5 text-brand-500 font-extrabold">.</span>
    </div>
  );
}

function FirstBusiness({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid min-h-dvh place-items-center bg-canvas px-4 py-8">
      <div className="w-full max-w-md">
        <Brand dark={false} />
        <form
          className="card mt-8 space-y-5 p-7 sm:p-9"
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
          <h1 className="page-title">Add your first business.</h1>
          <p className="text-[13.5px] text-stone-500 leading-relaxed">
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
  const [notice, setNotice] = useState('');
  return (
    <div className="grid min-h-dvh place-items-center bg-canvas px-4 py-8">
      <div className="w-full max-w-md">
        <Brand dark={false} />
        <div className="card mt-8 p-7 sm:p-9">
          <h1 className="page-title">Welcome back.</h1>
          <p className="mb-7 mt-2 text-[13.5px] text-stone-500 leading-relaxed">
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
            {notice && (
              <p role="status" className="text-sm text-stone-600">
                {notice}
              </p>
            )}
            <button className="btn btn-primary w-full" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
              <ArrowRight className="size-4" />
            </button>
          </form>
          <button
            className="btn btn-quiet mt-4 w-full"
            disabled={busy || !email}
            onClick={async () => {
              setError('');
              setBusy(true);
              try {
                const result = await client.auth.resetPasswordForEmail(email, {
                  redirectTo: `${window.location.origin}/login?flow=recovery`,
                });
                if (result.error) throw result.error;
                setNotice('If this account exists, a password-reset link has been sent.');
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Send password reset link
          </button>
          <p className="mt-6 text-xs leading-relaxed text-stone-400">
            Workspace access is managed by your administrator. Contact them if you need an account
            access. Enter your email above to request a password reset.
          </p>
        </div>
      </div>
    </div>
  );
}

function AccountChallenge({
  client,
  factorId,
  onDone,
}: {
  client: SupabaseClient;
  factorId?: string;
  onDone: () => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <main className="grid min-h-dvh place-items-center p-5">
      <form
        className="card w-full max-w-md space-y-5 p-6"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const result = factorId
              ? await client.auth.mfa.challengeAndVerify({ factorId, code: value })
              : await client.auth.updateUser({ password: value });
            if (result.error) throw result.error;
            onDone();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1 className="page-title">{factorId ? 'Verify your sign-in' : 'Set your password'}</h1>
        <Field label={factorId ? 'Authenticator code' : 'New password (at least 12 characters)'}>
          <input
            className="input"
            type={factorId ? 'text' : 'password'}
            inputMode={factorId ? 'numeric' : undefined}
            autoComplete={factorId ? 'one-time-code' : 'new-password'}
            minLength={factorId ? 6 : 12}
            maxLength={factorId ? 6 : 128}
            required
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        <ErrorNotice message={error} />
        <button disabled={busy} className="btn btn-primary w-full">
          {busy ? 'Checking…' : 'Continue'}
        </button>
        <button type="button" className="btn w-full" onClick={() => void client.auth.signOut()}>
          Sign out
        </button>
        <p className="text-xs text-stone-500">
          Lost your authenticator? Contact Orderly support for identity verification and account
          recovery.
        </p>
      </form>
    </main>
  );
}
