import { useEffect, useState } from 'react';
import type { Page } from './workspace';
export const pages = [
  'overview',
  'orders',
  'inbox',
  'menu',
  'playground',
  'bot',
  'activity',
  'integrations',
  'settings',
  'security',
  'businesses',
] as const;
export function parseRoute(path: string): {
  slug?: string;
  page: Page;
  id?: string;
  valid: boolean;
} {
  const pieces = path.replace(/\/+$/, '').split('/').filter(Boolean);
  if (pieces.length === 1 && ['app', 'login'].includes(pieces[0]))
    return { page: 'overview', valid: true };
  if (pieces[0] !== 'app' || pieces.length < 2 || pieces.length > 4)
    return { page: 'overview', valid: false };
  const page = (pieces[2] ?? 'overview') as Page;
  const valid =
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pieces[1]) &&
    pages.includes(page) &&
    (!pieces[3] || (['orders', 'inbox'].includes(page) && /^[a-z0-9-]+$/i.test(pieces[3])));
  return { slug: pieces[1], page, id: pieces[3], valid };
}
export const workspacePath = (slug: string, page: Page = 'overview', id?: string) =>
  `/app/${encodeURIComponent(slug)}/${page}${id ? `/${encodeURIComponent(id)}` : ''}`;
export function go(path: string, replace = false) {
  window.history[replace ? 'replaceState' : 'pushState']({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
export function useRoute() {
  const [route, setRoute] = useState(() =>
    parseRoute(typeof window === 'undefined' ? '/app' : window.location.pathname),
  );
  useEffect(() => {
    const change = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', change);
    return () => window.removeEventListener('popstate', change);
  }, []);
  return route;
}
