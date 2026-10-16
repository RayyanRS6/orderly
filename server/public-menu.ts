import { Hono, type Context } from 'hono';
import type { Repository } from './repository.js';
import { MENU_SLUG_RE } from '../src/shared/menu.js';
import { MenuError, publicMenu } from './menu.js';
import { PublicError } from './security.js';

// Routes for the public menu page (/m/<slug>), mounted before sign-in. Every handler answers
// {error, code, total?} itself instead of relying on the app's error handler.
const NOT_FOUND = { error: "This menu isn't available right now.", code: 'not_found' };
const validSlug = (slug: string) => slug.length <= 80 && MENU_SLUG_RE.test(slug);
function failure(c: Context, error: unknown) {
  if (error instanceof MenuError)
    return c.json(
      {
        error: error.message,
        code: error.code,
        ...(error.total !== undefined && { total: error.total }),
      },
      error.status as 400,
    );
  if (error instanceof PublicError)
    return c.json({ error: error.message, code: 'error' }, error.status as 400);
  return c.json(
    { error: 'Something went wrong. Please try again in a moment.', code: 'error' },
    500,
  );
}

export function publicMenuRoutes(repo: Repository) {
  const app = new Hono();
  app.get('/menu/:slug', async (c) => {
    const slug = c.req.param('slug');
    if (!validSlug(slug)) return c.json(NOT_FOUND, 404);
    try {
      const menu = await publicMenu(repo, slug, new Date().toISOString());
      c.header('Cache-Control', 'public, max-age=30');
      return c.json(menu);
    } catch (error) {
      return failure(c, error);
    }
  });
  return app;
}
