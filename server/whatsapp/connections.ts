import { createHash, randomUUID } from 'node:crypto';
import type { Repository } from '../repository';
import type { Conversation } from '../../src/shared/types';
import {
  addressSchema,
  connectionMatches,
  type WhatsAppConnection,
  type WhatsAppAddress,
  type GatewayEvent,
} from '../../src/shared/whatsapp';
import { PublicError } from '../security';
import { gatewayRequest, gatewaySnapshotSchema } from './client';
import { dispatchJob, makeJob } from '../jobs';

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
      new Date(Date.now() + 480000).toISOString(),
    ))
  )
    throw new PublicError('WhatsApp is processing another operation. Try again shortly.', 409);
  try {
    return await work();
  } finally {
    await repo.releaseConversationLock(companyId, 'whatsapp-connection', lock);
  }
}
export async function saveConnection(repo: Repository, value: WhatsAppConnection) {
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
export async function startPairing(
  repo: Repository,
  companyId: string,
  method: 'qr' | 'code',
  phone?: string,
) {
  // Health check before pausing a working provider. No tenant credentials in the check.
  await gatewayRequest('/health', {});
  return withConnectionLock(repo, companyId, async () => {
    const current = await repo.getWhatsAppConnection(companyId);
    const company = await repo.getCompany(companyId);
    if (!company) throw new PublicError('Company not found.', 404);
    await repo.saveCompany({ ...company, botEnabled: false });
    let next = await saveConnection(repo, {
      id: current?.id ?? randomUUID(),
      companyId,
      generation: (current?.generation ?? 0) + 1,
      revision: current?.revision ?? 0,
      provider: 'baileys',
      status: 'connecting',
      pairingMethod: method,
      updatedAt: new Date().toISOString(),
    });
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
      next = await saveConnection(repo, {
        ...next,
        status: 'error',
        errorCode: 'GATEWAY_START_FAILED',
      });
      throw error;
    }
  });
}
export async function disconnectGateway(repo: Repository, companyId: string) {
  return withConnectionLock(repo, companyId, async () => {
    const current = await repo.getWhatsAppConnection(companyId);
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
    const next = await saveConnection(repo, {
      ...current,
      generation: current.generation + 1,
      status: 'disconnected',
      accountJid: undefined,
      phoneNumber: undefined,
      lastHeartbeatAt: undefined,
    });
    if (current.provider === 'baileys')
      await gatewayRequest('/session', {
        connectionId: next.id,
        generation: next.generation,
        action: 'disconnect',
      });
    return next;
  });
}
export async function selectMeta(repo: Repository, companyId: string) {
  return withConnectionLock(repo, companyId, async () => {
    const current = await repo.getWhatsAppConnection(companyId);
    if (!current) return; // Legacy official integration needs no migration of conversations.
    if (current.provider === 'meta' && current.status !== 'disconnected') return current;
    const company = await repo.getCompany(companyId);
    if (company) await repo.saveCompany({ ...company, botEnabled: false });
    let next = await saveConnection(repo, {
      ...current,
      generation: current.generation + 1,
      status: 'disconnected',
      accountJid: undefined,
      phoneNumber: undefined,
      lastHeartbeatAt: undefined,
    });
    if (current.provider === 'baileys')
      await gatewayRequest('/session', {
        connectionId: next.id,
        generation: next.generation,
        action: 'disconnect',
      });
    const meta = (await repo.getIntegrations(companyId)).find((i) => i.kind === 'whatsapp');
    next = await saveConnection(repo, {
      ...next,
      provider: 'meta',
      status: meta?.status === 'connected' ? 'connected' : 'connecting',
      errorCode: undefined,
    });
    return next;
  });
}
export async function receiveGatewayEvent(repo: Repository, event: GatewayEvent) {
  if (Date.parse(event.timestamp) > Date.now() + 60000)
    throw new PublicError('Gateway timestamp is in the future.', 400);
  const current = await repo.findWhatsAppConnection(event.connectionId);
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
    await saveConnection(repo, {
      ...current,
      status: event.status ?? current.status,
      lastHeartbeatAt: event.timestamp,
      accountJid: event.accountJid ?? current.accountJid,
      phoneNumber: event.phoneNumber ?? current.phoneNumber,
      pushName: event.pushName ?? current.pushName,
      errorCode: event.errorCode,
    });
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
  const dedupeKey = `baileys:${current.id}:${current.generation}:${event.messageId}:${event.peer}`;
  const job = makeJob(
    current.companyId,
    'incoming',
    {
      phone,
      whatsappAddress: address,
      messageId: event.messageId,
      text:
        event.text ||
        (event.fromMe
          ? 'Staff sent a media message in WhatsApp.'
          : 'Customer sent a media message. Staff assistance requested.'),
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
    if (
      conversation?.mode === 'bot' &&
      !(await repo.saveConversation(
        {
          ...conversation,
          mode: 'human',
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
