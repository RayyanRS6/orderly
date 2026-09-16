import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { LegalPage } from './components/Legal';
import { ErrorBoundary } from './components/ui';
import './index.css';

const legalPages = {
  '/privacy': 'privacy',
  '/terms': 'terms',
  '/data-deletion': 'data-deletion',
} as const;

function getLegalKind(): 'privacy' | 'terms' | 'data-deletion' | undefined {
  if (typeof window === 'undefined') return undefined;
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  if (pathname.endsWith('/privacy')) return 'privacy';
  if (pathname.endsWith('/terms')) return 'terms';
  if (pathname.endsWith('/data-deletion')) return 'data-deletion';
  return legalPages[pathname as keyof typeof legalPages];
}

const legalKind = getLegalKind();
const rootElement = typeof document !== 'undefined' ? document.getElementById('root') : null;

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ErrorBoundary>{legalKind ? <LegalPage kind={legalKind} /> : <App />}</ErrorBoundary>
    </React.StrictMode>,
  );
}
