export type ReconnectAction = 'logout' | 'stop' | 'restart' | 'retry';
// 401: WhatsApp removed this linked device. 403/411: the account or device is refused. 405:
// this web version is outdated, so only a new GATEWAY_WA_VERSION helps. 440: another copy of
// the session took over; retrying would make the two fight.
const STOP_CODES = [403, 405, 411, 440];
// Network loss, timeouts and WhatsApp being unavailable clear by themselves.
const NETWORK_CODES = [408, 428, 503];
// Baileys asks for a restart (515) right after pairing. Repeated restarts that never open the
// socket are treated as failures, so they back off instead of looping.
const MAX_RESTARTS = 3;
const FAST_PHASE = 10;
// Never give up on a failure that can clear by itself: back off to a minute, then retry every
// five minutes. 500, 0 and unknown codes (Baileys' generic stream errors) start slower.
export function reconnectDecision(
  code: number,
  attempt: number,
  restarts = 0,
  random = Math.random(),
): { action: ReconnectAction; delayMs: number } {
  if (code === 401) return { action: 'logout', delayMs: 0 };
  if (STOP_CODES.includes(code)) return { action: 'stop', delayMs: 0 };
  if (code === 515 && restarts < MAX_RESTARTS) return { action: 'restart', delayMs: 0 };
  const n = Math.max(1, attempt);
  const base = NETWORK_CODES.includes(code)
    ? n > FAST_PHASE
      ? 300000
      : Math.min(60000, 1000 * 2 ** (n - 1))
    : Math.min(300000, 5000 * 2 ** (n - 1));
  return { action: 'retry', delayMs: Math.round(base * (0.75 + random * 0.5)) };
}
// The retries above are for numbers that finished pairing. A pairing nobody finishes must end:
// every retry opens a new WhatsApp registration with new QR codes. WhatsApp ends one whose QR
// codes ran out with 408; that, or a second passing failure, ends it as PAIRING_EXPIRED and the
// owner starts a new pairing. Once a pairing code was asked for, the number is in the
// credentials and a retry would try to log in as it, so there is no retry then either.
export function retryPairing(code: number, retried: boolean, codeRequested: boolean): boolean {
  return code !== 408 && !retried && !codeRequested;
}
// A pairing not finished by then ends as PAIRING_EXPIRED, even if WhatsApp never closes the
// socket (unpaired sockets have no connect watchdog, so this one frees the place).
export const PAIRING_TIMEOUT_MS = 300000;
// Worker failures a fresh process can recover from. INVALID_ACCOUNT_IDENTITY and pairing
// problems need the owner instead. SESSION_CAPACITY_REACHED: a paired number a full gateway left
// stopped at start-up; it starts once a place is free, or at the next start.
export const RESTARTABLE_FAILURES = [
  'SESSION_CAPACITY_REACHED',
  'RECONNECT_EXHAUSTED',
  'SESSION_CRASH',
  'EVENT_STORAGE_FAILURE',
  'SESSION_HANDLER_FAILURE',
  'SEND_HANDLER_FAILURE',
  'UNCAUGHT_EXCEPTION',
  'UNHANDLED_REJECTION',
  'INBOUND_QUEUE_FULL',
];
// Sessions a gateway restart brings back by itself, if they finished pairing (see
// Supervisor.restore). Older gateways parked these in 'error'.
export function restorable(status: string, errorCode?: string): boolean {
  if (['connected', 'connecting', 'reconnecting'].includes(status)) return true;
  if (status !== 'error' || !errorCode) return false;
  const disconnect = errorCode.match(/^DISCONNECT_(\d+)$/);
  if (disconnect) return ['retry', 'restart'].includes(reconnectDecision(+disconnect[1], 1).action);
  return RESTARTABLE_FAILURES.includes(errorCode);
}
// Crashed workers keep restarting: quickly at first, then at most every 30 minutes.
export function crashRestartDelay(crashes: number, random = Math.random()): number {
  return Math.round(
    Math.min(1800000, 1000 * 2 ** Math.max(0, crashes - 1)) * (0.75 + random * 0.5),
  );
}
// A session that stays connected this long is healthy again; earlier crashes are forgiven.
export const HEALTHY_AFTER_MS = 600000;
// The worker's housekeeping tick. It retries failed deliveries to Orderly every time, but
// re-sends an unchanged 'connected' status only once per heartbeat interval.
export const TICK_MS = 15000;
export function heartbeatDue(lastStatusAt: number, now: number, intervalMs: number): boolean {
  // Half a tick of slack, so timer drift never pushes a beat to the following tick.
  return now - lastStatusAt >= intervalMs - TICK_MS / 2;
}
export function canonicalJid(value?: string | null): string | undefined {
  const match = value?.match(/^(\d{5,20})(?::\d+)?@(s\.whatsapp\.net|lid)$/);
  return match ? `${match[1]}@${match[2]}` : undefined;
}
export function phoneFromJid(value?: string): string | undefined {
  const jid = canonicalJid(value);
  return jid?.endsWith('@s.whatsapp.net') && /^[1-9]\d{5,14}@/.test(jid)
    ? `+${jid.split('@')[0]}`
    : undefined;
}
