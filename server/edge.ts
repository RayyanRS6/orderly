import { Hono } from 'hono';
import { createApp, type AppOptions } from './app.js';
import type { Repository } from './repository.js';

/** Supabase strips /functions/v1 from the incoming request path. */
export function createEdgeApp(repo: Repository, options: AppOptions = {}) {
  const edge = new Hono();
  const app = createApp(repo, options);
  edge.all('/orderly/*', (c) => {
    const url = new URL(c.req.url);
    url.pathname = url.pathname.slice('/orderly'.length);
    return app.fetch(new Request(url, c.req.raw));
  });
  return edge;
}
