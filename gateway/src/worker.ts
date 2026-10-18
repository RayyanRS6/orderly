import makeWASocket, {
  DEFAULT_CONNECTION_CONFIG,
  BufferJSON,
  initAuthCreds,
  proto,
  generateMessageIDV2,
  Browsers,
  type AuthenticationState,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { canonicalJid, phoneFromJid, heartbeatDue, reconnectDecision, TICK_MS } from './policy.js';
import { sendOnce, recoverUncertainSends } from './sender.js';
import { drainOnce, EVENT_BATCH, retryDeadEvents } from './drain.js';
import { chatContent, messageText, receiptStatus, upsertedMessages } from './upserts.js';
import { mapIdentity, messageIdentity } from './routing.js';
import {
  awaitsContent,
  expiredPlaceholders,
  holdPlaceholder,
  inboundTarget,
  isSeen,
  queueMessage,
} from './inbound.js';
import { signedHeaders } from '../../server/whatsapp/signing.js';
import {
  GATEWAY_HEARTBEAT_MS,
  sendCommandSchema,
  type GatewayEvent,
  type WhatsAppConnection,
} from '../../src/shared/whatsapp.js';

const config = loadConfig();
let store: Store;
let socket: WASocket | undefined;
let connectionId = '';
let generation = 0;
let status: WhatsAppConnection['status'] = 'connecting';
let errorCode: string | undefined;
let pairing: { qr?: string; code?: string; expiresAt?: string } = {};
let method: 'qr' | 'code' = 'qr';
let phone: string | undefined;
let stopped = false;
// Set once fail() has reported a fatal code; the close it causes must not overwrite it.
let failed = false;
let retries = 0;
let restarts = 0;
let openedAt = 0;
let lastStatusAt = 0;
let codeRequested = false;
let conflictLogged = false;
let draining = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let drainAgain = false;
let prunedAt = 0;
let auth: AuthenticationState;
let sendChain = Promise.resolve();
// WhatsApp asks the sender to resend a message a customer's phone could not decrypt
// (common for a first message or a new device). Without the original the reply never
// arrives, although it was accepted. Kept encrypted on disk for three days.
const SENT_RETENTION_MS = 3 * 86400000;
// Baileys has no overall connect timer: a server that never answers the upgrade leaves a
// socket that neither opens nor closes. Give up on it as a timeout (408) and retry.
const CONNECT_WATCHDOG_MS = 45000;
const encode = (value: unknown) => JSON.parse(JSON.stringify(value, BufferJSON.replacer));
const decode = <T>(value: unknown): T => JSON.parse(JSON.stringify(value), BufferJSON.reviver);
const snapshot = () => ({
  connectionId,
  generation,
  status,
  errorCode,
  ...(pairing.expiresAt && Date.parse(pairing.expiresAt) > Date.now() ? pairing : {}),
});
function report() {
  process.send?.({ type: 'snapshot', snapshot: snapshot() });
}
function persistCreds() {
  // Pairing codes are volatile even though Baileys places one inside creds.
  const { pairingCode: _code, ...creds } = auth.creds;
  store.set('auth', 'creds', encode(creds));
}
function event(partial: Partial<GatewayEvent> & { type: GatewayEvent['type'] }) {
  const value: GatewayEvent = {
    eventId: randomUUID(),
    connectionId,
    generation,
    timestamp: new Date().toISOString(),
    ...partial,
  };
  store.set(
    partial.type === 'status' ? 'status-event' : 'events',
    partial.type === 'status' ? 'latest' : value.eventId,
    value,
  );
  void drain().catch(() => fail('EVENT_STORAGE_FAILURE'));
}
function setStatus(next: typeof status, code?: string) {
  status = next;
  // While a customer message Orderly rejected is set aside, a connected phone says so: the
  // message only reached the restaurant's phone. Re-sent with every heartbeat until cleared.
  errorCode =
    code ??
    (next === 'connected' && store.count('dead-events') > 0 ? 'INBOUND_EVENT_REJECTED' : undefined);
  lastStatusAt = Date.now();
  if (next !== 'awaiting_pairing') pairing = {};
  const account = canonicalJid(socket?.user?.id);
  // QR pairing does not reliably set creds.registered in this pinned library.
  // A completed authenticated socket or signed account credentials establish identity.
  event({
    type: 'status',
    status,
    errorCode,
    ...(account && (next === 'connected' || auth.creds.account)
      ? {
          accountJid: account,
          phoneNumber: phoneFromJid(account),
          pushName: socket?.user?.name?.slice(0, 100),
        }
      : {}),
  });
  report();
}
async function drain() {
  if (!store || stopped) return;
  if (draining) {
    // An event saved during a pass is sent right after it, not on the next 15 s tick.
    drainAgain = true;
    return;
  }
  draining = true;
  try {
    let more = true;
    while (more) {
      drainAgain = false;
      const sent = await drainOnce(store, postEvent, () => drainAgain);
      more = sent !== false && (drainAgain || sent >= EVENT_BATCH);
    }
  } finally {
    draining = false;
  }
}
async function postEvent(raw: string) {
  const response = await fetch(config.eventsUrl, {
    method: 'POST',
    headers: signedHeaders(config.secret, 'event', '/api/whatsapp/gateway/events', raw),
    body: raw,
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  await response.body?.cancel().catch(() => undefined);
  return response.status;
}
function receipt(key: proto.IMessageKey, status?: number | null) {
  const value = receiptStatus(status);
  // Only replies this gateway sent; messages staff type on the phone are not tracked.
  if (!value || !key.fromMe || !key.id || !store.get('own', key.id)) return;
  const id = `${key.id}:${value}`;
  if (store.get('receipt-events', id) || store.count('receipt-events') >= 2000) return;
  store.set('receipt-events', id, {
    eventId: randomUUID(),
    connectionId,
    generation,
    type: 'receipt',
    messageId: key.id,
    receipt: value,
    timestamp: new Date().toISOString(),
  } satisfies GatewayEvent);
  void drain().catch(() => fail('EVENT_STORAGE_FAILURE'));
}
function pruneSent() {
  if (Date.now() - prunedAt < 3600000) return;
  prunedAt = Date.now();
  for (const row of store.list<{ at: number }>('sent'))
    if (Date.now() - row.value.at > SENT_RETENTION_MS) store.delete('sent', row.id);
}
// The business's own JIDs, never mapped to a customer.
const self = () => [canonicalJid(socket?.user?.id), canonicalJid(socket?.user?.lid)];
function linkIdentity(lid?: string | null, pn?: string | null) {
  if (mapIdentity(store, lid, pn, self()) === 'conflict' && !conflictLogged) {
    conflictLogged = true;
    // Code only: no JIDs or phone numbers in logs.
    process.send?.({ type: 'warning', code: 'ROUTE_CONFLICT' });
  }
}
function incoming(message: WAMessage) {
  const target = inboundTarget(store, message);
  if (!target) return;
  const { id, native, held, fromMe } = target;
  if (fromMe && store.get('own', id)) return;
  const timestamp = Number(message.messageTimestamp) * 1000;
  if (
    !Number.isFinite(timestamp) ||
    timestamp > Date.now() + 60000 ||
    timestamp < Date.now() - 86400000
  )
    return;
  const content = chatContent(message.message);
  if (!content) {
    // Held until its content arrives; staff are told if it never does (see the tick below).
    if (awaitsContent(message) && !isSeen(store, native, id, fromMe))
      holdPlaceholder(store, id, native, timestamp, Date.now());
    return;
  }
  if (isSeen(store, native, id, fromMe)) {
    if (held) store.delete('placeholder', id);
    return;
  }
  // Before choosing the chat: a LID message that names the customer's phone joins the chat
  // already kept for that phone, and the other way round.
  const identity = messageIdentity(native, message.key);
  if (identity) linkIdentity(identity.lid, identity.pn);
  enqueue(native, id, timestamp, messageText(content), fromMe);
}
function enqueue(native: string, id: string, timestamp: number, text: string, fromMe: boolean) {
  if (store.count('events') >= 10000) {
    fail('INBOUND_QUEUE_FULL');
    return;
  }
  queueMessage(store, { connectionId, generation, native, id, timestamp, text, fromMe });
  void drain().catch(() => fail('EVENT_STORAGE_FAILURE'));
}
// A customer message whose content never reached this device goes to staff (as unsupported
// media does) instead of vanishing. Copies that arrived meanwhile were already taken.
function releasePlaceholders() {
  const now = Date.now();
  for (const { id, value } of expiredPlaceholders(store, now)) {
    if (value.timestamp >= now - 86400000 && !isSeen(store, value.native, id, false))
      enqueue(value.native, id, value.timestamp, '', false);
    else store.delete('placeholder', id);
  }
}
function fail(code: string) {
  if (stopped || failed) return;
  failed = true;
  try {
    setStatus('error', code);
    socket?.end(new Error(code));
  } catch {
    /* fatal exit below */
  }
  process.send?.({ type: 'fatal', errorCode: code });
  setTimeout(() => process.exit(1), 100).unref();
}
function guard(work: () => void | Promise<void>) {
  Promise.resolve()
    .then(work)
    .catch(() => fail('SESSION_HANDLER_FAILURE'));
}
async function connect() {
  if (stopped || failed) return;
  codeRequested = false;
  // End any previous socket before replacing it. It is detached first, so its close event
  // cannot schedule a second reconnect; ending a closed socket does nothing.
  const previous = socket;
  socket = undefined;
  previous?.end(new Error('REPLACED'));
  const version =
    config.version ??
    store.get<[number, number, number]>('protocol', 'last-good:6.7.22') ??
    DEFAULT_CONNECTION_CONFIG.version;
  const currentSocket = makeWASocket({
    auth,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    version,
    printQRInTerminal: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: false,
    // Our own sends would otherwise leave Baileys buffering events until the next
    // incoming node, batching customer messages and ticks behind them (see upserts.ts).
    emitOwnEvents: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 20000,
    defaultQueryTimeoutMs: 15000,
    keepAliveIntervalMs: 20000,
    getMessage: async (key) => {
      const saved = key.id ? store.get<{ message: unknown }>('sent', key.id) : undefined;
      return saved ? decode<proto.IMessage>(saved.message) : undefined;
    },
  });
  socket = currentSocket;
  // Only for an already paired account: pairing waits for the owner, not for the network.
  const watchdog = auth.creds.account
    ? setTimeout(() => {
        if (socket === currentSocket)
          currentSocket.end(
            Object.assign(new Error('CONNECT_TIMEOUT'), { output: { statusCode: 408 } }),
          );
      }, CONNECT_WATCHDOG_MS)
    : undefined;
  // Messages delivered after a reconnect are processed outside Baileys' per-node flush,
  // so the last ones can wait in its event buffer until the next live node, which can be
  // hours away on a quiet account. Flush it ourselves, and on close (below).
  const flushTimer = setInterval(() => {
    if (socket !== currentSocket) clearInterval(flushTimer);
    else if (currentSocket.ev.isBuffering()) currentSocket.ev.flush();
  }, 1000);
  currentSocket.ev.on('creds.update', () => guard(persistCreds));
  currentSocket.ev.on('chats.phoneNumberShare', ({ lid, jid }) =>
    guard(() => linkIdentity(lid, jid)),
  );
  for (const name of ['contacts.upsert', 'contacts.update'] as const)
    currentSocket.ev.on(name, (contacts) =>
      guard(() => {
        for (const c of contacts)
          linkIdentity(
            c.lid ?? (c.id?.endsWith('@lid') ? c.id : undefined),
            c.jid ?? (c.id?.endsWith('@s.whatsapp.net') ? c.id : undefined),
          );
      }),
    );
  currentSocket.ev.on('messages.upsert', (update) =>
    guard(() => {
      // Never filter by update.type (see upserts.ts): it dropped customer messages that
      // were batched behind our own reply or delivered after a reconnect. incoming()
      // skips our own replies, old and duplicate messages; history sync is disabled.
      if (currentSocket !== socket) return;
      const held = (id: string) => !!store.get('placeholder', id);
      for (const message of upsertedMessages(update, held)) {
        receipt(message.key, message.status);
        incoming(message);
      }
    }),
  );
  currentSocket.ev.on('messages.update', (updates) =>
    guard(() => {
      if (currentSocket !== socket) return;
      for (const { key, update } of updates) receipt(key, update.status);
    }),
  );
  currentSocket.ev.on('connection.update', (update) =>
    guard(async () => {
      if (stopped || socket !== currentSocket) return;
      if (update.qr && !auth.creds.account) {
        if (method === 'code') {
          if (!codeRequested) {
            codeRequested = true;
            const code = await currentSocket.requestPairingCode(phone!);
            if (stopped || socket !== currentSocket) return;
            setStatus('awaiting_pairing');
            pairing = { code, expiresAt: new Date(Date.now() + 60000).toISOString() };
            report();
          }
        } else {
          const qr = await QRCode.toDataURL(update.qr, { errorCorrectionLevel: 'M', width: 280 });
          if (stopped || socket !== currentSocket) return;
          setStatus('awaiting_pairing');
          pairing = { qr, expiresAt: new Date(Date.now() + 20000).toISOString() };
          report();
        }
      }
      if (update.connection === 'open') {
        clearTimeout(watchdog);
        openedAt = Date.now();
        restarts = 0;
        persistCreds();
        if (!canonicalJid(currentSocket.user?.id)) {
          fail('INVALID_ACCOUNT_IDENTITY');
          return;
        }
        store.set('protocol', 'last-good:6.7.22', version);
        setStatus('connected');
      }
      if (update.connection === 'close') {
        // Hand over anything still buffered while this socket is current; a new socket
        // starts with an empty buffer and WhatsApp will not deliver these again.
        clearInterval(flushTimer);
        clearTimeout(watchdog);
        currentSocket.ev.flush();
        pairing = {};
        // fail() already reported why this worker is stopping.
        if (failed) return;
        const code =
          (update.lastDisconnect?.error as { output?: { statusCode?: number } })?.output
            ?.statusCode ?? 0;
        if (openedAt && Date.now() - openedAt > 120000) retries = 0;
        openedAt = 0;
        const decision = reconnectDecision(code, retries + 1, restarts);
        if (decision.action === 'logout') {
          store.clear('auth');
          setStatus('logged_out', 'LOGGED_OUT');
          return;
        }
        if (decision.action === 'stop') {
          setStatus('error', `DISCONNECT_${code}`);
          return;
        }
        // A requested restart is not a failure; everything else counts towards the backoff.
        if (decision.action === 'restart') restarts++;
        else retries++;
        setStatus('reconnecting', `DISCONNECT_${code}`);
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => guard(connect), decision.delayMs);
      }
    }),
  );
}
async function send(input: unknown) {
  const body = sendCommandSchema.parse(input);
  if (body.connectionId !== connectionId || body.generation !== generation || stopped)
    throw new Error('STALE_GENERATION');
  if (!socket || status !== 'connected') throw new Error('NOT_CONNECTED');
  if (
    Date.now() - Date.parse(body.lastInboundAt) >= 86400000 ||
    Date.parse(body.lastInboundAt) > Date.now() + 60000
  )
    throw new Error('REPLY_WINDOW_CLOSED');
  const messageId = generateMessageIDV2(socket.user?.id);
  return sendOnce(store, body, messageId, async () => {
    const sent = await socket!.sendMessage(body.peer, { text: body.text }, { messageId });
    if (sent?.key.id && sent.message)
      store.set('sent', sent.key.id, { at: Date.now(), message: encode(sent.message) });
    return sent?.key.id ?? '';
  });
}
process.on('message', (message: any) => {
  if (message.type === 'init')
    guard(async () => {
      connectionId = message.connectionId;
      generation = message.generation;
      method = message.method ?? 'qr';
      phone = message.phone;
      store = new Store(join(config.dataDir, `${connectionId}.sqlite`), config.key);
      const stored = store.get<unknown>('auth', 'creds');
      auth = {
        creds: stored ? decode(stored) : initAuthCreds(),
        keys: {
          get: async (type, ids) => {
            const result: any = {};
            for (const id of ids) {
              const value = store.get('auth', `${type}:${id}`);
              if (value)
                result[id] =
                  type === 'app-state-sync-key'
                    ? proto.Message.AppStateSyncKeyData.fromObject(decode(value))
                    : decode(value);
            }
            return result;
          },
          set: async (data) =>
            store.transaction(() => {
              for (const [type, values] of Object.entries(data))
                for (const [id, value] of Object.entries(values ?? {})) {
                  if (value == null) store.delete('auth', `${type}:${id}`);
                  else store.set('auth', `${type}:${id}`, encode(value));
                }
            }),
        },
      };
      recoverUncertainSends(store);
      setStatus('connecting');
      await connect();
    });
  if (message.type === 'send') {
    sendChain = sendChain
      .then(async () => {
        try {
          process.send?.({
            type: 'result',
            requestId: message.requestId,
            result: await send(message.body),
          });
        } catch (error) {
          process.send?.({
            type: 'result',
            requestId: message.requestId,
            errorCode:
              error instanceof Error &&
              [
                'SEND_UNCERTAIN',
                'IDEMPOTENCY_CONFLICT',
                'STALE_GENERATION',
                'NOT_CONNECTED',
                'REPLY_WINDOW_CLOSED',
              ].includes(error.message)
                ? error.message
                : 'SEND_FAILED',
          });
        }
      })
      .catch(() => fail('SEND_HANDLER_FAILURE'));
  }
  if (message.type === 'stop') {
    // Save anything Baileys still buffers first: incoming() runs as a microtask and
    // writes to disk synchronously, so it finishes before the exit below.
    socket?.ev.flush();
    stopped = true;
    clearTimeout(reconnectTimer);
    pairing = {};
    // Closing is not logging out: planned restarts must retain credentials.
    socket?.end(new Error('STOPPED'));
    setImmediate(() => process.exit(0));
  }
});
// Each status report is one Orderly function call, so an unchanged 'connected' is repeated
// only once per heartbeat interval. Real changes are reported at once by setStatus, and the
// tick still retries anything Orderly could not take.
setInterval(
  () =>
    guard(async () => {
      if (!store || stopped) return;
      if (status === 'connected' && heartbeatDue(lastStatusAt, Date.now(), GATEWAY_HEARTBEAT_MS))
        setStatus('connected');
      pruneSent();
      releasePlaceholders();
      await drain();
      await retryDeadEvents(store, postEvent);
    }),
  TICK_MS,
).unref();
// Record only safe codes; do not resume an undefined process state.
process.on('uncaughtException', () => {
  process.send?.({ type: 'fatal', errorCode: 'UNCAUGHT_EXCEPTION' });
  process.exit(1);
});
process.on('unhandledRejection', () => {
  process.send?.({ type: 'fatal', errorCode: 'UNHANDLED_REJECTION' });
  process.exit(1);
});
process.on('disconnect', () => process.exit(0));
