import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { LegalPage } from './components/Legal';
import { ErrorBoundary } from './components/ui';
import { Landing, Contact, NotFound, Pricing } from './components/Public';
import { parseRoute } from './lib/routes';
import './index.css';

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
const content = legalKind ? (
  <LegalPage kind={legalKind} />
) : pathname === '/' ? (
  <Landing />
) : pathname === '/pricing' ? (
  <Pricing />
) : pathname === '/contact' ? (
  <Contact />
) : parseRoute(pathname).valid ? (
  <App />
) : (
  <NotFound />
);
const rootElement = typeof document !== 'undefined' ? document.getElementById('root') : null;

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ErrorBoundary>{content}</ErrorBoundary>
    </React.StrictMode>,
  );
}
