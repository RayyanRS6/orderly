import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../management';
import type { Repository } from '../repository';
import type { Company } from '../../src/shared/types';
import { GATEWAY_HEARTBEAT_STALE_MS, type WhatsAppConnection } from '../../src/shared/whatsapp';
import { PublicError } from '../security';
import { gatewayAvailable, gatewayRequest, gatewaySnapshotSchema } from './client';
import {
  LINKED_DEVICE_CONSENT_VERSION,
  disconnectGateway,
  selectMeta,
  startPairing,
  withConnectionLock,
} from './connections';

// A new linked-phone pairing needs the Orderly admin's approval for this business. A business
// from before approvals existed whose linked phone is still in use (connected, connecting,
// reconnecting or waiting for its pairing to finish) may pair it again; one that disconnected,
// was logged out or failed needs approval like any other. The admin's revoke always wins. Every
// other action on an existing connection (status, reconnect, disconnect, switch to Meta) stays
// open, so a revoked business keeps its current session until it ends; only reconnecting a
// pairing nobody finished counts as pairing (reconnectAllowed).
const GRANDFATHERED_STATUSES: WhatsAppConnection['status'][] = [
  'connected',
  'connecting',
  'reconnecting',
  'awaiting_pairing',
];
export const pairingAllowed = (company: Company, connection?: WhatsAppConnection) =>
  company.linkedDeviceAllowed === true ||
  (company.linkedDeviceAllowed !== false &&
    connection?.provider === 'baileys' &&
    GRANDFATHERED_STATUSES.includes(connection.status));
// Reconnecting resumes a linked phone that finished pairing. A pairing nobody finished would
// start again (a new QR code), so it needs what a new pairing needs: an expired one always goes
// through Start pairing (approval, consent, rate limit), and any other unfinished one needs the
// approval (or, from before approvals, a phone still in use).
export const reconnectAllowed = (company: Company, connection?: WhatsAppConnection) =>
  connection?.provider === 'baileys' &&
  !['logged_out', 'disconnected'].includes(connection.status) &&
  connection.errorCode !== 'PAIRING_EXPIRED' &&
  (!!connection.accountJid || pairingAllowed(company, connection));

export function whatsappRoutes(repo: Repository) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    if (c.get('role') === 'staff')
      throw new PublicError('Only an owner can manage WhatsApp connections.', 403);
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/connection', async (c) => {
    const connection = await repo.getWhatsAppConnection(c.get('company').id);
    const allowed = pairingAllowed(c.get('company'), connection);
    const linked = connection?.provider === 'baileys' && connection.status !== 'disconnected';
    return c.json({
      // Dashboards from before the approval show the linked-phone controls only when true.
      enabled: gatewayAvailable() && allowed,
      gatewayEnabled: gatewayAvailable(),
      pairingAllowed: allowed,
      // Start a new pairing (the method, consent and Start pairing controls).
      canPair: gatewayAvailable() && allowed,
      // An existing linked phone the owner may still check and disconnect, approved or not (a
      // revoke ends no session). Its status is read from the gateway only when gatewayEnabled.
      canManage: linked,
      // Reconnect is offered (and POST /reconnect accepted).
      canReconnect: gatewayAvailable() && reconnectAllowed(c.get('company'), connection),
      consentVersion: LINKED_DEVICE_CONSENT_VERSION,
      connection: connection ?? null,
    });
  });
  app.post('/pair', async (c) => {
    const body = z
      .object({
        method: z.enum(['qr', 'code']),
        phone: z
          .string()
          .regex(/^[1-9]\d{5,14}$/)
          .optional(),
        riskAccepted: z.literal(true),
        switchConfirmed: z.literal(true),
        consent: z
          .object({ version: z.string().max(80), accepted: z.literal(true) })
          .strict()
          .optional(),
      })
      .strict()
      .parse(await c.req.json());
    // Approval first: a business without it is told so, whichever page it has open.
    const company = c.get('company');
    if (!pairingAllowed(company, await repo.getWhatsAppConnection(company.id)))
      throw new PublicError(
        'Linked-phone pairing needs approval from Orderly support. Use the official WhatsApp Business Platform instead.',
        403,
      );
    // A page open from before the current risk notice must show it before pairing.
    if (body.consent?.version !== LINKED_DEVICE_CONSENT_VERSION)
      throw new PublicError('Please reload the page to continue.', 400);
    if (body.method === 'code' && !body.phone)
      throw new PublicError('Enter your number including country code.', 400);
    if (!(await repo.consumeRateLimit(`wa-pair:${company.id}`, 3)))
      throw new PublicError('Too many pairing attempts. Wait a minute.', 429);
    const consent = {
      userId: c.get('userId'),
      at: new Date().toISOString(),
      version: LINKED_DEVICE_CONSENT_VERSION,
    };
    // Recorded before pairing starts: the owner accepted the notice whatever happens next.
    await repo.audit(
      company.id,
      consent.userId,
      `whatsapp.linked_risk_accepted ${consent.version}`,
    );
    return c.json(await startPairing(repo, company.id, body.method, body.phone, consent));
  });
  app.post('/pairing-status', async (c) => {
    const companyId = c.get('company').id;
    // The dashboard asks every 5 seconds while this page is open, in every open tab.
    if (!(await repo.consumeRateLimit(`wa-status:${companyId}`, 40))) {
      c.header('Retry-After', '60');
      throw new PublicError('Too many connection status checks. Wait a minute.', 429);
    }
    const current = await repo.getWhatsAppConnection(companyId);
    if (!current || current.provider !== 'baileys')
      throw new PublicError('No linked-device connection.', 409);
    // A connected phone that reported recently needs no question to the gateway: nothing is
    // being paired, and its heartbeats already keep the stored status current.
    if (
      current.status === 'connected' &&
      !!current.lastHeartbeatAt &&
      Date.now() - Date.parse(current.lastHeartbeatAt) < GATEWAY_HEARTBEAT_STALE_MS
    )
      return c.json({
        connection: current,
        snapshot: gatewaySnapshotSchema.parse({
          connectionId: current.id,
          generation: current.generation,
          status: current.status,
          ...(current.errorCode && { errorCode: current.errorCode }),
        }),
      });
    const snapshot = gatewaySnapshotSchema.parse(
      await gatewayRequest('/status', { connectionId: current.id, generation: current.generation }),
    );
    return c.json({ connection: current, snapshot });
  });
  app.post('/reconnect', async (c) => {
    const company = c.get('company');
    if (!(await repo.consumeRateLimit(`wa-reconnect:${company.id}`, 6)))
      throw new PublicError('Too many reconnect attempts. Wait a minute.', 429);
    return c.json(
      await withConnectionLock(repo, company.id, async () => {
        const current = await repo.getWhatsAppConnection(company.id);
        if (!current || !reconnectAllowed(company, current))
          throw new PublicError('Start a new pairing first.', 409);
        return gatewaySnapshotSchema.parse(
          await gatewayRequest('/session', {
            connectionId: current.id,
            generation: current.generation,
            action: 'reconnect',
          }),
        );
      }),
    );
  });
  // gatewayCleanupPending: the switch is saved, but the old session could not be ended on the
  // gateway; the owner should remove Orderly under WhatsApp → Linked devices on the phone.
  app.post('/disconnect', async (c) => {
    z.object({ confirmed: z.literal(true) }).parse(await c.req.json());
    const { gatewayCleanupPending } = await disconnectGateway(repo, c.get('company').id);
    return c.json({ ok: true, ...(gatewayCleanupPending && { gatewayCleanupPending }) });
  });
  app.post('/select-meta', async (c) => {
    z.object({ confirmed: z.literal(true) }).parse(await c.req.json());
    const result = await selectMeta(repo, c.get('company').id);
    if (!result) return c.json({ connection: null });
    const { gatewayCleanupPending, ...connection } = result;
    return c.json({ connection, ...(gatewayCleanupPending && { gatewayCleanupPending }) });
  });
  return app;
}
