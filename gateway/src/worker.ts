import makeWASocket, {
  DEFAULT_CONNECTION_CONFIG,
  BufferJSON,
  initAuthCreds,
  proto,
  normalizeMessageContent,
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
import { canonicalJid, phoneFromJid, disconnectPolicy, retryDelay } from './policy.js';
import { sendOnce, recoverUncertainSends } from './sender.js';
import { signedHeaders } from '../../server/whatsapp/signing.js';
import {
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
let retries = 0;
let openedAt = 0;
let codeRequested = false;
let draining = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let auth: AuthenticationState;
let sendChain = Promise.resolve();
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
  errorCode = code;
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
  if (draining || !store || stopped) return;
  draining = true;
  try {
    // Status first so the backend knows the account before accepting messages.
    const rows = [
      ...store.list<GatewayEvent>('status-event').map((r) => ({ ...r, namespace: 'status-event' })),
      ...store.list<GatewayEvent>('events', 50).map((r) => ({ ...r, namespace: 'events' })),
    ];
    for (const row of rows) {
      const raw = JSON.stringify(row.value);
      let response: Response;
      try {
        response = await fetch(config.eventsUrl, {
          method: 'POST',
          headers: signedHeaders(config.secret, 'event', '/api/whatsapp/gateway/events', raw),
          body: raw,
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        });
      } catch {
        break;
      }
      if (!response.ok) {
        // Never silently discard an event or endlessly grow memory. Backend failures
        // are retried from encrypted disk; an operator can inspect queue counts.
        break;
      }
      if (store.get<GatewayEvent>(row.namespace, row.id)?.eventId === row.value.eventId)
        store.delete(row.namespace, row.id);
    }
  } finally {
    draining = false;
  }
}
function mapIdentity(lidValue?: string, pnValue?: string) {
  const lid = canonicalJid(lidValue);
  const pn = canonicalJid(pnValue);
  if (!lid?.endsWith('@lid') || !pn?.endsWith('@s.whatsapp.net')) return;
  store.transaction(() => {
    const route = store.get<string>('route', lid) ?? store.get<string>('route', pn) ?? lid;
    store.set('identity', lid, pn);
    store.set('route', lid, route);
    store.set('route', pn, route);
  });
}
function incoming(message: WAMessage) {
  const native = canonicalJid(message.key.remoteJid);
  const id = message.key.id;
  if (
    !native ||
    !id ||
    !message.message ||
    message.message.protocolMessage ||
    message.message.reactionMessage
  )
    return;
  if (message.key.fromMe && store.get('own', id)) return;
  const timestamp = Number(message.messageTimestamp) * 1000;
  if (
    !Number.isFinite(timestamp) ||
    timestamp > Date.now() + 60000 ||
    timestamp < Date.now() - 86400000
  )
    return;
  const seenId = `${native}:${id}`;
  if (store.get('seen', seenId)) return;
  if (store.count('events') >= 10000) {
    fail('INBOUND_QUEUE_FULL');
    return;
  }
  const peer = store.get<string>('route', native) ?? native;
  store.set('route', native, peer);
  const content = normalizeMessageContent(message.message);
  const text = (content?.conversation ?? content?.extendedTextMessage?.text ?? '').slice(0, 4000);
  const mapped = store.get<string>('identity', native);
  store.transaction(() => {
    // Durable dedupe and enqueue commit together, before the model can be called.
    const value: GatewayEvent = {
      eventId: randomUUID(),
      connectionId,
      generation,
      type: 'message',
      peer,
      messageId: id,
      text,
      fromMe: !!message.key.fromMe,
      unsupported: !text,
      phoneNumber: phoneFromJid(mapped ?? native),
      timestamp: new Date(timestamp).toISOString(),
    };
    store.set('events', value.eventId, value);
    store.set('seen', seenId, Date.now());
  });
  void drain().catch(() => fail('EVENT_STORAGE_FAILURE'));
}
function fail(code: string) {
  if (stopped) return;
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
  if (stopped) return;
  codeRequested = false;
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
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 20000,
    defaultQueryTimeoutMs: 15000,
    keepAliveIntervalMs: 20000,
    getMessage: async () => undefined,
  });
  socket = currentSocket;
  currentSocket.ev.on('creds.update', () => guard(persistCreds));
  currentSocket.ev.on('chats.phoneNumberShare', ({ lid, jid }) =>
    guard(() => mapIdentity(lid, jid)),
  );
  for (const name of ['contacts.upsert', 'contacts.update'] as const)
    currentSocket.ev.on(name, (contacts) =>
      guard(() => {
        for (const c of contacts)
          mapIdentity(
            c.lid ?? (c.id?.endsWith('@lid') ? c.id : undefined),
            c.jid ?? (c.id?.endsWith('@s.whatsapp.net') ? c.id : undefined),
          );
      }),
    );
  currentSocket.ev.on('messages.upsert', (update) =>
    guard(() => {
      // No history imports or placeholder-resend injections. Only live notify events.
      if (update.type !== 'notify' || update.requestId || currentSocket !== socket) return;
      for (const message of update.messages) incoming(message);
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
        openedAt = Date.now();
        persistCreds();
        if (!canonicalJid(currentSocket.user?.id)) {
          fail('INVALID_ACCOUNT_IDENTITY');
          return;
        }
        store.set('protocol', 'last-good:6.7.22', version);
        setStatus('connected');
      }
      if (update.connection === 'close') {
        pairing = {};
        const code =
          (update.lastDisconnect?.error as { output?: { statusCode?: number } })?.output
            ?.statusCode ?? 0;
        const policy = disconnectPolicy(code);
        if (policy === 'logout') {
          store.clear('auth');
          setStatus('logged_out', 'LOGGED_OUT');
          return;
        }
        if (policy === 'stop') {
          setStatus('error', `DISCONNECT_${code}`);
          return;
        }
        if (openedAt && Date.now() - openedAt > 120000) retries = 0;
        openedAt = 0;
        if (++retries > 5) {
          setStatus('error', 'RECONNECT_EXHAUSTED');
          return;
        }
        setStatus('reconnecting', `DISCONNECT_${code}`);
        reconnectTimer = setTimeout(() => guard(connect), retryDelay(retries));
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
  return sendOnce(
    store,
    body,
    messageId,
    async () =>
      (await socket!.sendMessage(body.peer, { text: body.text }, { messageId }))?.key.id ?? '',
  );
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
    stopped = true;
    clearTimeout(reconnectTimer);
    pairing = {};
    // Closing is not logging out: planned restarts must retain credentials.
    socket?.end(new Error('STOPPED'));
    process.exit(0);
  }
});
setInterval(
  () =>
    guard(async () => {
      if (!store || stopped) return;
      if (status === 'connected') setStatus('connected');
      await drain();
    }),
  15000,
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
