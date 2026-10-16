import { StrictMode, type ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import { LegalPage } from './components/Legal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Landing, Contact, NotFound, Pricing } from './components/Public';
import { parseRoute } from './lib/routes';
import { chooseTier, startMotion } from './lib/motion';
// Self-hosted fonts; each subset downloads only when a page uses its characters.
import '@fontsource/instrument-serif/400.css';
import '@fontsource-variable/inter-tight/wght.css';
import './index.css';

// Slow devices get the lite tier (no blur, no looping motion) before anything renders.
chooseTier();

const legalPages = {
  '/privacy': 'privacy',
  '/terms': 'terms',
  '/data-deletion': 'data-deletion',
} as const;

function getLegalKind(): 'privacy' | 'terms' | 'data-deletion' | undefined {
  if (typeof window === 'undefined') return undefined;
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  return legalPages[pathname as keyof typeof legalPages];
}

const legalKind = getLegalKind();
const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
const publicPaths = ['/', '/pricing', '/contact'];
// The workspace (dashboard, dialogs, sign-in) is its own chunk that only /app and /login
// download, so the public pages load a fraction of the JavaScript.
const isWorkspace = !legalKind && !publicPaths.includes(pathname) && parseRoute(pathname).valid;
const publicPage = legalKind ? (
  <LegalPage kind={legalKind} />
) : pathname === '/' ? (
  <Landing />
) : pathname === '/pricing' ? (
  <Pricing />
) : pathname === '/contact' ? (
  <Contact />
) : (
  <NotFound />
);
const rootElement = typeof document !== 'undefined' ? document.getElementById('root') : null;

const wrap = (page: ReactNode) => (
  <StrictMode>
    <ErrorBoundary>{page}</ErrorBoundary>
  </StrictMode>
);

/** Re-throws a failed workspace download inside ErrorBoundary, which offers a reload. */
function LoadFailed({ error }: { error: Error }): never {
  throw error;
}

if (rootElement) {
  if (isWorkspace) {
    // The page's own "Opening your workspace…" shell stays up until the code arrives.
    import('./App').then(
      ({ default: App }) => ReactDOM.createRoot(rootElement).render(wrap(<App />)),
      (error: Error) => ReactDOM.createRoot(rootElement).render(wrap(<LoadFailed error={error} />)),
    );
  } else {
    // Public pages ship prerendered HTML (scripts/prerender-public.mjs), marked with the
    // path it was rendered for. When it is this page, hydrating it in place keeps the
    // painted page instead of rebuilding it, so its entrance animations play only once.
    const prerenderedAs = legalKind
      ? `/${legalKind}`
      : publicPaths.includes(pathname)
        ? pathname
        : '/404';
    if (rootElement.getAttribute('data-prerendered') === prerenderedAs)
      ReactDOM.hydrateRoot(rootElement, wrap(publicPage));
    else ReactDOM.createRoot(rootElement).render(wrap(publicPage));
  }
  startMotion();
}
