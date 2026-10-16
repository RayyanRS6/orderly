import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { StaffAlerts } from './components/StaffAlerts';
import * as Dialog from '@radix-ui/react-dialog';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ArrowRight,
  BookOpen,
  Building2,
  Cable,
  Check,
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
  Users,
  Workflow,
  X,
} from 'lucide-react';
import type { Bootstrap } from './shared/types';
import { api, setAccessToken, setSessionRejectedHandler } from './lib/api';
import { cn, initials, label } from './lib/utils';
import {
  Workspace,
  dialogOpen,
  type MutateOptions,
  type Page,
  type Toast,
  type ToastTone,
} from './lib/workspace';
import {
  ActionButton,
  CustomSelect,
  ErrorNotice,
  Field,
  keepOpenForToasts,
  Modal,
  Toaster,
} from './components/ui';
import { Overview, Orders } from './components/Orders';
import { Catalog } from './components/Catalog';
import { Playground } from './components/Conversations';
import { Inbox } from './components/Inbox';
import { Businesses, Integrations, Settings } from './components/Settings';
import { BotSettings } from './components/BotSettings';
import { Activity, SecuritySettings } from './components/Operations';
import { AgentFlow } from './components/AgentFlow';
import { go, useRoute, workspacePath } from './lib/routes';

const navigation = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'orders', label: 'Orders', icon: ShoppingBag },
  { id: 'inbox', label: 'Inbox', icon: MessageSquare },
  { id: 'menu', label: 'Menu', icon: BookOpen },
  { id: 'playground', label: 'Test your bot', icon: FlaskConical },
  { id: 'bot', label: 'Bot settings', icon: SlidersHorizontal },
  { id: 'flow', label: 'Agent flow', icon: Workflow },
  { id: 'activity', label: 'Activity & errors', icon: Sparkles },
] as const;
const manage = [
  { id: 'integrations', label: 'Integrations', icon: Cable },
  { id: 'settings', label: 'Settings', icon: Settings2 },
  { id: 'security', label: 'Security & privacy', icon: Settings2 },
  { id: 'businesses', label: 'Businesses', icon: Building2 },
] as const;
// Only the platform admin sees People, so owners and staff never download its code.
const People = lazy(() =>
  import('./components/People').then(
    (m) => ({ default: m.People }),
    () => ({ default: PeopleUnavailable }),
  ),
);
function PeopleUnavailable() {
  return <ErrorNotice message="The People page couldn’t load. Reload the page and try again." />;
}
const peopleNav = { id: 'people', label: 'People', icon: Users } as const;
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
  // Page-level problems (loading, background updates, sign-in) show at the top of the page.
  const [error, setError] = useState('');
  // A failed change: a bottom-right notification, and inline inside an open dialog.
  const [actionError, setActionError] = useState('');
  // How many changes are being saved. Background refreshes wait; nothing greys out.
  const savesInFlight = useRef(0);
  const [saving, setSaving] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const refreshSeq = useRef(0);
  const [mobile, setMobile] = useState(false);
  const [help, setHelp] = useState(false);
  const [firstBusiness, setFirstBusiness] = useState(false);
  const [navSearch, setNavSearch] = useState('');
  // Shown on the sign-in form when the server rejected this browser's saved session.
  const [sessionNotice, setSessionNotice] = useState('');

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
        // The server rejected the saved session (revoked, or ended elsewhere) while this
        // browser still holds it. Forget it here only, so the sign-in form appears instead
        // of an error screen that can't be left.
        let signingOut = false;
        setSessionRejectedHandler(() => {
          if (signingOut || !active) return;
          signingOut = true;
          setSessionNotice('Your session expired. Sign in again.');
          void auth.auth.signOut({ scope: 'local' }).finally(() => {
            signingOut = false;
          });
        });
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
            setSessionNotice('');
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
      setSessionRejectedHandler(undefined);
    };
  }, []);

  const refresh = useCallback(async () => {
    // Saves no longer block each other, so a slower, older reload must not overwrite a newer one.
    const seq = ++refreshSeq.current;
    const result = await api<Bootstrap>(
      `/bootstrap${route.slug ? `?companySlug=${encodeURIComponent(route.slug)}` : companyId ? `?companyId=${encodeURIComponent(companyId)}` : ''}`,
      companyId,
    );
    if (seq !== refreshSeq.current) return;
    setData((current) => {
      if (current?.company.id !== result.company.id) return current;
      setStoredCompany(result.company.id);
      return result;
    });
  }, [companyId, route.slug]);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const notify = useCallback(
    (message: string, tone: ToastTone = 'success') => {
      const id = ++toastId.current;
      setToasts((current) => [...current.slice(-2), { id, message, tone }]);
      setTimeout(() => dismissToast(id), tone === 'error' ? 8000 : 4000);
    },
    [dismissToast],
  );

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
      if (!document.hidden && !savesInFlight.current)
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
  }, [authenticated, !!data, page, refresh]);

  const mutate = useCallback(
    async <T,>(
      path: string,
      body?: unknown,
      method?: string,
      options: MutateOptions = {},
    ): Promise<T> => {
      savesInFlight.current++;
      setSaving(savesInFlight.current);
      setActionError('');
      try {
        let result: T;
        try {
          result = await api<T>(path, data?.company.id || companyId, body, method);
        } catch (e) {
          const message = (e as Error).message;
          setActionError(message);
          // A dialog shows the failure only while it is open: closed early, the failure
          // would otherwise appear nowhere.
          if (!options.quiet && !(options.dialog && dialogOpen())) notify(message, 'error');
          throw e;
        }
        try {
          await refresh();
        } catch {
          // The change itself was saved; only reloading the page data failed.
          notify('Saved. Reload the page to see the latest data.', 'info');
          return result;
        }
        if (options.success) notify(options.success);
        return result;
      } finally {
        savesInFlight.current--;
        setSaving(savesInFlight.current);
      }
    },
    [data?.company.id, companyId, refresh, notify],
  );

  function switchCompany(id: string) {
    if (id === data?.company.id) return;
    setData(null);
    setError('');
    setActionError('');
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
  if (config?.mode === 'live' && !authenticated && client)
    return <Login client={client} notice={sessionNotice} />;
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
      // Same loader as the index.html shell, so the hand-over from HTML to React is seamless.
      <div className="grid min-h-dvh place-items-center canvas-glow p-6">
        <div className="loader" data-state={error ? 'error' : 'loading'}>
          <div className="loader-brand">
            <span className="loader-tile">
              <MessageCircle strokeWidth={2.5} aria-hidden="true" />
            </span>
            <span>
              orderly<b>.</b>
            </span>
          </div>
          <div className="loader-chat" aria-hidden="true">
            <span className="loader-msg loader-them">
              <i />
              <i />
            </span>
            <span className="loader-msg loader-us">
              <i />
            </span>
            <span className="loader-last">
              <span className="loader-typing">
                <i />
                <i />
                <i />
              </span>
              <span className="loader-done">
                <Check strokeWidth={3} />
                <i />
              </span>
            </span>
          </div>
          <p className="loader-text" role="status">
            Opening your workspace…
          </p>
          <span className="loader-bar" aria-hidden="true">
            <i />
          </span>
          {error && (
            <div className="mt-6 w-full space-y-3 text-left">
              <ErrorNotice message={error} />
              <a className="btn w-full" href="/app">
                Open my workspace
              </a>
              <button className="btn w-full" onClick={() => window.location.reload()}>
                Try again
              </button>
            </div>
          )}
        </div>
      </div>
    );
  const pending = data.summary?.pending ?? data.orders.filter((o) => o.status === 'pending').length;

  const filteredNav = navigation.filter((item) =>
    item.label.toLowerCase().includes(navSearch.toLowerCase()),
  );
  const manageItems = data.role === 'admin' ? [...manage, peopleNav] : [...manage];
  const filteredManage = manageItems.filter((item) =>
    item.label.toLowerCase().includes(navSearch.toLowerCase()),
  );

  const handleNavClick = (id: Page) => {
    navigate(id);
    setMobile(false);
  };

  const sidebar = (
    <div className="flex h-full flex-col overflow-hidden bg-ink glow-dark px-4 pb-6 pt-7 text-cream/65 border-r border-white/[0.06]">
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
              className="h-9 w-full rounded-full border border-white/[0.08] bg-white/[0.05] pl-9 pr-7 text-[13px] text-cream placeholder:text-cream/35 transition-[background-color,border-color,box-shadow] duration-200 focus:border-brand-500/50 focus:bg-white/[0.08] focus:shadow-[0_0_0_4px_rgb(255_105_44/0.15)] focus:outline-none"
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
            className="flex size-9 shrink-0 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.05] text-cream/50 transition-[background-color,color,translate,scale] duration-200 hover:bg-white/10 hover:text-white active:scale-90"
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

        <div className="my-5 rounded-2xl glass-dark p-3 shrink-0">
          <p className="text-[10.5px] font-semibold tracking-[0.16em] text-cream/60 uppercase">
            YOUR WORKSPACE
          </p>
          <p className="mt-1 truncate font-serif text-[19px] leading-tight text-cream">
            {data.company.name}
          </p>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar-dark pr-1 -mr-1">
        <nav aria-label="Main navigation" className="stagger space-y-[3px]">
          {filteredNav.map((item) => (
            <button
              key={item.id}
              aria-current={page === item.id ? 'page' : undefined}
              className="side-link"
              onClick={() => handleNavClick(item.id)}
            >
              <item.icon className="size-[17px] shrink-0" />
              <span className="truncate">{item.label}</span>
              {item.id === 'orders' && pending > 0 && (
                <span className="pop-in ml-auto rounded-full bg-brand-500 px-2 py-0.5 text-[11px] font-bold tabular-nums text-ink shadow-[0_6px_14px_-6px_rgb(255_105_44/0.9)]">
                  {pending}
                </span>
              )}
              {item.id === 'playground' && (
                <span className="live-dot ml-auto size-2 rounded-full bg-current text-brand-500" />
              )}
            </button>
          ))}
        </nav>

        {filteredManage.length > 0 && (
          <div className="mt-7">
            <p className="mb-2 px-3 text-[10.5px] font-semibold tracking-[0.16em] text-cream/60 uppercase">
              MANAGE
            </p>
            <nav aria-label="Workspace management" className="space-y-[3px]">
              {filteredManage.map((item) => (
                <button
                  key={item.id}
                  aria-current={page === item.id ? 'page' : undefined}
                  className="side-link"
                  onClick={() => handleNavClick(item.id)}
                >
                  <item.icon className="size-[17px] shrink-0" />
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
              className="mt-2 font-semibold text-brand-500 underline decoration-2 underline-offset-4 transition-colors hover:text-brand-400"
              onClick={() => setNavSearch('')}
            >
              Clear search
            </button>
          </div>
        )}
      </div>

      <div className="mt-auto pt-4 shrink-0">
        <div className="group rounded-2xl glass-dark p-3">
          <div className="mb-1.5 flex items-center gap-2 font-serif text-[17px] leading-tight text-cream">
            <MessageCircle className="size-4 text-brand-500 shrink-0 transition-transform duration-500 ease-[var(--ease-spring)] group-hover:-rotate-12 group-hover:scale-110" />
            Made for the conversation.
          </div>
          <p className="text-[11px] leading-relaxed text-cream/60">
            Your menu. Your customers.
            <br />
            One less thing on your plate.
          </p>
        </div>
        <button
          className="mt-3 flex min-h-9 w-full items-center gap-2.5 rounded-full px-3 text-xs font-medium text-cream/65 transition-colors hover:bg-white/[0.06] hover:text-white"
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
            className="mt-2.5 flex min-h-9.5 w-full items-center justify-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-4 py-2 text-xs font-semibold text-cream/65 transition-[background-color,color,translate,scale] duration-200 hover:bg-white/[0.08] hover:text-red-300 active:scale-[0.97]"
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
        busy: saving > 0,
        error: actionError,
        clearError: () => setActionError(''),
        page,
        navigate,
        switchCompany,
        refresh,
        notify,
        mutate,
        detailId: route.id,
        auth: client ?? undefined,
      }}
    >
      <div className="min-h-dvh canvas-glow">
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 lg:block">{sidebar}</aside>
        <Dialog.Root open={mobile} onOpenChange={setMobile}>
          <Dialog.Portal>
            <Dialog.Overlay
              className="dialog-overlay fixed inset-0 z-40"
              onClick={() => setMobile(false)}
            />
            <Dialog.Content
              onInteractOutside={keepOpenForToasts}
              aria-describedby={undefined}
              className="drawer-content fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col rounded-r-[28px] bg-ink shadow-[24px_0_60px_-24px_rgb(0_0_0/0.6)] overflow-hidden"
            >
              <Dialog.Title className="sr-only">Workspace navigation</Dialog.Title>
              <div className="absolute right-3 top-4 z-10">
                <button
                  className="flex size-8 items-center justify-center rounded-full text-cream/50 transition-[background-color,color,translate,scale] duration-200 hover:bg-white/10 hover:text-white active:scale-90"
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
          <header className="glass-bar sticky top-0 z-20 flex min-h-[72px] items-center justify-between gap-3 border-b border-ink/[0.06] px-4 sm:px-8 lg:px-10">
            <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
              <button
                className="icon-btn-glass lg:hidden"
                aria-label="Open navigation"
                onClick={() => setMobile(true)}
              >
                <MenuIcon className="size-5" />
              </button>
              <span className="hidden text-[11px] font-semibold tracking-[0.14em] text-stone-500 uppercase sm:block">
                Workspace
              </span>
              <span className="hidden text-stone-300 sm:block">/</span>
              <span className="truncate font-serif text-[20px] leading-tight text-ink">
                {[...navigation, ...manageItems].find((n) => n.id === page)?.label}
              </span>
            </div>
            <div className="flex items-center gap-2 sm:gap-3 shrink-0">
              <StaffAlerts />
              <button
                type="button"
                className="btn hidden md:inline-flex"
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
                <div className="hidden sm:flex size-[34px] shrink-0 -rotate-6 items-center justify-center rounded-xl bg-ink font-serif text-[16px] text-brand-500 shadow-[0_8px_16px_-8px_rgb(14_6_4/0.7)] transition-transform duration-500 ease-[var(--ease-spring)] hover:rotate-0 hover:scale-105">
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
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] bg-ink glow-dark px-4 py-2 text-xs text-cream/60 sm:px-8 lg:px-10">
              <span>
                <span className="font-semibold text-cream">Sample workspace</span>
                <span className="mx-2">·</span>Changes saved on this local server. No real messages
                are sent.
              </span>
              <button
                className="group rounded-full px-2 py-0.5 font-semibold text-brand-500 transition-colors hover:bg-brand-500/10 hover:text-brand-400"
                onClick={() => navigate('playground')}
              >
                Try an order{' '}
                <span
                  aria-hidden
                  className="inline-block transition-transform duration-300 ease-[var(--ease-spring)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                >
                  ↗
                </span>
              </button>
            </div>
          )}
          <main id="main" className="mx-auto max-w-7xl px-4 py-6 sm:px-8 lg:px-10 lg:py-8">
            <div className="mb-4 empty:hidden">
              <ErrorNotice message={error} onDismiss={() => setError('')} />
            </div>
            <div key={data.company.id} className="page-host">
              {page === 'overview' && <Overview />}
              {page === 'orders' && <Orders />}
              {page === 'menu' && <Catalog />}
              {page === 'inbox' && <Inbox />}
              <div hidden={page !== 'playground'}>
                <Playground active={page === 'playground'} />
              </div>
              {page === 'integrations' && <Integrations />}
              {page === 'settings' && <Settings />}
              {page === 'businesses' && <Businesses />}
              {page === 'bot' && <BotSettings />}
              {page === 'flow' && <AgentFlow />}
              {page === 'activity' && <Activity />}
              {page === 'security' && <SecuritySettings />}
              {page === 'people' && (
                <Suspense fallback={<p className="text-sm text-stone-500">Loading people…</p>}>
                  <People />
                </Suspense>
              )}
            </div>
            <footer className="mt-10 flex flex-wrap justify-between gap-2 border-t border-ink/[0.06] pt-5 text-xs text-stone-400">
              <span>Orderly · Conversations to orders</span>
              <nav className="flex flex-wrap gap-3">
                <a className="transition-colors hover:text-ink" href="/privacy">
                  Privacy
                </a>
                <a className="transition-colors hover:text-ink" href="/terms">
                  Terms
                </a>
                <a className="transition-colors hover:text-ink" href="/contact">
                  Support
                </a>
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
        <ol className="stagger space-y-5 text-sm text-stone-600">
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
              'Connect your AI model with your own API key in Bot settings, then WhatsApp and Google Sheets in Integrations.',
            ],
            [
              'See how it all connects',
              'Agent flow shows every connection, what is still missing, and why the bot replied the way it did.',
            ],
          ].map(([title, copy], index) => (
            <li key={title} className="flex gap-3">
              <span className="flex size-8 shrink-0 -rotate-6 items-center justify-center rounded-xl bg-ink font-serif text-[17px] text-cream shadow-[0_8px_16px_-8px_rgb(14_6_4/0.6)]">
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
      <Toaster toasts={toasts} onDismiss={dismissToast} />
    </Workspace.Provider>
  );
}

function Brand({ dark = true }: { dark?: boolean }) {
  return (
    <div
      className={cn(
        'group flex items-center gap-3 font-serif text-[28px] font-normal leading-none tracking-[-0.01em]',
        dark ? 'text-cream' : 'text-ink',
      )}
    >
      <span className="relative flex size-10 -rotate-6 items-center justify-center rounded-xl bg-[linear-gradient(to_bottom,var(--color-canvas)_50%,var(--color-brand-500)_50%)] text-ink shadow-[0_10px_20px_-10px_rgb(255_105_44/0.7)] transition-transform duration-500 ease-[var(--ease-spring)] group-hover:rotate-3 group-hover:scale-105">
        <MessageCircle className="size-5" strokeWidth={2.5} />
        <span className="live-dot absolute right-1.5 top-1.5 size-1.5 rounded-full bg-current text-brand-500 ring-2 ring-canvas" />
      </span>
      orderly<span className="text-brand-500">.</span>
    </div>
  );
}

function FirstBusiness({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid min-h-dvh place-items-center canvas-glow px-4 py-8">
      <div className="w-full max-w-md">
        <Brand dark={false} />
        <form
          className="card enter-rise mt-8 space-y-5 p-7 sm:p-9 [--d:120ms]"
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
          <p className="text-[14px] text-stone-500 leading-relaxed">
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
          <ActionButton
            type="submit"
            className="btn-primary w-full"
            loading={busy}
            loadingLabel="Creating workspace…"
          >
            Create workspace
            <Plus className="size-4" />
          </ActionButton>
        </form>
      </div>
    </div>
  );
}

function Login({ client, notice: initialNotice }: { client: SupabaseClient; notice?: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'signin' | 'reset'>('');
  const [notice, setNotice] = useState(initialNotice ?? '');
  return (
    <div className="grid min-h-dvh place-items-center canvas-glow px-4 py-8">
      <div className="w-full max-w-md">
        <Brand dark={false} />
        <div className="card enter-rise mt-8 p-7 sm:p-9 [--d:120ms]">
          <h1 className="page-title">Welcome back.</h1>
          <p className="mb-7 mt-2 text-[13.5px] text-stone-500 leading-relaxed">
            Sign in to your restaurant workspace.
          </p>
          <form
            className="space-y-5"
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy) return;
              setBusy('signin');
              setError('');
              try {
                const result = await client.auth.signInWithPassword({ email, password });
                if (result.error) throw result.error;
              } catch (reason) {
                setError((reason as Error).message);
              } finally {
                setBusy('');
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
            <ActionButton
              type="submit"
              className="btn-primary w-full"
              disabled={busy === 'reset'}
              title={busy === 'reset' ? 'Wait for the reset email to finish sending.' : undefined}
              loading={busy === 'signin'}
              loadingLabel="Signing in…"
            >
              Sign in
              <ArrowRight className="size-4" />
            </ActionButton>
          </form>
          <ActionButton
            className="btn-quiet mt-4 w-full"
            disabled={!email || busy === 'signin'}
            title={
              !email
                ? 'Enter your email address above first.'
                : busy === 'signin'
                  ? 'Signing in…'
                  : undefined
            }
            loading={busy === 'reset'}
            loadingLabel="Sending…"
            onClick={async () => {
              if (busy) return;
              setError('');
              setBusy('reset');
              try {
                const result = await client.auth.resetPasswordForEmail(email, {
                  redirectTo: `${window.location.origin}/login?flow=recovery`,
                });
                if (result.error) throw result.error;
                setNotice('If this account exists, a password-reset link has been sent.');
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy('');
              }
            }}
          >
            Send password reset link
          </ActionButton>
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
    <main className="grid min-h-dvh place-items-center canvas-glow p-5">
      <form
        className="card enter-rise w-full max-w-md space-y-5 p-6 sm:p-8"
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
        <ActionButton
          type="submit"
          className="btn-primary w-full"
          loading={busy}
          loadingLabel="Checking…"
        >
          Continue
        </ActionButton>
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
