import { createHash, randomUUID } from 'node:crypto';
import type { Repository } from '../repository';
import type { Conversation } from '../../src/shared/types';
import {
  addressSchema,
  connectionMatches,
  customerKeys,
  type WhatsAppConnection,
  type WhatsAppAddress,
  type GatewayEvent,
} from '../../src/shared/whatsapp';
import { z } from 'zod';
import { PublicError } from '../security';
import { workerLeaseMs } from '../config';
import { gatewayAvailable, gatewayRequest, gatewaySnapshotSchema } from './client';
import { MEDIA_HANDOFF_TEXT } from './inbound';
import { dispatchJob, makeJob } from '../jobs';

/** The linked-phone risk notice an owner accepts before pairing. Raise it when the text changes. */
export const LINKED_DEVICE_CONSENT_VERSION = 'linked-device-risk-2026-10-18';
/** Who accepted the linked-phone risk notice for this pairing, and which version of it. */
export type LinkedDeviceConsent = { userId: string; at: string; version: string };
// A connection as stored, with the consent its pairing was made under. downSince: when a linked
// phone stopped being connected (cleared once it is again), for staff alerts. Every reconnect
// attempt refreshes updatedAt and lastHeartbeatAt, so neither shows how long it has been down.
type StoredConnection = WhatsAppConnection & {
  linkedDeviceConsent?: LinkedDeviceConsent;
  downSince?: string;
};
// Older gateways may answer /health without these fields; the gateway still refuses itself.
const gatewayHealthSchema = z.object({
  ok: z.boolean(),
  workers: z.number().int().min(0),
  capacity: z.number().int().min(0),
});

export async function withConnectionLock<T>(
  repo: Repository,
  companyId: string,
  work: () => Promise<T>,
): Promise<T> {
  const lock = randomUUID();
  if (
    !(await repo.acquireConversationLock(
      companyId,
      'whatsapp-connection',
      lock,
      // A worker stopped mid-operation (Supabase Free ends functions after 150 s) frees the
      // line after one worker lease, not eight minutes later.
      new Date(Date.now() + workerLeaseMs()).toISOString(),
    ))
  )
    throw new PublicError('WhatsApp is processing another operation. Try again shortly.', 409);
  try {
    return await work();
  } finally {
    await repo.releaseConversationLock(companyId, 'whatsapp-connection', lock);
  }
}
export async function saveConnection<T extends WhatsAppConnection>(
  repo: Repository,
  value: T,
): Promise<T> {
  const next = { ...value, revision: value.revision + 1, updatedAt: new Date().toISOString() };
  if (!(await repo.saveWhatsAppConnection(next, value.revision)))
    throw new PublicError('WhatsApp connection changed. Refresh and retry.', 409);
  return next;
}
export function jobAddress(conversation: Conversation): Record<string, unknown> {
  return conversation.whatsappAddress ? { whatsappAddress: conversation.whatsappAddress } : {};
}
export async function assertCurrentAddress(
  repo: Repository,
  companyId: string,
  value: unknown,
): Promise<WhatsAppAddress | undefined> {
  const connection = await repo.getWhatsAppConnection(companyId);
  if (!value) {
    if (connection)
      throw new PublicError(
        'This message belongs to a previous WhatsApp connection. It will not be sent.',
        422,
      );
    return;
  }
  const address = addressSchema.parse(value);
  if (!connectionMatches(connection, address))
    throw new PublicError(
      'This message belongs to a previous WhatsApp connection. It will not be sent.',
      422,
    );
  return address;
}
export async function requireMeta(repo: Repository, companyId: string) {
  const connection = await repo.getWhatsAppConnection(companyId);
  if (connection && (connection.provider !== 'meta' || connection.status === 'disconnected'))
    throw new PublicError('Select the official Meta route in WhatsApp connections first.', 409);
}
// Called while the connection lock is held, before replacing official credentials.
export async function metaConfigurationBoundary(
  repo: Repository,
  companyId: string,
  nextNumberId: string,
) {
  const previous = (await repo.getIntegrations(companyId)).find((i) => i.kind === 'whatsapp');
  const current = await repo.getWhatsAppConnection(companyId);
  if (!current && previous?.config.phoneNumberId === nextNumberId) return;
  if (current && previous?.config.phoneNumberId === nextNumberId) {
    await saveConnection(repo, { ...current, status: 'connected' });
    return;
  }
  await saveConnection(repo, {
    id: current?.id ?? randomUUID(),
    companyId,
    provider: 'meta',
    generation: (current?.generation ?? 0) + 1,
    revision: current?.revision ?? 0,
    status: 'connected',
    updatedAt: new Date().toISOString(),
  });
}
/** A route change already saved, whose old gateway session may still be running. */
export type SwitchResult = StoredConnection & { gatewayCleanupPending?: true };
// Ends the gateway session of a connection Orderly no longer uses. Best effort: the database
// already fences it (its events are dropped and its sends refused), so a gateway that is down
// or switched off never stops a business going back to its official route. False when the
// session may still run on the gateway, linked to the phone: its next event or heartbeat is then
// answered 410 (see retiredSession) and the gateway ends it itself once it is reachable.
async function releaseGatewaySession(connection: WhatsAppConnection): Promise<boolean> {
  if (!gatewayAvailable()) return false;
  try {
    await gatewayRequest('/session', {
      connectionId: connection.id,
      generation: connection.generation,
      action: 'disconnect',
    });
    return true;
  } catch {
    console.warn('Orderly: a linked-phone session could not be ended on the gateway.');
    return false;
  }
}
// Saves a change to a pairing attempt that failed, unless the connection has moved on since.
// A gateway status event can change the revision meanwhile, so it reads again and retries
// once. Never throws: the reason pairing failed is what the owner must see.
async function settleAttempt(
  repo: Repository,
  attempt: StoredConnection,
  change: (latest: StoredConnection) => StoredConnection,
): Promise<StoredConnection | undefined> {
  for (let tries = 0; tries < 2; tries++)
    try {
      const latest: StoredConnection | undefined = await repo.getWhatsAppConnection(
        attempt.companyId,
      );
      if (
        latest?.id !== attempt.id ||
        latest.generation !== attempt.generation ||
        latest.provider !== 'baileys'
      )
        return;
      return await saveConnection(repo, change(latest));
    } catch {
      /* Read again and retry once. */
    }
  console.warn('Orderly: a failed linked-phone pairing could not be settled.');
}
export async function startPairing(
  repo: Repository,
  companyId: string,
  method: 'qr' | 'code',
  phone?: string,
  consent?: LinkedDeviceConsent,
) {
  // Health check before pausing a working provider. No tenant credentials in the check.
  const health = gatewayHealthSchema.safeParse(await gatewayRequest('/health', {}));
  return withConnectionLock(repo, companyId, async () => {
    const current = await repo.getWhatsAppConnection(companyId);
    const company = await repo.getCompany(companyId);
    if (!company) throw new PublicError('Company not found.', 404);
    // Refused before anything changes: pausing replies and leaving a working official route
    // for a pairing that cannot start would lose the customers' messages.
    if (health.success && !health.data.ok)
      throw new PublicError(
        'The linked-phone service is restarting. Nothing was changed. Try again in a few minutes.',
        503,
      );
    if (
      health.success &&
      current?.provider !== 'baileys' &&
      health.data.workers >= health.data.capacity
    )
      throw new PublicError(
        'The linked-phone service has no free place right now. Nothing was changed. Contact Orderly support.',
        503,
      );
    const meta = (await repo.getIntegrations(companyId)).find((i) => i.kind === 'whatsapp');
    // The official route to go back to if pairing cannot start.
    const official = current
      ? current.provider === 'meta' && !['disconnected', 'logged_out'].includes(current.status)
      : !!meta?.config.phoneNumberId;
    await repo.saveCompany({ ...company, botEnabled: false });
    const attempt: StoredConnection = {
      id: current?.id ?? randomUUID(),
      companyId,
      generation: (current?.generation ?? 0) + 1,
      revision: current?.revision ?? 0,
      provider: 'baileys',
      status: 'connecting',
      pairingMethod: method,
      ...(consent && { linkedDeviceConsent: consent }),
      updatedAt: new Date().toISOString(),
    };
    const next = await saveConnection(repo, attempt);
    try {
      const snapshot = gatewaySnapshotSchema.parse(
        await gatewayRequest('/session', {
          connectionId: next.id,
          generation: next.generation,
          action: 'pair',
          method,
          ...(phone ? { phone } : {}),
        }),
      );
      return { connection: next, snapshot };
    } catch (error) {
      if (!official) {
        // A re-pair of a linked phone stays as failed: the gateway may already have ended
        // the old session, so calling it connected would be untrue.
        await settleAttempt(repo, next, (latest) => ({
          ...latest,
          status: 'error',
          errorCode: 'GATEWAY_START_FAILED',
        }));
        throw error;
      }
      // Back to the official route, at a new generation the gateway has never seen, so
      // Meta messages are received again and automation is as the owner left it.
      const restored = await settleAttempt(repo, next, (latest) => ({
        ...latest,
        provider: 'meta',
        generation: latest.generation + 1,
        status: meta?.status === 'connected' ? 'connected' : 'connecting',
        pairingMethod: undefined,
        errorCode: undefined,
        accountJid: undefined,
        phoneNumber: undefined,
        pushName: undefined,
        lastHeartbeatAt: undefined,
        linkedDeviceConsent: undefined,
      }));
      if (restored) {
        // After a timeout the gateway may have started the session anyway, holding a place.
        await releaseGatewaySession(restored);
        const latest = await repo.getCompany(companyId);
        if (latest && company.botEnabled) await repo.saveCompany({ ...latest, botEnabled: true });
      }
      throw error;
    }
  });
}
export async function disconnectGateway(repo: Repository, companyId: string) {
  return withConnectionLock(repo, companyId, async (): Promise<SwitchResult> => {
    const current: StoredConnection | undefined = await repo.getWhatsAppConnection(companyId);
    const company = await repo.getCompany(companyId);
    if (company) await repo.saveCompany({ ...company, botEnabled: false });
    if (!current) {
      // Keep a tombstone even for a legacy Meta disconnect. Removing credentials
      // alone must not let old unbound jobs use a subsequently connected number.
      return saveConnection(repo, {
        id: randomUUID(),
        companyId,
        provider: 'meta',
        generation: 1,
        revision: 0,
        status: 'disconnected',
        updatedAt: new Date().toISOString(),
      });
    }
    // Saved first, so the disconnect holds even when the gateway cannot be reached.
    const next = await saveConnection(repo, {
      ...current,
      generation: current.generation + 1,
      status: 'disconnected',
      accountJid: undefined,
      phoneNumber: undefined,
      lastHeartbeatAt: undefined,
    });
    if (current.provider === 'baileys' && !(await releaseGatewaySession(next)))
      return { ...next, gatewayCleanupPending: true };
    return next;
  });
}
export async function selectMeta(repo: Repository, companyId: string) {
  return withConnectionLock(repo, companyId, async (): Promise<SwitchResult | undefined> => {
    const current: StoredConnection | undefined = await repo.getWhatsAppConnection(companyId);
    if (!current) return; // Legacy official integration needs no migration of conversations.
    if (current.provider === 'meta' && current.status !== 'disconnected') return current;
    const company = await repo.getCompany(companyId);
    if (company) await repo.saveCompany({ ...company, botEnabled: false });
    const meta = (await repo.getIntegrations(companyId)).find((i) => i.kind === 'whatsapp');
    // The official route is saved first, in one step, so going back to it never depends on
    // the linked-phone gateway being up.
    const next = await saveConnection(repo, {
      ...current,
      provider: 'meta',
      generation: current.generation + 1,
      status: meta?.status === 'connected' ? 'connected' : 'connecting',
      accountJid: undefined,
      phoneNumber: undefined,
      lastHeartbeatAt: undefined,
      errorCode: undefined,
      linkedDeviceConsent: undefined,
    });
    if (current.provider === 'baileys' && !(await releaseGatewaySession(next)))
      return { ...next, gatewayCleanupPending: true };
    return next;
  });
}
// A linked-phone session Orderly no longer uses: after its generation the business moved to
// another route or disconnected, maybe while the gateway could not be told. Its events are
// answered 410, and the gateway then ends it as a disconnect would (logs the device out, wipes
// it). Never while a newer linked-phone pairing may be starting, nor for an unknown connection.
function retiredSession(current: StoredConnection | undefined, event: GatewayEvent): boolean {
  return (
    !!current &&
    event.generation < current.generation &&
    (current.provider !== 'baileys' || ['disconnected', 'logged_out'].includes(current.status))
  );
}
// The gateway's notice for a customer message whose content never reached the linked device:
// its message ID is the original's with this suffix (see gateway/src/inbound.ts), so the real
// message still gets through if it arrives later.
const UNREAD_SUFFIX = ':unread';
function eventText(event: GatewayEvent): string {
  if (event.text) return event.text;
  if (event.fromMe) return 'Staff sent a media message in WhatsApp.';
  if (event.unsupported && event.messageId?.endsWith(UNREAD_SUFFIX))
    return 'Customer sent a message Orderly could not read on the linked phone. Check the restaurant phone. Staff assistance requested.';
  return MEDIA_HANDOFF_TEXT;
}
export async function receiveGatewayEvent(repo: Repository, event: GatewayEvent) {
  if (Date.parse(event.timestamp) > Date.now() + 60000)
    throw new PublicError('Gateway timestamp is in the future.', 400);
  const current: StoredConnection | undefined = await repo.findWhatsAppConnection(
    event.connectionId,
  );
  // A connection of a deleted business (delete_company keeps its id) is ended as a retired one.
  // Any other unknown connection is dropped quietly: it is not proof enough that Orderly is done
  // with it.
  if (
    retiredSession(current, event) ||
    (!current && (await repo.isDeletedConnection(event.connectionId)))
  )
    throw new PublicError('Orderly no longer uses this linked-phone session.', 410);
  if (
    !current ||
    current.provider !== 'baileys' ||
    current.generation !== event.generation ||
    ['disconnected', 'logged_out'].includes(current.status)
  )
    return;
  if (event.type === 'status') {
    // CAS protects pairing/switch operations. Stale status retries cannot revive old generations.
    if (current.lastHeartbeatAt && event.timestamp < current.lastHeartbeatAt) return;
    if (event.status === 'connected' && !event.accountJid)
      throw new PublicError('Connected event must identify the verified account.', 400);
    if (event.accountJid && current.accountJid && event.accountJid !== current.accountJid)
      throw new PublicError('Account identity changed without new pairing.', 409);
    const status = event.status ?? current.status;
    await saveConnection(repo, {
      ...current,
      status,
      lastHeartbeatAt: event.timestamp,
      accountJid: event.accountJid ?? current.accountJid,
      phoneNumber: event.phoneNumber ?? current.phoneNumber,
      pushName: event.pushName ?? current.pushName,
      errorCode: event.errorCode,
      downSince: status === 'connected' ? undefined : (current.downSince ?? event.timestamp),
    });
    return;
  }
  if (event.type === 'receipt') {
    if (!event.messageId || !event.receipt) throw new PublicError('Invalid receipt event.', 400);
    // Keyed by the WhatsApp message ID the send job saved; arrival order does not matter.
    await repo.recordDelivery(current.companyId, event.messageId, event.receipt);
    return;
  }
  if (!event.peer || !event.messageId || Date.parse(event.timestamp) > Date.now() + 60000)
    throw new PublicError('Invalid message event.', 400);
  const address: WhatsAppAddress = {
    connectionId: current.id,
    generation: current.generation,
    provider: 'baileys',
    peer: event.peer,
  };
  const phone =
    event.phoneNumber ??
    (event.peer.endsWith('@s.whatsapp.net') ? `+${event.peer.split('@')[0]}` : '');
  // A blocked number's message is dropped before anything is saved. Answering normally lets
  // the gateway remove it from its queue; staff messages from the phone are never blocked.
  if (
    !event.fromMe &&
    (await repo.findBlockedCustomer(
      current.companyId,
      customerKeys({ phone: event.phoneNumber ?? phone, peer: event.peer }),
    ))
  )
    return;
  const dedupeKey = `baileys:${current.id}:${current.generation}:${event.messageId}:${event.peer}`;
  const job = makeJob(
    current.companyId,
    'incoming',
    {
      phone,
      whatsappAddress: address,
      messageId: event.messageId,
      text: eventText(event),
      echo: event.fromMe ?? false,
      ...(!event.fromMe && event.unsupported ? { action: { type: 'handoff' } } : {}),
    },
    `gateway-${createHash('sha256').update(dedupeKey).digest('hex')}`,
  );
  job.createdAt = event.timestamp;
  // Existing queue stream key includes the native identity, not an unknown phone.
  job.payload.streamKey = `${current.id}:${current.generation}:${event.peer}`;
  const inserted = await repo.insertJob(job, dedupeKey);
  if (!inserted && (await repo.getJob(job.id))?.status === 'done') return;
  // A phone reply interrupts even a model call already in flight. Advancing the
  // version makes its stale turn fail atomically. Replayed completed echoes must
  // not pause a conversation staff explicitly resumed afterwards.
  if (event.fromMe) {
    const conversation = await repo.findWhatsAppConversation(current.companyId, address);
    // A staff message replayed after a reconnect may predate staff handing the chat back.
    const handedBackLater =
      !!conversation?.botResumedAt && event.timestamp < conversation.botResumedAt;
    if (
      !handedBackLater &&
      (conversation?.mode === 'bot' || conversation?.botPausedAt || conversation?.limitPause) &&
      !(await repo.saveConversation(
        {
          ...conversation,
          mode: 'human',
          botPausedAt: undefined,
          limitPause: undefined,
          version: conversation.version + 1,
          updatedAt: event.timestamp,
        },
        conversation.version,
      ))
    )
      throw new PublicError('Conversation changed during staff takeover. Retry event.', 409);
  }
  if (inserted) await dispatchJob(repo, job);
}
