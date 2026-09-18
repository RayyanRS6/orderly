import { renderToStaticMarkup } from 'react-dom/server';
import { Landing, Contact, NotFound, Pricing } from './components/Public';
import { LegalPage } from './components/Legal';

export function renderPublic(path: string) {
  const page =
    path === '/' ? (
      <Landing />
    ) : path === '/pricing' ? (
      <Pricing />
    ) : path === '/contact' ? (
      <Contact />
    ) : path === '/privacy' || path === '/terms' || path === '/data-deletion' ? (
      <LegalPage kind={path.slice(1) as 'privacy' | 'terms' | 'data-deletion'} />
    ) : (
      <NotFound />
    );
  return renderToStaticMarkup(page);
}
