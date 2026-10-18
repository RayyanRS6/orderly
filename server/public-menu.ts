import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Repository } from './repository.js';
import { MENU_SLUG_RE } from '../src/shared/menu.js';
import { createMenuDraftFor, MenuError, menuSession, placeLinkOrder, publicMenu } from './menu.js';
import { PublicError, logFailure } from './security.js';
import { webCartSchema } from './validation.js';

// Routes for the public menu page (/m/<slug>), mounted before sign-in. Every handler answers
// {error, code, total?} itself instead of relying on the app's error handler.
const NOT_FOUND = { error: "This menu isn't available right now.", code: 'not_found' };
const validSlug = (slug: string) => slug.length <= 80 && MENU_SLUG_RE.test(slug);
const token = z.string().min(1).max(200);
const sessionSchema = z.object({ token }).strict();
const orderSchema = z
  .object({ token, cart: webCartSchema, expectedTotal: z.number().int().min(0) })
  .strict();
const draftSchema = z
  .object({
    phone: z.string().max(40),
    cart: webCartSchema,
    expectedTotal: z.number().int().min(0),
  })
  .strict();
// A friendly sentence for a form problem, never the raw field list.
function invalid(c: Context, error: z.ZodError) {
  const field = String(
    [...(error.issues[0]?.path ?? [])].reverse().find((part) => typeof part === 'string') ?? '',
  );
  const message =
    field === 'customerName'
      ? 'Please give a name between 2 and 80 characters.'
      : field === 'address'
        ? 'Please give a complete address between 5 and 400 characters.'
        : field === 'phone'
          ? 'Please enter your WhatsApp number, for example 0300 1234567.'
          : 'Please check your order and try again.';
  return c.json({ error: message, code: 'invalid' }, 422);
}
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
  // Logged without the cart, phone or token; the slug in the path names the restaurant.
  const requestId = c.get('requestId');
  logFailure(
    'request_failed',
    { method: c.req.method, route: c.req.path.slice(0, 120), requestId },
    error,
  );
  return c.json(
    { error: 'Something went wrong. Please try again in a moment.', code: 'error', requestId },
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
  // A personal link (#t=… on the page): what it can do, then the one-tap order.
  app.post('/menu/:slug/session', async (c) => {
    const slug = c.req.param('slug');
    if (!validSlug(slug)) return c.json(NOT_FOUND, 404);
    try {
      const body = sessionSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return c.json({ state: 'invalid' }, 200);
      return c.json(await menuSession(repo, slug, body.data.token, c.req.raw.headers));
    } catch (error) {
      return failure(c, error);
    }
  });
  // Instagram/QR: the order waits for its code to arrive from the customer's own WhatsApp.
  app.post('/menu/:slug/drafts', async (c) => {
    const slug = c.req.param('slug');
    if (!validSlug(slug)) return c.json(NOT_FOUND, 404);
    try {
      const body = draftSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return invalid(c, body.error);
      return c.json(
        await createMenuDraftFor(repo, { slug, ...body.data, headers: c.req.raw.headers }),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post('/menu/:slug/orders', async (c) => {
    const slug = c.req.param('slug');
    if (!validSlug(slug)) return c.json(NOT_FOUND, 404);
    try {
      const body = orderSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return invalid(c, body.error);
      return c.json(await placeLinkOrder(repo, { slug, ...body.data, headers: c.req.raw.headers }));
    } catch (error) {
      return failure(c, error);
    }
  });
  return app;
}
