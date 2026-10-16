// Page motion, kept deliberately cheap: everything animates transform or opacity
// only, there is one observer per concern, and slow devices get the still page.
//
// Tiers (classes on <html>):
// - `lite`: no backdrop blur, no looping motion, no scroll reveals. Chosen up
//   front for low-memory / low-core devices and data saver, or later by the
//   stutter watchdog. `?lite` / `?full` in the URL force a tier for testing.
// - `reveal-on`: scroll reveals are armed (elements already on screen at
//   start-up are marked shown first, so prerendered content never flashes).

const html = () => document.documentElement;

export const isLite = () => html().classList.contains('lite');
const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const LITE_EVENT = 'perf:lite';

/** Switch the page to the lite tier at runtime (fires once). */
function goLite() {
  if (isLite()) return;
  html().classList.add('lite');
  window.dispatchEvent(new Event(LITE_EVENT));
}

/** Decide the tier before the first React render. */
export function chooseTier() {
  const c = html().classList;
  try {
    const n = navigator as Navigator & {
      deviceMemory?: number;
      connection?: { saveData?: boolean };
    };
    const q = location.search;
    const ios =
      /iP(hone|od|ad)/.test(n.userAgent) || (n.platform === 'MacIntel' && n.maxTouchPoints > 1);
    // Budget Android phones are octa-core but report 4GB or less; old laptops
    // usually report 4 cores or fewer.
    let low =
      !ios &&
      ((n.deviceMemory !== undefined && n.deviceMemory <= 4) ||
        (n.hardwareConcurrency !== undefined && n.hardwareConcurrency <= 4));
    let save = Boolean(n.connection?.saveData);
    if (/[?&]full\b/.test(q)) low = save = false;
    if (low || save || /[?&]lite\b/.test(q)) c.add('lite');
  } catch {
    // Unknown device: keep the full tier; the watchdog still guards it.
  }
}

/**
 * Fade-up reveals for `.reveal` elements below the fold. The first observer
 * pass marks everything already on screen as shown before the hidden state is
 * switched on, so nothing visible ever disappears and reappears.
 */
function initReveal(): () => void {
  if (isLite() || prefersReducedMotion() || typeof IntersectionObserver === 'undefined')
    return () => {};
  const revealer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        (e.target as HTMLElement).dataset.shown = '';
        revealer.unobserve(e.target);
      }
    },
    { rootMargin: '0px 0px -7% 0px', threshold: 0.01 },
  );
  const reveals = Array.from(document.querySelectorAll<HTMLElement>('.reveal'));
  // Only the marketing pages use reveals; the workspace never needs the observers.
  if (!reveals.length) {
    revealer.disconnect();
    return () => {};
  }
  const firstPass = new IntersectionObserver((entries) => {
    firstPass.disconnect();
    for (const e of entries) if (e.isIntersecting) (e.target as HTMLElement).dataset.shown = '';
    html().classList.add('reveal-on');
    for (const el of reveals) if (!('shown' in el.dataset)) revealer.observe(el);
  });
  for (const el of reveals) firstPass.observe(el);

  // Reveals React mounts later on the same page are picked up too.
  const watcher = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const found = node.classList.contains('reveal')
          ? [node, ...node.querySelectorAll<HTMLElement>('.reveal')]
          : node.querySelectorAll<HTMLElement>('.reveal');
        for (const el of found) if (!('shown' in el.dataset)) revealer.observe(el);
      }
    }
  });
  watcher.observe(document.body, { childList: true, subtree: true });

  const stop = () => {
    firstPass.disconnect();
    revealer.disconnect();
    watcher.disconnect();
    // Show whatever was still waiting, at once.
    html().classList.remove('reveal-on');
  };
  window.addEventListener(LITE_EVENT, stop, { once: true });
  return stop;
}

/**
 * Stutter watchdog. Counts long frames (> 50ms) that happen while the person
 * is scrolling, typing or moving the pointer; three within two seconds means
 * the device is struggling, so the page drops to the lite tier for the rest of
 * the visit. Chromium reports long frames itself; elsewhere (Firefox, Safari)
 * frame gaps are timed with requestAnimationFrame, only while input is active.
 */
function initWatchdog(): () => void {
  if (isLite()) return () => {};
  const supported =
    typeof PerformanceObserver === 'undefined'
      ? []
      : (PerformanceObserver.supportedEntryTypes ?? []);
  const type = supported.includes('long-animation-frame')
    ? 'long-animation-frame'
    : supported.includes('longtask')
      ? 'longtask'
      : null;

  let lastInput = -Infinity;
  let stopped = false;
  const hits: number[] = [];
  const hit = (at: number) => {
    hits.push(at);
    while (hits.length && at - hits[0] > 2000) hits.shift();
    if (hits.length >= 3) {
      stop();
      goLite();
    }
  };

  let po: PerformanceObserver | undefined;
  if (type) {
    po = new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        if (e.duration >= 50 && e.startTime - lastInput <= 1000) hit(e.startTime);
    });
    po.observe({ type, buffered: false });
  }

  // Fallback sampler: runs only for a second after each input, so an idle page costs nothing.
  let raf = 0;
  let prev = 0;
  const sample = (t: number) => {
    // A gap over a second is the tab coming back from the background, not a stutter.
    if (prev && t - prev > 50 && t - prev < 1000 && !document.hidden) hit(t);
    prev = t;
    raf = !stopped && t - lastInput < 1000 ? requestAnimationFrame(sample) : 0;
  };
  const onInput = () => {
    lastInput = performance.now();
    if (!type && !raf) {
      prev = 0;
      raf = requestAnimationFrame(sample);
    }
  };

  const events = ['scroll', 'wheel', 'touchmove', 'pointermove', 'keydown'] as const;
  for (const ev of events) window.addEventListener(ev, onInput, { passive: true, capture: true });

  function stop() {
    stopped = true;
    po?.disconnect();
    cancelAnimationFrame(raf);
    raf = 0;
    for (const ev of events) window.removeEventListener(ev, onInput, { capture: true });
  }
  return stop;
}

/** Start page motion once the first render is on screen. */
export function startMotion() {
  const run = () => {
    initWatchdog();
    initReveal();
  };
  // After the first paint, so measuring never competes with it.
  requestAnimationFrame(() => setTimeout(run, 0));
}
