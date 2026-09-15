import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { LegalPage } from './components/Legal';
import './index.css';

const legalPages = {
  '/privacy': 'privacy',
  '/terms': 'terms',
  '/data-deletion': 'data-deletion',
} as const;
const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
const legalKind = legalPages[pathname as keyof typeof legalPages];

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {legalKind ? <LegalPage kind={legalKind} /> : <App />}
  </React.StrictMode>,
);
