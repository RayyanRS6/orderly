import type { Trace } from '../shared/types';

// Background checks for the dashboard. Supabase's Free plan counts every request to the backend,
// so a page asks again only while it is on screen, and fetches lists and chats again only when
// the workspace's own numbers or events say something changed.

/** How often Overview, Orders, Inbox and Activity check the workspace for news. */
export const ACTIVITY_POLL_MS = 15000;
/** How often an open chat checks for delivery ticks while one of its replies waits for one. */
export const CHAT_POLL_MS = 30000;
/** How often every page checks whether Orderly's emergency stop started or ended. */
export const CONFIG_POLL_MS = 5 * 60000;

/**
 * Runs `tick` every `ms` while this tab is on screen. A hidden tab asks nothing. Shown again after
 * a check fell due, it checks at once and keeps the rhythm from there. Returns the stop function.
 */
export function pollWhileVisible(tick: () => void, ms: number): () => void {
  let last = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  const run = () => {
    last = Date.now();
    tick();
  };
  const start = () => {
    timer ??= setInterval(run, ms);
  };
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };
  const visibility = () => {
    if (document.hidden) return stop();
    if (!timer && Date.now() - last >= ms) run();
    start();
  };
  document.addEventListener('visibilitychange', visibility);
  if (!document.hidden) start();
  return () => {
    stop();
    document.removeEventListener('visibilitychange', visibility);
  };
}

/**
 * The id of the newest recorded event that `include` accepts, or null. It stays the same while
 * other events come in, and when older ones drop off the end of the recent-events list.
 */
export function newestEvent(traces: Trace[] | undefined, include: (t: Trace) => boolean) {
  let newest: Trace | undefined;
  for (const t of traces ?? [])
    if (
      include(t) &&
      (!newest ||
        t.createdAt > newest.createdAt ||
        (t.createdAt === newest.createdAt && t.id > newest.id))
    )
      newest = t;
  return newest?.id ?? null;
}
