import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  sessionCommandSchema,
  sendCommandSchema,
  type WhatsAppConnection,
} from '../../src/shared/whatsapp.js';
import { Store } from './store.js';
import type { GatewayConfig } from './config.js';
import { signedHeaders } from '../../server/whatsapp/signing.js';
import { retryDelay } from './policy.js';

type Session = {
  connectionId: string;
  generation: number;
  status: WhatsAppConnection['status'];
  method?: 'qr' | 'code';
  phone?: string;
  crashes: number;
  errorCode?: string;
};
type Snapshot = Pick<Session, 'connectionId' | 'generation' | 'status' | 'errorCode'> & {
  qr?: string;
  code?: string;
  expiresAt?: string;
};
export class GatewayError extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(code);
  }
}
export class Supervisor {
  private children = new Map<string, ChildProcess>();
  private snapshots = new Map<string, Snapshot>();
  private pending = new Map<
    string,
    {
      connectionId: string;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private operations = new Set<string>();
  private restartTimers = new Set<ReturnType<typeof setTimeout>>();
  private stopping = false;
  private readonly owner = randomUUID();
  private flushing = false;
  private timer: ReturnType<typeof setInterval>;
  readonly store: Store;
  constructor(
    private config: GatewayConfig,
    private workerUrl = new URL('./worker.js', import.meta.url),
  ) {
    this.store = new Store(join(config.dataDir, 'gateway.sqlite'), config.key);
    if (!this.store.lease(this.owner)) {
      this.store.close();
      throw new Error('Another gateway owns this data volume.');
    }
    this.timer = setInterval(() => {
      if (!this.store.lease(this.owner)) {
        this.log('GATEWAY_LEASE_LOST');
        void this.close();
        return;
      }
      void this.flushEvents().catch(() => this.log('EVENT_RETRY_FAILED'));
    }, 15000);
    this.timer.unref();
  }
  private log(code: string, connectionId?: string) {
    // Never log phone numbers, messages, QR codes, auth material or raw exceptions.
    console.info(
      JSON.stringify({
        event: code,
        ...(connectionId ? { connectionId } : {}),
        at: new Date().toISOString(),
      }),
    );
  }
  restore() {
    for (const { value: session } of this.store.list<Session>('sessions')) {
      if (['connected', 'connecting', 'reconnecting'].includes(session.status)) this.spawn(session);
      else if (session.status === 'awaiting_pairing')
        this.update({ ...session, status: 'error', errorCode: 'PAIRING_EXPIRED' });
    }
  }
  private update(session: Session) {
    this.store.set('sessions', session.connectionId, session);
  }
  private spawn(session: Session) {
    if (this.stopping || this.children.has(session.connectionId)) return;
    const child = fork(this.workerUrl, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'json',
      execArgv: ['--max-old-space-size=128', '--unhandled-rejections=strict'],
    });
    this.children.set(session.connectionId, child);
    this.snapshots.set(session.connectionId, {
      connectionId: session.connectionId,
      generation: session.generation,
      status: 'connecting',
    });
    child.on('error', () => {
      this.log('WORKER_PROCESS_ERROR', session.connectionId);
      child.kill();
    });
    child.on('message', (message: any) => {
      try {
        if (this.children.get(session.connectionId) !== child) return;
        if (message.type === 'snapshot') {
          if (
            message.snapshot.connectionId !== session.connectionId ||
            message.snapshot.generation !== session.generation
          )
            return;
          this.snapshots.set(session.connectionId, message.snapshot);
          const current = this.store.get<Session>('sessions', session.connectionId);
          if (current?.generation === session.generation)
            this.update({
              ...current,
              status: message.snapshot.status,
              errorCode: message.snapshot.errorCode,
            });
        }
        if (message.type === 'result') {
          const pending = this.pending.get(message.requestId);
          if (!pending || pending.connectionId !== session.connectionId) return;
          clearTimeout(pending.timer);
          this.pending.delete(message.requestId);
          if (message.errorCode) pending.reject(new GatewayError(message.errorCode));
          else pending.resolve(message.result);
        }
        if (message.type === 'fatal') this.log(message.errorCode, session.connectionId);
      } catch {
        this.log('SUPERVISOR_MESSAGE_FAILURE', session.connectionId);
        child.kill();
      }
    });
    child.on('exit', () => {
      if (this.children.get(session.connectionId) !== child) return;
      this.children.delete(session.connectionId);
      this.snapshots.delete(session.connectionId);
      for (const [id, pending] of this.pending)
        if (pending.connectionId === session.connectionId) {
          clearTimeout(pending.timer);
          pending.reject(new GatewayError('SEND_UNCERTAIN'));
          this.pending.delete(id);
        }
      if (this.stopping) return;
      const current = this.store.get<Session>('sessions', session.connectionId);
      if (
        !current ||
        current.generation !== session.generation ||
        ['disconnected', 'logged_out'].includes(current.status)
      )
        return;
      const next: Session = {
        ...current,
        crashes: current.crashes + 1,
        status: 'error',
        errorCode: 'SESSION_CRASH',
      };
      this.update(next);
      this.queueError(next);
      if (next.crashes <= 5) {
        const timer = setTimeout(() => {
          this.restartTimers.delete(timer);
          const latest = this.store.get<Session>('sessions', next.connectionId);
          if (
            latest?.generation === next.generation &&
            latest.status === 'error' &&
            latest.errorCode === 'SESSION_CRASH'
          )
            this.spawn(latest);
        }, retryDelay(next.crashes));
        this.restartTimers.add(timer);
      }
    });
    child.send({
      type: 'init',
      connectionId: session.connectionId,
      generation: session.generation,
      method: session.method,
      phone: session.phone,
    });
  }
  private queueError(session: Session) {
    this.store.set('events', session.connectionId, {
      eventId: randomUUID(),
      connectionId: session.connectionId,
      generation: session.generation,
      type: 'status',
      status: 'error',
      errorCode: session.errorCode,
      timestamp: new Date().toISOString(),
    });
  }
  async flushEvents() {
    if (this.flushing || this.stopping) return;
    this.flushing = true;
    try {
      for (const row of this.store.list<any>('events')) {
        const raw = JSON.stringify(row.value);
        try {
          const response = await fetch(this.config.eventsUrl, {
            method: 'POST',
            headers: signedHeaders(
              this.config.secret,
              'event',
              '/api/whatsapp/gateway/events',
              raw,
            ),
            body: raw,
            redirect: 'error',
            signal: AbortSignal.timeout(10000),
          });
          if (response.ok && this.store.get<any>('events', row.id)?.eventId === row.value.eventId)
            this.store.delete('events', row.id);
        } catch {
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }
  async stopChild(id: string) {
    const child = this.children.get(id);
    if (!child) return;
    this.children.delete(id);
    this.snapshots.delete(id);
    for (const [key, pending] of this.pending)
      if (pending.connectionId === id) {
        clearTimeout(pending.timer);
        pending.reject(new GatewayError('SEND_UNCERTAIN'));
        this.pending.delete(key);
      }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      if (child.connected) child.send({ type: 'stop' });
      else child.kill();
    });
  }
  async command(input: unknown) {
    if (this.stopping) throw new GatewayError('GATEWAY_STOPPING', 503);
    const body = sessionCommandSchema.parse(input);
    if (this.operations.has(body.connectionId)) throw new GatewayError('CONNECTION_BUSY');
    this.operations.add(body.connectionId);
    try {
      const current = this.store.get<Session>('sessions', body.connectionId);
      if (current && body.generation < current.generation)
        throw new GatewayError('STALE_GENERATION');
      if (body.action === 'pair' && body.method === 'code' && !body.phone)
        throw new GatewayError('PHONE_REQUIRED', 400);
      if (body.action === 'pair' && current?.generation === body.generation)
        return this.status(body);
      if (
        body.action !== 'disconnect' &&
        !this.children.has(body.connectionId) &&
        this.children.size >= this.config.maxSessions
      )
        throw new GatewayError('SESSION_CAPACITY_REACHED', 503);
      if (
        body.action === 'reconnect' &&
        (!current ||
          current.generation !== body.generation ||
          ['disconnected', 'logged_out'].includes(current.status))
      )
        throw new GatewayError('PAIRING_REQUIRED');
      const next: Session = {
        connectionId: body.connectionId,
        generation: body.generation,
        status: body.action === 'disconnect' ? 'disconnected' : 'connecting',
        method: body.method ?? current?.method,
        phone: body.phone ?? current?.phone,
        crashes: 0,
      };
      // Persist fence BEFORE closing the old worker, including after a crash.
      this.update(next);
      await this.stopChild(body.connectionId);
      if (body.action === 'pair' || body.action === 'disconnect') {
        const sessionStore = new Store(
          join(this.config.dataDir, `${body.connectionId}.sqlite`),
          this.config.key,
        );
        for (const namespace of [
          'auth',
          'events',
          'status-event',
          'identity',
          'route',
          'seen',
          'own',
          'receipts',
        ])
          sessionStore.clear(namespace);
        sessionStore.close();
      }
      if (body.action !== 'disconnect') this.spawn(next);
      return this.status(body);
    } finally {
      this.operations.delete(body.connectionId);
    }
  }
  status(input: unknown): Snapshot {
    const body = z
      .object({ connectionId: z.string().uuid(), generation: z.number().int().positive() })
      .parse(input);
    const session = this.store.get<Session>('sessions', body.connectionId);
    if (!session || session.generation !== body.generation)
      throw new GatewayError('STALE_GENERATION');
    const live = this.snapshots.get(body.connectionId);
    if (live) {
      if (live.expiresAt && Date.parse(live.expiresAt) <= Date.now())
        return {
          connectionId: live.connectionId,
          generation: live.generation,
          status: live.status,
          errorCode: 'PAIRING_EXPIRED',
        };
      return live;
    }
    return {
      connectionId: session.connectionId,
      generation: session.generation,
      status: session.status,
      errorCode: session.errorCode,
    };
  }
  async send(input: unknown) {
    if (this.stopping) throw new GatewayError('GATEWAY_STOPPING', 503);
    const body = sendCommandSchema.parse(input);
    const current = this.status({ connectionId: body.connectionId, generation: body.generation });
    if (this.operations.has(body.connectionId)) throw new GatewayError('CONNECTION_BUSY');
    const child = this.children.get(body.connectionId);
    if (!child || current.status !== 'connected') throw new GatewayError('NOT_CONNECTED');
    if (this.pending.size >= 20) throw new GatewayError('SEND_QUEUE_FULL', 503);
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new GatewayError('SEND_UNCERTAIN'));
      }, 18000);
      this.pending.set(requestId, { connectionId: body.connectionId, resolve, reject, timer });
      child.send({ type: 'send', requestId, body }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(requestId);
          reject(new GatewayError('SEND_UNCERTAIN'));
        }
      });
    });
  }
  health() {
    return { ok: !this.stopping, workers: this.children.size, capacity: this.config.maxSessions };
  }
  async close() {
    if (this.stopping) return;
    this.stopping = true;
    clearInterval(this.timer);
    for (const timer of this.restartTimers) clearTimeout(timer);
    await Promise.all([...this.children.keys()].map((id) => this.stopChild(id)));
    this.store.releaseLease(this.owner);
    this.store.close();
  }
}
